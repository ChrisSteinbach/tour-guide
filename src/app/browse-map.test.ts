// @vitest-environment jsdom

import { vi } from "vitest";
import type { NearbyArticle, UserPosition } from "./types";

// ── Leaflet mock ────────────────────────────────────────────

// All mock objects must be created inside the vi.mock factory (hoisted).
// We access them via the imported L default to avoid hoisting issues.

vi.mock("leaflet", () => {
  const mockMap = {
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn(),
    remove: vi.fn(),
  };
  const mockCircleMarker = {
    setLatLng: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
  };
  const mockTileLayer = { addTo: vi.fn() };
  const mockZoomControl = { addTo: vi.fn() };
  const mockLatLngBounds = { _mock: true };

  const createArticleMarker = () => ({
    addTo: vi.fn().mockReturnThis(),
    bindTooltip: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    remove: vi.fn(),
  });

  return {
    default: {
      map: vi.fn(() => mockMap),
      tileLayer: vi.fn(() => mockTileLayer),
      circleMarker: vi.fn(() => mockCircleMarker),
      marker: vi.fn(() => createArticleMarker()),
      icon: vi.fn(() => ({ _isMockIcon: true })),
      control: { zoom: vi.fn(() => mockZoomControl) },
      latLngBounds: vi.fn(() => mockLatLngBounds),
      // Expose mocks for assertions
      _mocks: {
        mockMap,
        mockCircleMarker,
        mockTileLayer,
        mockZoomControl,
        mockLatLngBounds,
      },
    },
  };
});

vi.mock("leaflet/dist/leaflet.css", () => ({}));

import L from "leaflet";
import { createBrowseMap } from "./browse-map";

// Typed access to internal mocks
const mocks = (L as any)._mocks as {
  mockMap: {
    setView: ReturnType<typeof vi.fn>;
    fitBounds: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  mockCircleMarker: {
    setLatLng: ReturnType<typeof vi.fn>;
    addTo: ReturnType<typeof vi.fn>;
  };
  mockTileLayer: { addTo: ReturnType<typeof vi.fn> };
  mockZoomControl: { addTo: ReturnType<typeof vi.fn> };
  mockLatLngBounds: object;
};

// ── Helpers ─────────────────────────────────────────────────

function pos(lat: number, lon: number): UserPosition {
  return { lat, lon };
}

function article(title: string, lat: number, lon: number): NearbyArticle {
  return { title, lat, lon, distanceM: 100 };
}

// ── Tests ───────────────────────────────────────────────────

describe("createBrowseMap", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it("creates a Leaflet map centered on the user position", () => {
    const handle = createBrowseMap(container, pos(48.8, 2.35), [], vi.fn());

    expect(L.map).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ zoomControl: false }),
    );
    expect(mocks.mockMap.setView).toHaveBeenCalledWith([48.8, 2.35], 13);
    handle.destroy();
  });

  it("adds a tile layer and zoom control", () => {
    const handle = createBrowseMap(container, pos(0, 0), [], vi.fn());

    expect(L.tileLayer).toHaveBeenCalled();
    expect(mocks.mockTileLayer.addTo).toHaveBeenCalledWith(mocks.mockMap);
    expect(L.control.zoom).toHaveBeenCalledWith({ position: "topright" });
    expect(mocks.mockZoomControl.addTo).toHaveBeenCalledWith(mocks.mockMap);
    handle.destroy();
  });

  it("places a user location dot at the given position", () => {
    const handle = createBrowseMap(container, pos(51.5, -0.12), [], vi.fn());

    expect(L.circleMarker).toHaveBeenCalledWith(
      [51.5, -0.12],
      expect.objectContaining({ radius: 8 }),
    );
    expect(mocks.mockCircleMarker.addTo).toHaveBeenCalledWith(mocks.mockMap);
    handle.destroy();
  });

  it("places article markers with tooltips", () => {
    const articles = [
      article("Eiffel Tower", 48.858, 2.294),
      article("Louvre", 48.861, 2.337),
    ];
    const handle = createBrowseMap(
      container,
      pos(48.86, 2.35),
      articles,
      vi.fn(),
    );

    const markerMock = L.marker as ReturnType<typeof vi.fn>;
    expect(markerMock).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const markers = markerMock.mock.results.map((r) => r.value);
    expect(markers[0].bindTooltip).toHaveBeenCalledWith("Eiffel Tower");
    expect(markers[1].bindTooltip).toHaveBeenCalledWith("Louvre");
    handle.destroy();
  });

  it("fires onSelectArticle when an article marker is clicked", () => {
    const onSelect = vi.fn();
    const a = article("Eiffel Tower", 48.858, 2.294);
    const handle = createBrowseMap(container, pos(48.86, 2.35), [a], onSelect);

    const markerMock = L.marker as ReturnType<typeof vi.fn>;
    const marker = markerMock.mock.results[0].value;
    const clickCall = marker.on.mock.calls.find(
      ([event]: [string]) => event === "click",
    )!;
    clickCall[1]();

    expect(onSelect).toHaveBeenCalledWith(a);
    handle.destroy();
  });

  it("fits bounds to include user and all articles on creation", () => {
    const articles = [article("A", 49, 3), article("B", 50, 4)];
    const handle = createBrowseMap(container, pos(48, 2), articles, vi.fn());

    expect(L.latLngBounds).toHaveBeenCalledWith([
      [48, 2],
      [49, 3],
      [50, 4],
    ]);
    expect(mocks.mockMap.fitBounds).toHaveBeenCalledWith(
      mocks.mockLatLngBounds,
      { padding: [40, 40] },
    );
    handle.destroy();
  });

  it("does not fit bounds when created with no articles", () => {
    const handle = createBrowseMap(container, pos(48, 2), [], vi.fn());
    expect(mocks.mockMap.fitBounds).not.toHaveBeenCalled();
    handle.destroy();
  });

  describe("update()", () => {
    it("moves the user location dot to the new position", () => {
      const handle = createBrowseMap(container, pos(48, 2), [], vi.fn());
      handle.update(pos(49, 3), []);
      expect(mocks.mockCircleMarker.setLatLng).toHaveBeenCalledWith([49, 3]);
      handle.destroy();
    });

    it("replaces article markers when articles change", () => {
      const handle = createBrowseMap(
        container,
        pos(48, 2),
        [article("A", 49, 3)],
        vi.fn(),
      );
      const markerMock = L.marker as ReturnType<typeof vi.fn>;
      const oldMarker = markerMock.mock.results[0].value;

      handle.update(pos(48, 2), [article("B", 50, 4)]);

      expect(oldMarker.remove).toHaveBeenCalled();
      // 1 from creation + 1 from update
      expect(markerMock).toHaveBeenCalledTimes(2);
      handle.destroy();
    });

    it("refits bounds when article set changes", () => {
      const handle = createBrowseMap(
        container,
        pos(48, 2),
        [article("A", 49, 3)],
        vi.fn(),
      );
      mocks.mockMap.fitBounds.mockClear();

      handle.update(pos(48, 2), [article("B", 50, 4)]);

      expect(mocks.mockMap.fitBounds).toHaveBeenCalled();
      handle.destroy();
    });

    it("does NOT refit bounds when articles are the same titles", () => {
      const handle = createBrowseMap(
        container,
        pos(48, 2),
        [article("A", 49, 3)],
        vi.fn(),
      );
      mocks.mockMap.fitBounds.mockClear();

      handle.update(pos(48.1, 2.1), [article("A", 49, 3)]);

      expect(mocks.mockMap.fitBounds).not.toHaveBeenCalled();
      handle.destroy();
    });

    it("refits when an article is added to the set", () => {
      const handle = createBrowseMap(
        container,
        pos(48, 2),
        [article("A", 49, 3)],
        vi.fn(),
      );
      mocks.mockMap.fitBounds.mockClear();

      handle.update(pos(48, 2), [article("A", 49, 3), article("B", 50, 4)]);

      expect(mocks.mockMap.fitBounds).toHaveBeenCalled();
      handle.destroy();
    });

    it("refits when an article is removed from the set", () => {
      const handle = createBrowseMap(
        container,
        pos(48, 2),
        [article("A", 49, 3), article("B", 50, 4)],
        vi.fn(),
      );
      mocks.mockMap.fitBounds.mockClear();

      handle.update(pos(48, 2), [article("A", 49, 3)]);

      expect(mocks.mockMap.fitBounds).toHaveBeenCalled();
      handle.destroy();
    });
  });

  describe("destroy()", () => {
    it("removes the Leaflet map", () => {
      const handle = createBrowseMap(container, pos(48, 2), [], vi.fn());
      handle.destroy();
      expect(mocks.mockMap.remove).toHaveBeenCalled();
    });
  });
});
