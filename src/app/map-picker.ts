import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet's broken default marker icon paths in bundlers
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

export interface MapPickerHandle {
  destroy(): void;
}

interface MapPickerOptions {
  onPick: (lat: number, lon: number) => void;
}

export function createMapPicker(
  container: HTMLElement,
  { onPick }: MapPickerOptions,
): MapPickerHandle {
  const map = L.map(container).setView([30, 10], 3);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  let marker: L.Marker | null = null;
  let confirmBtn: HTMLButtonElement | null = null;

  map.on("click", (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;

    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.marker([lat, lng]).addTo(map);
    }

    if (!confirmBtn) {
      confirmBtn = document.createElement("button");
      confirmBtn.className = "map-picker-confirm";
      confirmBtn.textContent = "Use this location";
      container.parentElement?.appendChild(confirmBtn);
    }

    confirmBtn.onclick = () => onPick(lat, lng);
  });

  return {
    destroy() {
      confirmBtn?.remove();
      map.remove();
    },
  };
}
