// @vitest-environment jsdom

import { vi } from "vitest";

// ── Leaflet mock ────────────────────────────────────────────

const mockMarker = {
  setLatLng: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
};

const mockTileLayer = { addTo: vi.fn() };

let clickHandler:
  | ((e: { latlng: { lat: number; lng: number } }) => void)
  | null = null;

const mockMap = {
  setView: vi.fn().mockReturnThis(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "click") clickHandler = handler;
  }),
  remove: vi.fn(),
};

vi.mock("leaflet", () => ({
  default: {
    map: vi.fn(() => mockMap),
    tileLayer: vi.fn(() => mockTileLayer),
    circleMarker: vi.fn(() => mockMarker),
  },
}));

vi.mock("leaflet/dist/leaflet.css", () => ({}));

import { createMapPicker } from "./map-picker";

// ── Helpers ─────────────────────────────────────────────────

function simulateClick(lat: number, lng: number) {
  clickHandler!({ latlng: { lat, lng } });
}

// ── Tests ───────────────────────────────────────────────────

describe("createMapPicker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    clickHandler = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it("returns a handle with a destroy method", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });
    expect(handle).toHaveProperty("destroy");
    expect(typeof handle.destroy).toBe("function");
    handle.destroy();
  });

  it("initializes a Leaflet map on the container with default view", async () => {
    const L = (await import("leaflet")).default;
    const handle = createMapPicker(container, { onPick: vi.fn() });
    expect(L.map).toHaveBeenCalledWith(container);
    expect(mockMap.setView).toHaveBeenCalledWith([30, 10], 3);
    expect(L.tileLayer).toHaveBeenCalled();
    expect(mockTileLayer.addTo).toHaveBeenCalledWith(mockMap);
    handle.destroy();
  });

  it("centers on provided position at city zoom level", () => {
    const handle = createMapPicker(container, {
      onPick: vi.fn(),
      center: { lat: 48.8, lon: 2.35 },
    });
    expect(mockMap.setView).toHaveBeenCalledWith([48.8, 2.35], 13);
    handle.destroy();
  });

  it("places a marker on first click", async () => {
    const L = (await import("leaflet")).default;
    const handle = createMapPicker(container, { onPick: vi.fn() });

    simulateClick(48.8, 2.35);

    expect(L.circleMarker).toHaveBeenCalledWith(
      [48.8, 2.35],
      expect.objectContaining({ radius: 8 }),
    );
    expect(mockMarker.addTo).toHaveBeenCalledWith(mockMap);
    handle.destroy();
  });

  it("moves existing marker on subsequent clicks", async () => {
    const L = (await import("leaflet")).default;
    const handle = createMapPicker(container, { onPick: vi.fn() });

    simulateClick(48.8, 2.35);
    simulateClick(51.5, -0.12);

    // circleMarker created only once
    expect(L.circleMarker).toHaveBeenCalledTimes(1);
    expect(mockMarker.setLatLng).toHaveBeenCalledWith([51.5, -0.12]);
    handle.destroy();
  });

  it("shows confirm button after first click", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });

    expect(container.querySelector(".map-picker-confirm")).toBeNull();

    simulateClick(48.8, 2.35);

    const btn = container.querySelector(".map-picker-confirm");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("Use this location");
    handle.destroy();
  });

  it("creates only one confirm button for multiple clicks", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });

    simulateClick(48.8, 2.35);
    simulateClick(51.5, -0.12);

    const buttons = container.querySelectorAll(".map-picker-confirm");
    expect(buttons).toHaveLength(1);
    handle.destroy();
  });

  it("fires onPick with clicked coordinates when confirm is clicked", () => {
    const onPick = vi.fn();
    const handle = createMapPicker(container, { onPick });

    simulateClick(48.8, 2.35);

    const btn = container.querySelector(
      ".map-picker-confirm",
    ) as HTMLButtonElement;
    btn.click();

    expect(onPick).toHaveBeenCalledWith(48.8, 2.35);
    handle.destroy();
  });

  it("updates onPick coordinates when map is clicked again", () => {
    const onPick = vi.fn();
    const handle = createMapPicker(container, { onPick });

    simulateClick(48.8, 2.35);
    simulateClick(51.5, -0.12);

    const btn = container.querySelector(
      ".map-picker-confirm",
    ) as HTMLButtonElement;
    btn.click();

    expect(onPick).toHaveBeenCalledWith(51.5, -0.12);
    expect(onPick).not.toHaveBeenCalledWith(48.8, 2.35);
    handle.destroy();
  });

  it("destroy() removes the confirm button from DOM", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });

    simulateClick(48.8, 2.35);
    expect(container.querySelector(".map-picker-confirm")).not.toBeNull();

    handle.destroy();
    expect(container.querySelector(".map-picker-confirm")).toBeNull();
  });

  it("destroy() removes the Leaflet map", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });
    handle.destroy();
    expect(mockMap.remove).toHaveBeenCalled();
  });

  it("destroy() works even if no click occurred", () => {
    const handle = createMapPicker(container, { onPick: vi.fn() });
    expect(() => handle.destroy()).not.toThrow();
    expect(mockMap.remove).toHaveBeenCalled();
  });
});
