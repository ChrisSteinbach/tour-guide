// Radar view: a polar canvas visualization of nearby articles — the
// user at the center, articles as blips placed by great-circle bearing
// and distance, with range rings, a rotating sweep, and (on devices
// with a compass) heading-up rotation.
//
// All geometry lives in radar-math.ts; this module is the canvas/DOM
// adapter. Drawing is skipped when a 2D context is unavailable
// (jsdom), so interaction logic stays testable.

import { initialBearing } from "../geometry/index";
import { formatDistance } from "./format";
import {
  radarRange,
  blipOffset,
  hitTest,
  sweepTrailBoost,
  type RadarRange,
  type RadarBlip,
} from "./radar-math";
import { createCompassWatcher } from "./compass";
import type { NearbyArticle, PositionSource, UserPosition } from "./types";
import type { SpatialViewHandle } from "./lazy-view-lifecycle";

/** Most blips drawn at once; articles arrive nearest-first. */
const MAX_BLIPS = 80;
/** Full sweep rotation period in ms. */
const SWEEP_PERIOD_MS = 4000;
/** Trail length behind the sweep line, in degrees. */
const TRAIL_DEG = 120;
/** Padding between the outer ring and the canvas edge (CSS px). */
const EDGE_MARGIN = 30;
/** Touch-friendly blip hit radius (CSS px). */
const HIT_TOLERANCE = 22;
/** Time constant for heading smoothing (ms to cover ~63% of a turn). */
const HEADING_SMOOTHING_MS = 250;

const COLOR_BG_INNER = "#10203a";
const COLOR_BG_OUTER = "#0a1322";
const COLOR_RING = "rgba(104, 150, 255, 0.22)";
const COLOR_RING_LABEL = "rgba(168, 200, 255, 0.6)";
const COLOR_TICK = "rgba(168, 200, 255, 0.5)";
const COLOR_SWEEP = "26, 115, 232"; // app theme blue, rgb triplet
const COLOR_BLIP = "143, 184, 255";
const COLOR_BLIP_HOT = "230, 240, 255";
const COLOR_HIGHLIGHT = "#ffffff";
const COLOR_CENTER = "#7db2ff";
const COLOR_LABEL_TEXT = "#dce8ff";
const COLOR_LABEL_BG = "rgba(8, 16, 32, 0.85)";

interface Contact {
  article: NearbyArticle;
  bearingDeg: number;
}

export function createRadarView(
  el: HTMLElement,
  position: UserPosition,
  articles: NearbyArticle[],
  onSelect: (article: NearbyArticle) => void,
  initialSource: PositionSource = "gps",
): SpatialViewHandle {
  const canvas = document.createElement("canvas");
  canvas.className = "radar-canvas";
  canvas.setAttribute("role", "img");

  const empty = document.createElement("p");
  empty.className = "radar-empty";
  empty.textContent = "No articles in range";

  el.append(canvas, empty);

  const ctx = canvas.getContext("2d");

  // ── State ──
  let pos = position;
  let source: PositionSource = initialSource;
  let contacts: Contact[] = [];
  let range: RadarRange = radarRange(0);
  let highlightTitle: string | null = null;
  let hoverTitle: string | null = null;
  let sweepDeg = 0;
  let targetHeading: number | null = null;
  let displayedHeading: number | null = null;
  let destroyed = false;
  let rafId: number | null = null;
  let lastTs = 0;
  let needsRedraw = true;

  const reducedMotion =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const sweepEnabled = (): boolean => !(reducedMotion?.matches ?? false);

  // ── Compass ──
  const compass = createCompassWatcher({
    onHeading: (h) => {
      targetHeading = h;
      if (!sweepEnabled()) displayedHeading = h;
      schedule();
    },
  });

  // Heading-up rotation only makes sense when the radar is centered on
  // the device's physical location. For a map-picked position the
  // compass is ignored entirely: watcher stopped, permission button
  // hidden, display locked to north-up.
  let compassAllowed = !compass.needsPermission();

  let compassBtn: HTMLButtonElement | null = null;
  if (!compassAllowed) {
    compassBtn = document.createElement("button");
    compassBtn.type = "button";
    compassBtn.className = "radar-compass-btn";
    compassBtn.textContent = "Enable compass";
    compassBtn.addEventListener("click", () => {
      void compass.requestPermission().then((granted) => {
        if (granted && !destroyed) {
          compassAllowed = true;
          if (source === "gps") compass.start();
        }
        compassBtn?.remove();
        compassBtn = null;
      });
    });
    el.appendChild(compassBtn);
  }

  function applySource(next: PositionSource): void {
    source = next;
    if (source === "picked") {
      compass.stop();
      targetHeading = null;
      displayedHeading = null;
      if (compassBtn) compassBtn.hidden = true;
    } else {
      if (compassAllowed) compass.start();
      if (compassBtn) compassBtn.hidden = false;
    }
    markDirty();
  }

  // ── Layout ──

  function viewSize(): { w: number; h: number; radius: number } {
    const w = el.clientWidth;
    const h = el.clientHeight;
    return { w, h, radius: Math.max(0, Math.min(w, h) / 2 - EDGE_MARGIN) };
  }

  function computeBlips(): RadarBlip<NearbyArticle>[] {
    const { radius } = viewSize();
    const heading = displayedHeading ?? 0;
    return contacts.map((c) => {
      const { x, y } = blipOffset(
        c.bearingDeg,
        c.article.distanceM,
        heading,
        range.maxM,
        radius,
      );
      return { x, y, item: c.article };
    });
  }

  function syncCanvasSize(): void {
    const { w, h } = viewSize();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Animation loop ──
  // The loop runs continuously while the sweep is animating and the
  // document is visible; with reduced motion it fires only on demand.

  function schedule(): void {
    if (destroyed || rafId !== null || document.hidden) return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(ts: number): void {
    rafId = null;
    if (destroyed) return;
    const dt = lastTs ? Math.min(ts - lastTs, 100) : 16;
    lastTs = ts;

    let animating = false;
    if (sweepEnabled()) {
      sweepDeg = (sweepDeg + (dt * 360) / SWEEP_PERIOD_MS) % 360;
      animating = true;
    }
    if (targetHeading !== null && displayedHeading !== targetHeading) {
      const cur = displayedHeading;
      if (cur === null || !sweepEnabled()) {
        displayedHeading = targetHeading; // first fix / reduced motion: snap
      } else {
        const diff = ((targetHeading - cur + 540) % 360) - 180;
        if (Math.abs(diff) < 0.2) {
          displayedHeading = targetHeading;
        } else {
          const step = diff * Math.min(1, dt / HEADING_SMOOTHING_MS);
          displayedHeading = (cur + step + 360) % 360;
          animating = true;
        }
      }
    }

    draw();
    needsRedraw = false;
    if (animating || needsRedraw) schedule();
    else lastTs = 0;
  }

  function markDirty(): void {
    needsRedraw = true;
    schedule();
  }

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTs = 0;
    } else {
      schedule();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // ── Drawing ──

  function draw(): void {
    if (!ctx) return;
    const { w, h, radius } = viewSize();
    if (w === 0 || h === 0) return;
    const cx = w / 2;
    const cy = h / 2;
    const heading = displayedHeading ?? 0;

    // Background
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) / 2);
    bg.addColorStop(0, COLOR_BG_INNER);
    bg.addColorStop(1, COLOR_BG_OUTER);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Range rings (sqrt radial scale, matching blip placement)
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif";
    for (const ringM of range.rings) {
      const r = radius * Math.sqrt(ringM / range.maxM);
      ctx.strokeStyle = COLOR_RING;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();

      // Label along the NE diagonal
      const lx = cx + r * Math.SQRT1_2 + 3;
      const ly = cy - r * Math.SQRT1_2 - 3;
      ctx.fillStyle = COLOR_RING_LABEL;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(formatDistance(ringM), lx, ly);
    }

    // Cardinal markers, rotated so they show true directions
    for (const [bearing, letter] of [
      [0, "N"],
      [90, ""],
      [180, ""],
      [270, ""],
    ] as const) {
      const a = ((bearing - heading) * Math.PI) / 180;
      const tickInner = radius + 2;
      const tickOuter = radius + (letter ? 8 : 6);
      ctx.strokeStyle = COLOR_TICK;
      ctx.beginPath();
      ctx.moveTo(cx + tickInner * Math.sin(a), cy - tickInner * Math.cos(a));
      ctx.lineTo(cx + tickOuter * Math.sin(a), cy - tickOuter * Math.cos(a));
      ctx.stroke();
      if (letter) {
        const lr = radius + 17;
        ctx.fillStyle = COLOR_TICK;
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(letter, cx + lr * Math.sin(a), cy - lr * Math.cos(a));
        ctx.font = "11px system-ui, sans-serif";
      }
    }

    // Device-facing wedge (only meaningful once a compass heading exists)
    if (displayedHeading !== null) {
      ctx.fillStyle = `rgba(${COLOR_SWEEP}, 0.5)`;
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius - 1);
      ctx.lineTo(cx - 5, cy - radius - 9);
      ctx.lineTo(cx + 5, cy - radius - 9);
      ctx.closePath();
      ctx.fill();
    }

    // Sweep trail: thin wedges with an alpha ramp toward the sweep line
    if (sweepEnabled()) {
      const segments = 36;
      const segDeg = TRAIL_DEG / segments;
      for (let i = 0; i < segments; i++) {
        const lag = i * segDeg;
        const alpha = 0.28 * (1 - lag / TRAIL_DEG);
        const aEnd = ((sweepDeg - lag) * Math.PI) / 180 - Math.PI / 2;
        const aStart = aEnd - (segDeg * Math.PI) / 180;
        ctx.fillStyle = `rgba(${COLOR_SWEEP}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, aStart, aEnd);
        ctx.closePath();
        ctx.fill();
      }
      // Leading edge
      const aLead = ((sweepDeg - 90) * Math.PI) / 180;
      ctx.strokeStyle = `rgba(${COLOR_SWEEP}, 0.9)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * Math.cos(aLead), cy + radius * Math.sin(aLead));
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Blips
    const blips = computeBlips();
    let labelBlip: RadarBlip<NearbyArticle> | null = null;
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      const screenAngle = (Math.atan2(b.x, -b.y) * 180) / Math.PI; // bearing-like, 0 = up
      const boost = sweepEnabled()
        ? sweepTrailBoost(screenAngle, sweepDeg, TRAIL_DEG)
        : 1;
      const isHighlighted = b.item.title === highlightTitle;
      const isHovered = b.item.title === hoverTitle;
      const alpha = isHighlighted ? 1 : 0.45 + 0.55 * boost;
      const r = (isHighlighted || isHovered ? 5.5 : 3.5) + 1.5 * boost;

      ctx.save();
      ctx.shadowColor = `rgba(${COLOR_BLIP}, 0.9)`;
      ctx.shadowBlur = isHighlighted ? 14 : 8;
      ctx.fillStyle = isHighlighted
        ? COLOR_HIGHLIGHT
        : `rgba(${boost > 0.55 ? COLOR_BLIP_HOT : COLOR_BLIP}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cx + b.x, cy + b.y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      if (isHighlighted || (isHovered && !highlightTitle)) labelBlip = b;
    }

    // Title label for the highlighted/hovered blip
    if (labelBlip) {
      const title = labelBlip.item.title;
      ctx.font = "12px system-ui, sans-serif";
      const metrics = ctx.measureText(title);
      const tw = Math.min(metrics.width, w - 16);
      const pad = 6;
      let lx = cx + labelBlip.x - tw / 2;
      lx = Math.max(8, Math.min(lx, w - tw - 8));
      let ly = cy + labelBlip.y - 14;
      if (ly - 16 < 0) ly = cy + labelBlip.y + 26;
      ctx.fillStyle = COLOR_LABEL_BG;
      ctx.beginPath();
      ctx.roundRect(lx - pad, ly - 14, tw + pad * 2, 20, 6);
      ctx.fill();
      ctx.fillStyle = COLOR_LABEL_TEXT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(title, lx, ly - 3, w - 16);
    }

    // User at the center
    ctx.fillStyle = COLOR_CENTER;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = `rgba(${COLOR_BLIP}, 0.5)`;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // ── Interaction ──

  function blipAt(e: MouseEvent): NearbyArticle | null {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = viewSize();
    const x = e.clientX - rect.left - w / 2;
    const y = e.clientY - rect.top - h / 2;
    return hitTest(computeBlips(), x, y, HIT_TOLERANCE);
  }

  const onClick = (e: MouseEvent): void => {
    const hit = blipAt(e);
    if (hit) onSelect(hit);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const hit = blipAt(e);
    const title = hit?.title ?? null;
    if (title !== hoverTitle) {
      hoverTitle = title;
      canvas.style.cursor = hit ? "pointer" : "";
      markDirty();
    }
  };

  const onPointerLeave = (): void => {
    if (hoverTitle !== null) {
      hoverTitle = null;
      canvas.style.cursor = "";
      markDirty();
    }
  };

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          syncCanvasSize();
          markDirty();
        })
      : null;
  resizeObserver?.observe(el);

  // ── Data ──

  function applyData(
    newPosition: UserPosition,
    newArticles: NearbyArticle[],
  ): void {
    pos = newPosition;
    const capped = newArticles.slice(0, MAX_BLIPS);
    contacts = capped.map((article) => ({
      article,
      bearingDeg: initialBearing(pos, article),
    }));
    range = radarRange(capped.length ? capped[capped.length - 1].distanceM : 0);
    empty.hidden = contacts.length > 0;
    canvas.setAttribute(
      "aria-label",
      contacts.length
        ? `Radar showing ${contacts.length} nearby articles within ${formatDistance(range.maxM)}`
        : "Radar with no articles in range",
    );
    markDirty();
  }

  applySource(initialSource);
  applyData(position, articles);
  syncCanvasSize();
  schedule();

  return {
    update(newPosition, newArticles, newSource) {
      if (newSource !== source) applySource(newSource);
      applyData(newPosition, newArticles);
    },
    highlight(title) {
      if (title !== highlightTitle) {
        highlightTitle = title;
        markDirty();
      }
    },
    resize() {
      syncCanvasSize();
      markDirty();
    },
    destroy() {
      destroyed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      compass.stop();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.remove();
      empty.remove();
      compassBtn?.remove();
    },
  };
}
