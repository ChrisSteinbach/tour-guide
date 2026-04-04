// @vitest-environment jsdom

import { vi } from "vitest";

// ── Leaflet mock ────────────────────────────────────────────

const mockBounds = { _mock: true };

vi.mock("leaflet", () => ({
  default: {
    latLngBounds: vi.fn(() => mockBounds),
  },
}));

import { worldZoomBounds } from "./map-bounds";

// ── Tests ───────────────────────────────────────────────────

describe("worldZoomBounds", () => {
  it("returns mapOptions with maxBounds and maxBoundsViscosity", () => {
    const wb = worldZoomBounds();
    expect(wb.mapOptions.maxBounds).toBe(mockBounds);
    expect(wb.mapOptions.maxBoundsViscosity).toBe(1.0);
  });

  it("returns tileOptions with noWrap: true", () => {
    const wb = worldZoomBounds();
    expect(wb.tileOptions).toEqual({ noWrap: true });
  });

  describe("install()", () => {
    function createMockMap() {
      return {
        getBoundsZoom: vi.fn(() => 2),
        setMinZoom: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      };
    }

    it("calls setMinZoom with getBoundsZoom result immediately", () => {
      const map = createMockMap();
      map.getBoundsZoom.mockReturnValue(3);

      const wb = worldZoomBounds();
      wb.install(map as unknown as L.Map);

      expect(map.getBoundsZoom).toHaveBeenCalledWith(mockBounds, true);
      expect(map.setMinZoom).toHaveBeenCalledWith(3);
    });

    it("registers a resize handler that recalculates min zoom", () => {
      const map = createMockMap();
      map.getBoundsZoom.mockReturnValue(2);

      const wb = worldZoomBounds();
      wb.install(map as unknown as L.Map);

      const resizeCall = map.on.mock.calls.find(
        (call) => call[0] === "resize",
      )!;
      expect(resizeCall).toBeDefined();

      // Simulate container resize changing the bounds zoom
      map.getBoundsZoom.mockReturnValue(4);
      map.setMinZoom.mockClear();
      resizeCall[1]();

      expect(map.setMinZoom).toHaveBeenCalledWith(4);
    });

    it("returns a cleanup function that removes the resize handler", () => {
      const map = createMockMap();

      const wb = worldZoomBounds();
      const cleanup = wb.install(map as unknown as L.Map);

      const resizeHandler = map.on.mock.calls.find(
        (call) => call[0] === "resize",
      )![1];

      cleanup();

      expect(map.off).toHaveBeenCalledWith("resize", resizeHandler);
    });
  });
});
