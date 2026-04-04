import L from "leaflet";

export interface WorldBoundsSetup {
  mapOptions: { maxBounds: L.LatLngBounds; maxBoundsViscosity: number };
  tileOptions: { noWrap: boolean };
  install(map: L.Map): () => void;
}

export function worldZoomBounds(): WorldBoundsSetup {
  const bounds = L.latLngBounds([-90, -180], [90, 180]);
  return {
    mapOptions: { maxBounds: bounds, maxBoundsViscosity: 1.0 },
    tileOptions: { noWrap: true },
    install(map) {
      function updateMinZoom() {
        map.setMinZoom(map.getBoundsZoom(bounds, true));
      }
      updateMinZoom();
      map.on("resize", updateMinZoom);
      return () => map.off("resize", updateMinZoom);
    },
  };
}
