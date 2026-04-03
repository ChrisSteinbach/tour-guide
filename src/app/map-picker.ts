import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapPickerHandle {
  destroy(): void;
}

interface MapPickerOptions {
  onPick: (lat: number, lon: number) => void;
  center?: { lat: number; lon: number };
}

export function createMapPicker(
  container: HTMLElement,
  { onPick, center }: MapPickerOptions,
): MapPickerHandle {
  const initialView: [number, number] = center
    ? [center.lat, center.lon]
    : [30, 10];
  const initialZoom = center ? 13 : 3;
  const worldBounds = L.latLngBounds([-90, -180], [90, 180]);
  const map = L.map(container, {
    maxBounds: worldBounds,
    maxBoundsViscosity: 1.0,
  }).setView(initialView, initialZoom);

  function updateMinZoom() {
    map.setMinZoom(map.getBoundsZoom(worldBounds, true));
  }
  updateMinZoom();
  map.on("resize", updateMinZoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true,
  }).addTo(map);

  let marker: L.CircleMarker | null = null;
  let confirmBtn: HTMLButtonElement | null = null;

  map.on("click", (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;

    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.circleMarker([lat, lng], {
        radius: 8,
        color: "#e84033",
        fillColor: "#e84033",
        fillOpacity: 0.8,
      }).addTo(map);
    }

    if (!confirmBtn) {
      confirmBtn = document.createElement("button");
      confirmBtn.className = "map-picker-confirm";
      confirmBtn.textContent = "Use this location";
      const parent = container.parentElement;
      if (!parent) {
        throw new Error(
          "Map picker container must have a parent element for confirm button placement",
        );
      }
      parent.appendChild(confirmBtn);
    }

    confirmBtn.onclick = () => onPick(lat, lng);
  });

  return {
    destroy() {
      confirmBtn?.remove();
      map.off("resize", updateMinZoom);
      map.remove();
    },
  };
}
