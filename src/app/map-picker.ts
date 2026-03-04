import L from "leaflet";
import "leaflet/dist/leaflet.css";

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

  let marker: L.CircleMarker | null = null;
  let confirmBtn: HTMLButtonElement | null = null;

  map.on("click", (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;

    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.circleMarker([lat, lng], {
        radius: 8,
        color: "#1a73e8",
        fillColor: "#1a73e8",
        fillOpacity: 0.8,
      }).addTo(map);
    }

    if (!confirmBtn) {
      confirmBtn = document.createElement("button");
      confirmBtn.className = "map-picker-confirm";
      confirmBtn.textContent = "Use this location";
      container.appendChild(confirmBtn);
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
