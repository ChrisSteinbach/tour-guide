// X-ray overlay: a Leaflet canvas overlay + control panel that visualises the
// tile grid, per-tile Delaunay mesh, buffer zones, and the nearest-neighbour
// triangle walk. Pure presentation — it reads everything it needs through the
// injected XRayDeps and never reaches into app state directly.

import L from "leaflet";
import type { FlatDelaunay } from "../geometry";
import type { TileEntry } from "../tiles";
import type { NearestQuery, QueryResult, WalkTrace } from "./query";
import { createWalkTrace, vertexLatLon } from "./query";
import type { GeoBounds } from "./xray-geometry";
import {
  meshSegments,
  tileBufferRing,
  tileCoreBounds,
  tileHueIndex,
} from "./xray-geometry";

// ---------- Public surface ----------

export interface XRayQueryContext {
  position: { lat: number; lon: number };
  k: number;
  minWeight?: number;
}

export interface XRayDeps {
  /** Loaded per-tile query state, keyed by tile id. Null until ready. */
  getLoadedTiles(): ReadonlyMap<string, NearestQuery> | null;
  /** The full tile index, keyed by tile id. Null until loaded. */
  getTileEntries(): ReadonlyMap<string, TileEntry> | null;
  /** The current query (user position + k + optional weight floor). */
  getQueryContext(): XRayQueryContext | null;
  initialOpen: boolean;
  storage: Pick<Storage, "getItem" | "setItem">;
}

export interface XRayHandle {
  toggle(): void;
  refresh(): void;
  destroy(): void;
}

// ---------- Constants ----------

const LAYERS_KEY = "tour-guide-xray-layers";

/** Distinguishable hues that read on the OSM basemap, cycled per tile. */
const PALETTE = [
  "#e6194b", // crimson
  "#3cb44b", // green
  "#4363d8", // blue
  "#f58231", // orange
  "#911eb4", // purple
  "#008080", // teal
];

/** App accent (matches the header / links). */
const ACCENT = "#1a73e8";

const GRID_COLOR = "#666";

/** Below this zoom the mesh has too many segments to draw usefully. */
const MESH_MIN_ZOOM = 6;

const MOVE_DEBOUNCE_MS = 150;
const WALK_STEP_MS = 70;
const WALK_PULSE_STEPS = 8;
const POS_EPSILON = 1e-6;

interface LayerState {
  mesh: boolean;
  grid: boolean;
  buffers: boolean;
  walk: boolean;
}

const DEFAULT_LAYERS: LayerState = {
  mesh: true,
  grid: false,
  buffers: false,
  walk: true,
};

// ---------- Persistence ----------

function loadLayerState(storage: Pick<Storage, "getItem">): LayerState {
  try {
    const raw = storage.getItem(LAYERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayerState>;
      return {
        mesh:
          typeof parsed.mesh === "boolean" ? parsed.mesh : DEFAULT_LAYERS.mesh,
        grid:
          typeof parsed.grid === "boolean" ? parsed.grid : DEFAULT_LAYERS.grid,
        buffers:
          typeof parsed.buffers === "boolean"
            ? parsed.buffers
            : DEFAULT_LAYERS.buffers,
        walk:
          typeof parsed.walk === "boolean" ? parsed.walk : DEFAULT_LAYERS.walk,
      };
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return { ...DEFAULT_LAYERS };
}

function saveLayerState(
  storage: Pick<Storage, "setItem">,
  state: LayerState,
): void {
  try {
    storage.setItem(LAYERS_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// ---------- Small helpers ----------

function parseTileId(id: string): { row: number; col: number } {
  const [row, col] = id.split("-").map(Number);
  return { row, col };
}

/** Centre longitude of a tile, used to unwrap its mesh around the seam. */
function tileCenterLon(col: number): number {
  return col * 5 - 180 + 2.5;
}

function colorForTile(id: string): string {
  return PALETTE[tileHueIndex(id, PALETTE.length)];
}

function rectRing(b: GeoBounds): L.LatLngTuple[] {
  return [
    [b.south, b.west],
    [b.north, b.west],
    [b.north, b.east],
    [b.south, b.east],
  ];
}

function boundsToGeo(b: L.LatLngBounds): GeoBounds {
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  };
}

function geoToLatLngBounds(b: GeoBounds): L.LatLngBounds {
  return L.latLngBounds([b.south, b.west], [b.north, b.east]);
}

function debounce(
  fn: () => void,
  ms: number,
): (() => void) & { cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const wrapped = () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn();
    }, ms);
  };
  wrapped.cancel = () => {
    if (handle) {
      clearTimeout(handle);
      handle = null;
    }
  };
  return wrapped;
}

// ---------- Walk animation state ----------

interface TileWalk {
  id: string;
  query: NearestQuery;
  trace: WalkTrace;
  best?: QueryResult;
}

interface TileAnim {
  fd: FlatDelaunay;
  hue: string;
  trace: WalkTrace;
  isWinner: boolean;
  locN: number;
  desN: number;
  bfsN: number;
  trailPoly: L.Polygon;
  currentPoly: L.Polygon;
  descentLine: L.Polyline;
  descentDots: L.CircleMarker[];
  bfsDots: L.CircleMarker[];
  pulse: L.CircleMarker | null;
  lastStep: number;
}

// ---------- Factory ----------

export function createXRayOverlay(map: L.Map, deps: XRayDeps): XRayHandle {
  // A dedicated pane above overlays (400) and below markers (600), with one
  // shared canvas renderer for the whole mesh — SVG would choke on it.
  const pane = map.createPane("xray");
  pane.style.zIndex = "450";
  const renderer = L.canvas({ pane: "xray" });

  const layerState = loadLayerState(deps.storage);

  const meshGroup = L.layerGroup();
  const gridGroup = L.layerGroup();
  const bufferGroup = L.layerGroup();
  const walkGroup = L.layerGroup();

  // Per-tile mesh cache, invalidated by the viewport epoch (mesh geometry
  // depends on the clip rectangle, not on the query position).
  const meshCache = new Map<string, { layer: L.Polyline; epoch: number }>();
  let viewportEpoch = 0;

  let gridBuiltKey = "";
  let bufferBuiltKey = "";

  let open = false;
  let statusEl: HTMLElement | null = null;
  const checkboxes: Partial<Record<keyof LayerState, HTMLInputElement>> = {};

  let rafToken: number | null = null;
  let animTiles: TileAnim[] = [];
  let animStart: number | null = null;
  let animGlobalEnd = 0;
  let lastWalkPos: { lat: number; lon: number } | null = null;

  const control = new L.Control({ position: "bottomleft" });

  // ---------- Status ----------

  function setStatus(text: string): void {
    if (statusEl) statusEl.textContent = text;
  }

  // ---------- Padded viewport ----------

  function paddedViewport(): L.LatLngBounds {
    return map.getBounds().pad(0.2);
  }

  // ---------- Mesh ----------

  function reconcileMesh(
    loaded: ReadonlyMap<string, NearestQuery> | null,
  ): void {
    if (map.getZoom() < MESH_MIN_ZOOM) {
      meshGroup.clearLayers();
      meshCache.clear();
      return;
    }
    if (!loaded) {
      meshGroup.clearLayers();
      meshCache.clear();
      return;
    }

    const view = paddedViewport();
    const wanted = new Set<string>();

    for (const [id, query] of loaded) {
      const { row, col } = parseTileId(id);
      const core = geoToLatLngBounds(tileCoreBounds(row, col));
      if (!view.intersects(core)) continue;
      wanted.add(id);

      const cached = meshCache.get(id);
      if (cached && cached.epoch === viewportEpoch) continue;
      if (cached) {
        meshGroup.removeLayer(cached.layer);
      }

      const segments = meshSegments(query.delaunay, {
        unwrapLon: tileCenterLon(col),
        clip: boundsToGeo(view),
      });
      const layer = L.polyline(segments, {
        renderer,
        color: colorForTile(id),
        weight: 1,
        opacity: 0.55,
        interactive: false,
      });
      meshGroup.addLayer(layer);
      meshCache.set(id, { layer, epoch: viewportEpoch });
    }

    // Drop meshes for tiles no longer loaded or no longer in view.
    for (const [id, entry] of meshCache) {
      if (!wanted.has(id)) {
        meshGroup.removeLayer(entry.layer);
        meshCache.delete(id);
      }
    }
  }

  // ---------- Tile grid ----------

  function reconcileGrid(
    loaded: ReadonlyMap<string, NearestQuery> | null,
    entries: ReadonlyMap<string, TileEntry> | null,
  ): void {
    if (!entries) {
      gridGroup.clearLayers();
      gridBuiltKey = "";
      return;
    }
    const loadedKey = loaded ? [...loaded.keys()].sort().join(",") : "";
    const key = `${viewportEpoch}|${loadedKey}`;
    if (key === gridBuiltKey) return;
    gridBuiltKey = key;

    gridGroup.clearLayers();
    const view = paddedViewport();

    for (const entry of entries.values()) {
      const core = tileCoreBounds(entry.row, entry.col);
      const llBounds = geoToLatLngBounds(core);
      if (!view.intersects(llBounds)) continue;

      const rect = L.rectangle(llBounds, {
        renderer,
        color: GRID_COLOR,
        weight: 1,
        fill: false,
        dashArray: "4 4",
        interactive: true,
      });
      rect.bindTooltip(
        `${entry.id} · ${entry.articles.toLocaleString()} articles · ${Math.round(
          entry.bytes / 1024,
        )} kB`,
      );
      gridGroup.addLayer(rect);

      if (loaded && loaded.has(entry.id)) {
        gridGroup.addLayer(
          L.rectangle(llBounds, {
            renderer,
            color: ACCENT,
            weight: 2,
            fill: true,
            fillOpacity: 0.06,
            interactive: false,
          }),
        );
      }
    }
  }

  // ---------- Buffer zones ----------

  function reconcileBuffers(
    loaded: ReadonlyMap<string, NearestQuery> | null,
  ): void {
    const loadedKey = loaded ? [...loaded.keys()].sort().join(",") : "";
    if (loadedKey === bufferBuiltKey) return;
    bufferBuiltKey = loadedKey;

    bufferGroup.clearLayers();
    if (!loaded) return;

    for (const id of loaded.keys()) {
      const { row, col } = parseTileId(id);
      const { outer, inner } = tileBufferRing(row, col);
      const polygon = L.polygon([rectRing(outer), rectRing(inner)], {
        renderer,
        stroke: false,
        fill: true,
        fillColor: colorForTile(id),
        fillOpacity: 0.15,
        interactive: false,
      });
      bufferGroup.addLayer(polygon);
    }
  }

  // ---------- Group membership ----------

  function updateGroupMembership(): void {
    const groups: [keyof LayerState, L.LayerGroup][] = [
      ["mesh", meshGroup],
      ["grid", gridGroup],
      ["buffers", bufferGroup],
      ["walk", walkGroup],
    ];
    for (const [keyName, group] of groups) {
      const shouldShow = open && layerState[keyName];
      if (shouldShow && !map.hasLayer(group)) {
        group.addTo(map);
      } else if (!shouldShow && map.hasLayer(group)) {
        map.removeLayer(group);
      }
    }
  }

  // ---------- Walk animation ----------

  function cancelWalkAnimation(): void {
    if (rafToken !== null) {
      cancelAnimationFrame(rafToken);
      rafToken = null;
    }
    animTiles = [];
    animStart = null;
  }

  function triangleRing(fd: FlatDelaunay, tri: number): L.LatLngTuple[] {
    if (tri < 0 || tri * 3 + 2 >= fd.triangleVertices.length) return [];
    const ring: L.LatLngTuple[] = [];
    const base = tri * 3;
    for (let e = 0; e < 3; e++) {
      const v = fd.triangleVertices[base + e];
      const ll = vertexLatLon(fd, v);
      ring.push([ll.lat, ll.lon]);
    }
    return ring;
  }

  function startWalk(): void {
    cancelWalkAnimation();
    walkGroup.clearLayers();

    const ctx = deps.getQueryContext();
    if (!ctx) {
      setStatus("no query yet");
      return;
    }
    const loaded = deps.getLoadedTiles();
    if (!loaded || loaded.size === 0) {
      setStatus("no query yet");
      return;
    }

    const walks: TileWalk[] = [];
    for (const [id, query] of loaded) {
      const trace = createWalkTrace();
      const { results } = query.findNearest(
        ctx.position.lat,
        ctx.position.lon,
        ctx.k,
        undefined,
        { minWeight: ctx.minWeight, trace },
      );
      walks.push({ id, query, trace, best: results[0] });
    }

    const scored = walks.filter(
      (w): w is TileWalk & { best: QueryResult } => w.best !== undefined,
    );
    if (scored.length === 0) {
      setStatus("no results");
      return;
    }
    let winner = scored[0];
    for (const w of scored) {
      if (w.best.distanceM < winner.best.distanceM) winner = w;
    }

    // Status is known up-front from the winning tile's trace.
    const locateHops = winner.trace.locateTriangles.length;
    const descentSteps = winner.trace.descentVertices.length;
    let status = `found in ${locateHops} hops + ${descentSteps} steps · ${scored.length} tiles searched`;
    if (winner.trace.usedBruteForce) status += " · cycle → brute force";
    setStatus(status);

    // Build per-tile animation layers (drawn incrementally by the rAF loop).
    animTiles = walks.map((w) => {
      const isWinner = w === winner;
      const op = isWinner ? 1 : 0.35;
      const hue = colorForTile(w.id);

      const trailPoly = L.polygon([], {
        renderer,
        stroke: false,
        fill: true,
        fillColor: hue,
        fillOpacity: 0.1 * op,
        interactive: false,
      });
      const currentPoly = L.polygon([], {
        renderer,
        color: hue,
        weight: 1,
        opacity: 0.9 * op,
        fill: true,
        fillColor: hue,
        fillOpacity: 0.45 * op,
        interactive: false,
      });
      const descentLine = L.polyline([], {
        renderer,
        color: hue,
        weight: 2,
        opacity: 0.85 * op,
        interactive: false,
      });
      trailPoly.addTo(walkGroup);
      currentPoly.addTo(walkGroup);
      descentLine.addTo(walkGroup);

      let pulse: L.CircleMarker | null = null;
      if (isWinner && w.best) {
        pulse = L.circleMarker([w.best.lat, w.best.lon], {
          renderer,
          color: ACCENT,
          weight: 2,
          fillColor: ACCENT,
          fillOpacity: 0.3,
          radius: 6,
          interactive: false,
        });
        pulse.addTo(walkGroup);
      }

      return {
        fd: w.query.delaunay,
        hue,
        trace: w.trace,
        isWinner,
        locN: w.trace.locateTriangles.length,
        desN: w.trace.descentVertices.length,
        bfsN: w.trace.bfsVertices.length,
        trailPoly,
        currentPoly,
        descentLine,
        descentDots: [],
        bfsDots: [],
        pulse,
        lastStep: -1,
      } satisfies TileAnim;
    });

    animGlobalEnd =
      Math.max(0, ...animTiles.map((t) => t.locN + t.desN + t.bfsN)) +
      WALK_PULSE_STEPS;
    animStart = null;
    rafToken = requestAnimationFrame(stepWalk);
  }

  function dotMarker(
    lat: number,
    lon: number,
    hue: string,
    op: number,
    bfs: boolean,
  ): L.CircleMarker {
    return L.circleMarker([lat, lon], {
      renderer,
      radius: bfs ? 2.5 : 3,
      color: hue,
      weight: bfs ? 1 : 0,
      opacity: (bfs ? 0.5 : 0.9) * op,
      fillColor: hue,
      fillOpacity: (bfs ? 0.25 : 0.9) * op,
      interactive: false,
    });
  }

  function renderTileDiscrete(t: TileAnim, step: number): void {
    const fd = t.fd;
    const op = t.isWinner ? 1 : 0.35;

    // --- Locate phase: bright current triangle + faint trail of visited.
    if (step < t.locN) {
      const curIdx = Math.min(step, t.locN - 1);
      const tri = t.trace.locateTriangles[curIdx];
      t.currentPoly.setLatLngs(triangleRing(fd, tri));
      const trail: L.LatLngTuple[][][] = [];
      for (let i = 0; i < curIdx; i++) {
        trail.push([triangleRing(fd, t.trace.locateTriangles[i])]);
      }
      t.trailPoly.setLatLngs(trail);
    } else if (t.locN > 0) {
      t.currentPoly.setLatLngs([]);
      const trail: L.LatLngTuple[][][] = [];
      for (let i = 0; i < t.locN; i++) {
        trail.push([triangleRing(fd, t.trace.locateTriangles[i])]);
      }
      t.trailPoly.setLatLngs(trail);
    }

    // --- Descent phase: growing polyline + a dot per visited vertex.
    const ds = step - t.locN;
    if (ds >= 0 && t.desN > 0) {
      const nd = Math.min(ds + 1, t.desN);
      const pts: L.LatLngTuple[] = [];
      for (let i = 0; i < nd; i++) {
        const ll = vertexLatLon(fd, t.trace.descentVertices[i]);
        pts.push([ll.lat, ll.lon]);
      }
      t.descentLine.setLatLngs(pts);
      while (t.descentDots.length < nd) {
        const ll = vertexLatLon(
          fd,
          t.trace.descentVertices[t.descentDots.length],
        );
        const m = dotMarker(ll.lat, ll.lon, t.hue, op, false);
        m.addTo(walkGroup);
        t.descentDots.push(m);
      }
    }

    // --- BFS phase: circle markers fading in for the k-NN expansion.
    const bs = step - t.locN - t.desN;
    if (bs >= 0 && t.bfsN > 0) {
      const nb = Math.min(bs + 1, t.bfsN);
      while (t.bfsDots.length < nb) {
        const ll = vertexLatLon(fd, t.trace.bfsVertices[t.bfsDots.length]);
        const m = dotMarker(ll.lat, ll.lon, t.hue, op, true);
        m.addTo(walkGroup);
        t.bfsDots.push(m);
      }
    }
  }

  function updatePulse(t: TileAnim, stepF: number): void {
    if (!t.pulse) return;
    const tileEnd = t.locN + t.desN + t.bfsN;
    const ps = stepF - tileEnd;
    if (ps <= 0) return;
    const wave = Math.abs(Math.sin(ps * 0.6));
    t.pulse.setRadius(6 + 8 * wave);
    t.pulse.setStyle({
      fillOpacity: 0.15 + 0.35 * wave,
      opacity: 0.4 + 0.5 * wave,
    });
  }

  function stepWalk(ts: number): void {
    if (animStart === null) animStart = ts;
    const stepF = (ts - animStart) / WALK_STEP_MS;
    const intStep = Math.floor(stepF);

    for (const t of animTiles) {
      if (intStep !== t.lastStep) {
        t.lastStep = intStep;
        renderTileDiscrete(t, intStep);
      }
      if (t.isWinner) updatePulse(t, stepF);
    }

    if (stepF >= animGlobalEnd) {
      // Settle every path at its final, fully-drawn state.
      for (const t of animTiles) {
        renderTileDiscrete(t, t.locN + t.desN + t.bfsN);
      }
      rafToken = null;
      animStart = null;
      return;
    }
    rafToken = requestAnimationFrame(stepWalk);
  }

  // ---------- Reconcile / refresh ----------

  function reconcile(): void {
    if (!open) return;
    const loaded = deps.getLoadedTiles();
    const entries = deps.getTileEntries();

    if (layerState.mesh) reconcileMesh(loaded);
    else {
      meshGroup.clearLayers();
      meshCache.clear();
    }
    if (layerState.grid) reconcileGrid(loaded, entries);
    if (layerState.buffers) reconcileBuffers(loaded);

    updateGroupMembership();

    if (layerState.walk) {
      runWalk();
    } else {
      cancelWalkAnimation();
      walkGroup.clearLayers();
    }

    // When the walk layer isn't driving the readout, fall back to a mesh hint.
    if (!layerState.walk) {
      if (layerState.mesh && map.getZoom() < MESH_MIN_ZOOM) {
        setStatus("zoom in for mesh");
      } else {
        setStatus("");
      }
    }
  }

  function runWalk(): void {
    const ctx = deps.getQueryContext();
    if (!ctx) {
      cancelWalkAnimation();
      walkGroup.clearLayers();
      setStatus("no query yet");
      lastWalkPos = null;
      return;
    }
    const moved =
      !lastWalkPos ||
      Math.abs(lastWalkPos.lat - ctx.position.lat) > POS_EPSILON ||
      Math.abs(lastWalkPos.lon - ctx.position.lon) > POS_EPSILON;
    const empty = walkGroup.getLayers().length === 0;
    if (moved || empty) {
      lastWalkPos = { lat: ctx.position.lat, lon: ctx.position.lon };
      startWalk();
    }
  }

  // ---------- Panel DOM ----------

  function buildPanel(): HTMLElement {
    const root = document.createElement("div");
    root.className = "xray-panel";

    const header = document.createElement("div");
    header.className = "xray-panel-header";
    const title = document.createElement("span");
    title.className = "xray-panel-title";
    title.textContent = "X-ray";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "xray-panel-close";
    closeBtn.setAttribute("aria-label", "Close X-ray panel");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => close());
    header.append(title, closeBtn);
    root.append(header);

    const rows: [keyof LayerState, string][] = [
      ["mesh", "Mesh"],
      ["grid", "Tile grid"],
      ["buffers", "Buffer zones"],
      ["walk", "Walk"],
    ];
    for (const [keyName, label] of rows) {
      const row = document.createElement("label");
      row.className = "xray-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = layerState[keyName];
      cb.addEventListener("change", () => {
        layerState[keyName] = cb.checked;
        saveLayerState(deps.storage, layerState);
        // Force the affected layer to rebuild from scratch.
        if (keyName === "grid") gridBuiltKey = "";
        if (keyName === "buffers") bufferBuiltKey = "";
        reconcile();
      });
      checkboxes[keyName] = cb;
      const text = document.createElement("span");
      text.textContent = label;
      row.append(cb, text);
      root.append(row);
    }

    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "xray-replay";
    replay.textContent = "Replay walk";
    replay.addEventListener("click", () => {
      if (!layerState.walk) {
        layerState.walk = true;
        saveLayerState(deps.storage, layerState);
        if (checkboxes.walk) checkboxes.walk.checked = true;
        updateGroupMembership();
      }
      lastWalkPos = deps.getQueryContext()?.position ?? null;
      startWalk();
    });
    root.append(replay);

    const status = document.createElement("div");
    status.className = "xray-status";
    root.append(status);
    statusEl = status;

    L.DomEvent.disableClickPropagation(root);
    L.DomEvent.disableScrollPropagation(root);
    return root;
  }

  // ---------- Open / close ----------

  const onMove = debounce(() => {
    viewportEpoch++;
    reconcile();
  }, MOVE_DEBOUNCE_MS);

  function open_(): void {
    if (open) return;
    open = true;
    const panel = buildPanel();
    control.onAdd = () => panel;
    control.addTo(map);
    map.on("moveend zoomend", onMove);
    viewportEpoch++;
    reconcile();
  }

  function close(): void {
    if (!open) return;
    open = false;
    cancelWalkAnimation();
    map.off("moveend zoomend", onMove);
    onMove.cancel();
    for (const group of [meshGroup, gridGroup, bufferGroup, walkGroup]) {
      if (map.hasLayer(group)) map.removeLayer(group);
      group.clearLayers();
    }
    meshCache.clear();
    gridBuiltKey = "";
    bufferBuiltKey = "";
    lastWalkPos = null;
    control.remove();
    statusEl = null;
  }

  if (deps.initialOpen) open_();

  return {
    toggle(): void {
      if (open) close();
      else open_();
    },
    refresh(): void {
      if (!open) return;
      reconcile();
    },
    destroy(): void {
      close();
    },
  };
}
