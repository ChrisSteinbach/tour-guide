// @vitest-environment jsdom
import { createRadarView } from "./radar-view";
import type { NearbyArticle, UserPosition } from "./types";

// jsdom has no layout; give the radar a concrete 300×300 box so blip
// projection (which reads clientWidth/clientHeight) is deterministic.
// Center = (150, 150), ring radius = 120.
function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 300 });
  Object.defineProperty(el, "clientHeight", { value: 300 });
  document.body.appendChild(el);
  return el;
}

const POSITION: UserPosition = { lat: 0, lon: 0 };

/** ~111 km per degree at the equator; distances chosen to match. */
function articleNorth(
  km: number,
  title = "North",
  weight?: number,
): NearbyArticle {
  return { title, lat: km / 111.32, lon: 0, distanceM: km * 1000, weight };
}

function articleEast(
  km: number,
  title = "East",
  weight?: number,
): NearbyArticle {
  return { title, lat: 0, lon: km / 111.32, distanceM: km * 1000, weight };
}

function click(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(
    new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }),
  );
}

/**
 * A minimal fake 2D context so draw() — normally skipped under jsdom, which
 * has no real canvas — can run to completion. Every drawing call is a no-op
 * except fill()/fillText(), which record what was drawn so coincident-group
 * rendering (the count badge, the highlight color) can be asserted on.
 */
function fakeCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  fillStyles: unknown[];
  texts: string[];
} {
  const fillStyles: unknown[] = [];
  const texts: string[] = [];
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
    fillRect: noop,
    beginPath: noop,
    closePath: noop,
    arc: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: () => fillStyles.push(ctx.fillStyle),
    fillText: (text: string) => texts.push(text),
    roundRect: noop,
    save: noop,
    restore: noop,
    setTransform: noop,
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillStyles,
    texts,
  };
}

/** Waits for the radar's animation loop to paint at least one frame. */
async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("createRadarView", () => {
  beforeEach(() => {
    // jsdom has no canvas implementation and logs "Not implemented" on
    // every getContext call; the radar skips drawing when ctx is null.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    document.body.textContent = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a canvas with an accessible summary", () => {
    const el = makeContainer();
    const view = createRadarView(
      el,
      POSITION,
      [articleNorth(1), articleEast(2)],
      vi.fn(),
    );

    const canvas = el.querySelector("canvas.radar-canvas");
    expect(canvas).toBeTruthy();
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-label")).toContain("2 nearby articles");
    view.destroy();
  });

  it("shows the empty state only when there are no articles", () => {
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [], vi.fn());

    const empty = el.querySelector<HTMLElement>(".radar-empty");
    expect(empty?.hidden).toBe(false);

    view.update(POSITION, [articleNorth(1)], "gps");
    expect(empty?.hidden).toBe(true);
    view.destroy();
  });

  it("captions the empty state as a tile-load failure when degraded", () => {
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [], vi.fn());
    const empty = el.querySelector<HTMLElement>(".radar-empty");

    view.update(POSITION, [], "gps", true);

    expect(empty?.textContent).toBe("Couldn’t load nearby articles");
    view.destroy();
  });

  it("captions the empty state as ordinary no-results when not degraded", () => {
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [articleNorth(1)], vi.fn());
    const empty = el.querySelector<HTMLElement>(".radar-empty");

    view.update(POSITION, [], "gps", false);

    expect(empty?.textContent).toBe("No articles in range");
    view.destroy();
  });

  it("selects the article whose blip is clicked", () => {
    const el = makeContainer();
    const onSelect = vi.fn();
    const north = articleNorth(2);
    const east = articleEast(2);
    const view = createRadarView(el, POSITION, [north, east], onSelect);
    const canvas = el.querySelector("canvas")!;

    // Both at full scale (2 km of a 2 km range): north blip at
    // (150, 150-120) = (150, 30); east blip at (270, 150).
    click(canvas, 150, 32);
    expect(onSelect).toHaveBeenLastCalledWith(north);

    click(canvas, 268, 150);
    expect(onSelect).toHaveBeenLastCalledWith(east);
    view.destroy();
  });

  it("ignores clicks on empty radar space", () => {
    const el = makeContainer();
    const onSelect = vi.fn();
    const view = createRadarView(el, POSITION, [articleNorth(2)], onSelect);

    // Far corner — nowhere near the northern blip at (150, 30).
    click(el.querySelector("canvas")!, 290, 290);

    expect(onSelect).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does not offer a compass button on platforms without a permission gate", () => {
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [], vi.fn());
    expect(el.querySelector(".radar-compass-btn")).toBeNull();
    view.destroy();
  });

  it("offers a compass button behind an iOS-style permission gate and starts on grant", async () => {
    vi.stubGlobal("DeviceOrientationEvent", {
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [], vi.fn());

    const btn = el.querySelector<HTMLButtonElement>(".radar-compass-btn");
    expect(btn).toBeTruthy();

    btn!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(el.querySelector(".radar-compass-btn")).toBeNull();
    view.destroy();
    vi.unstubAllGlobals();
  });

  describe("position source and compass", () => {
    /** Force reduced motion so compass headings apply synchronously.
     *  (jsdom has no matchMedia at all, so define it as a global stub.) */
    function stubReducedMotion(): void {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    }

    function dispatchHeadingEast(): void {
      // absolute alpha 270 → compass heading 90 (device facing east)
      const e = new Event("deviceorientation");
      Object.assign(e, { absolute: true, alpha: 270 });
      window.dispatchEvent(e);
    }

    it("rotates with the compass when the position is live GPS", () => {
      stubReducedMotion();
      const el = makeContainer();
      const onSelect = vi.fn();
      const north = articleNorth(2);
      const view = createRadarView(el, POSITION, [north], onSelect, "gps");
      const canvas = el.querySelector("canvas")!;

      dispatchHeadingEast();

      // Heading-up at 90°: the northern blip moves to the screen's left edge.
      click(canvas, 30, 150);
      expect(onSelect).toHaveBeenCalledWith(north);
      view.destroy();
    });

    it("ignores the compass for a map-picked position (stays north-up)", () => {
      stubReducedMotion();
      const el = makeContainer();
      const onSelect = vi.fn();
      const north = articleNorth(2);
      const view = createRadarView(el, POSITION, [north], onSelect, "picked");
      const canvas = el.querySelector("canvas")!;

      dispatchHeadingEast();

      click(canvas, 30, 150); // where the blip would sit if rotated
      expect(onSelect).not.toHaveBeenCalled();
      click(canvas, 150, 32); // north-up position
      expect(onSelect).toHaveBeenCalledWith(north);
      view.destroy();
    });

    it("snaps back to north-up when the position switches to picked", () => {
      stubReducedMotion();
      const el = makeContainer();
      const onSelect = vi.fn();
      const north = articleNorth(2);
      const view = createRadarView(el, POSITION, [north], onSelect, "gps");
      const canvas = el.querySelector("canvas")!;
      dispatchHeadingEast(); // rotated while live

      view.update(POSITION, [north], "picked");

      click(canvas, 150, 32);
      expect(onSelect).toHaveBeenCalledWith(north);
      view.destroy();
    });

    it("hides the compass permission button while picked and restores it on GPS", () => {
      vi.stubGlobal("DeviceOrientationEvent", {
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      const el = makeContainer();
      const view = createRadarView(el, POSITION, [], vi.fn(), "picked");

      const btn = el.querySelector<HTMLButtonElement>(".radar-compass-btn");
      expect(btn?.hidden).toBe(true);

      view.update(POSITION, [], "gps");
      expect(btn?.hidden).toBe(false);

      view.destroy();
      vi.unstubAllGlobals();
    });
  });

  it("destroy removes its DOM and stops listening", () => {
    const el = makeContainer();
    const onSelect = vi.fn();
    const view = createRadarView(el, POSITION, [articleNorth(2)], onSelect);
    const canvas = el.querySelector("canvas")!;

    view.destroy();

    expect(el.querySelector("canvas")).toBeNull();
    expect(el.querySelector(".radar-empty")).toBeNull();
    click(canvas, 150, 32);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("update reflects the new article set in the accessible summary", () => {
    const el = makeContainer();
    const view = createRadarView(el, POSITION, [], vi.fn());
    const canvas = el.querySelector("canvas")!;

    view.update(
      POSITION,
      [articleNorth(1), articleEast(1), articleNorth(3)],
      "gps",
    );

    expect(canvas.getAttribute("aria-label")).toContain("3 nearby articles");
    view.destroy();
  });

  describe("coincident groups (co-located articles)", () => {
    it("collapses co-located articles into a single contact, naming both location and article counts", () => {
      const el = makeContainer();
      const view = createRadarView(
        el,
        POSITION,
        [
          articleNorth(2, "A"),
          articleNorth(2, "B"), // same coordinate as A
          articleNorth(2, "C"), // same coordinate as A
        ],
        vi.fn(),
      );
      const canvas = el.querySelector("canvas")!;

      const label = canvas.getAttribute("aria-label");
      expect(label).toContain("1 nearby locations");
      expect(label).toContain("3 articles");
      view.destroy();
    });

    it("does not mention locations separately when there is no coincidence", () => {
      const el = makeContainer();
      const view = createRadarView(
        el,
        POSITION,
        [articleNorth(1), articleEast(2)],
        vi.fn(),
      );
      const canvas = el.querySelector("canvas")!;

      // Unchanged wording for the common case: no "locations" split needed.
      expect(canvas.getAttribute("aria-label")).toContain("2 nearby articles");
      expect(canvas.getAttribute("aria-label")).not.toContain("locations");
      view.destroy();
    });

    it("selects the group's highest-weight representative when its shared blip is clicked", () => {
      const el = makeContainer();
      const onSelect = vi.fn();
      const minor = articleNorth(2, "Minor", 10);
      const major = articleNorth(2, "Major", 50); // same coordinate, outweighs Minor
      const view = createRadarView(el, POSITION, [minor, major], onSelect);
      const canvas = el.querySelector("canvas")!;

      // Same screen position as a lone 2 km-north article (see "selects the
      // article whose blip is clicked" above) — both members share one blip.
      click(canvas, 150, 32);

      expect(onSelect).toHaveBeenCalledWith(major);
      expect(onSelect).not.toHaveBeenCalledWith(minor);
      view.destroy();
    });

    it("still selects a lone non-coincident article normally alongside a cluster", () => {
      const el = makeContainer();
      const onSelect = vi.fn();
      const solo = articleEast(2, "Solo");
      const minor = articleNorth(2, "Minor", 10);
      const major = articleNorth(2, "Major", 50);
      const view = createRadarView(
        el,
        POSITION,
        [solo, minor, major],
        onSelect,
      );
      const canvas = el.querySelector("canvas")!;

      click(canvas, 268, 150); // east blip, per the existing hit-test geometry
      expect(onSelect).toHaveBeenLastCalledWith(solo);

      click(canvas, 150, 32); // north blip, shared by the Minor/Major group
      expect(onSelect).toHaveBeenLastCalledWith(major);
      view.destroy();
    });

    // These three use a fake 2D context (draw() is normally skipped under
    // jsdom) so the coincident-group rendering itself — not just the
    // interaction layer above — gets real coverage.
    describe("rendering", () => {
      it("draws a count badge for a coincident group's blip", async () => {
        const { ctx, texts } = fakeCanvasContext();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
          ctx,
        );

        const el = makeContainer();
        const minor = articleNorth(2, "Minor", 10);
        const major = articleNorth(2, "Major", 50);
        const view = createRadarView(el, POSITION, [minor, major], vi.fn());
        await nextFrame();

        expect(texts).toContain("2");
        view.destroy();
      });

      it("draws no count badge for a lone (non-coincident) article", async () => {
        const { ctx, texts } = fakeCanvasContext();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
          ctx,
        );

        const el = makeContainer();
        const view = createRadarView(el, POSITION, [articleNorth(2)], vi.fn());
        await nextFrame();

        expect(texts).not.toContain("2");
        view.destroy();
      });

      it("highlight(memberTitle) lights the shared blip even for a non-representative member", async () => {
        const { ctx, fillStyles } = fakeCanvasContext();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
          ctx,
        );

        const el = makeContainer();
        const minor = articleNorth(2, "Minor", 10);
        const major = articleNorth(2, "Major", 50); // representative
        const view = createRadarView(el, POSITION, [minor, major], vi.fn());
        await nextFrame();
        fillStyles.length = 0; // discard the initial, unhighlighted paint

        view.highlight("Minor"); // non-representative member
        await nextFrame();

        expect(fillStyles).toContain("#ffffff");
        view.destroy();
      });
    });
  });
});
