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
function articleNorth(km: number, title = "North"): NearbyArticle {
  return { title, lat: km / 111.32, lon: 0, distanceM: km * 1000 };
}

function articleEast(km: number, title = "East"): NearbyArticle {
  return { title, lat: 0, lon: km / 111.32, distanceM: km * 1000 };
}

function click(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(
    new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }),
  );
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

    view.update(POSITION, [articleNorth(1)]);
    expect(empty?.hidden).toBe(true);
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

    view.update(POSITION, [articleNorth(1), articleEast(1), articleNorth(3)]);

    expect(canvas.getAttribute("aria-label")).toContain("3 nearby articles");
    view.destroy();
  });
});
