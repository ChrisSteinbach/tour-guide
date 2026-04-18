import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { worldZoomBounds } from "./map-bounds";
import { locationPinIcon } from "./map-icons";

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
  const wb = worldZoomBounds();
  const map = L.map(container, {
    ...wb.mapOptions,
  }).setView(initialView, initialZoom);

  const removeResizeHandler = wb.install(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    ...wb.tileOptions,
  }).addTo(map);

  let marker: L.Marker | null = null;
  let confirmBtn: HTMLButtonElement | null = null;

  map.on("click", (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;

    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.marker([lat, lng], { icon: locationPinIcon }).addTo(map);
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
      removeResizeHandler();
      map.remove();
    },
  };
}
