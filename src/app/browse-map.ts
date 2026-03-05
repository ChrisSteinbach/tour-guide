import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { NearbyArticle, UserPosition } from "./types";

export interface BrowseMapHandle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  destroy(): void;
}

export function createBrowseMap(
  container: HTMLElement,
  position: UserPosition,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
): BrowseMapHandle {
  const map = L.map(container, { zoomControl: false }).setView(
    [position.lat, position.lon],
    13,
  );

  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  const userMarker = L.circleMarker([position.lat, position.lon], {
    radius: 8,
    color: "#1a73e8",
    fillColor: "#1a73e8",
    fillOpacity: 0.8,
  }).addTo(map);

  let articleMarkers: L.CircleMarker[] = [];

  function updateMarkers(newArticles: NearbyArticle[]): void {
    for (const m of articleMarkers) m.remove();
    articleMarkers = newArticles.map((article) => {
      const m = L.circleMarker([article.lat, article.lon], {
        radius: 6,
        color: "#e84033",
        fillColor: "#e84033",
        fillOpacity: 0.7,
      }).addTo(map);
      m.bindTooltip(article.title);
      m.on("click", () => onSelectArticle(article));
      return m;
    });
  }

  function fitToMarkers(pos: UserPosition, arts: NearbyArticle[]): void {
    if (arts.length === 0) return;
    const points: L.LatLngExpression[] = [
      [pos.lat, pos.lon],
      ...arts.map((a) => [a.lat, a.lon] as [number, number]),
    ];
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }

  let currentTitles = new Set(articles.map((a) => a.title));
  updateMarkers(articles);
  fitToMarkers(position, articles);

  return {
    update(newPosition, newArticles) {
      userMarker.setLatLng([newPosition.lat, newPosition.lon]);
      updateMarkers(newArticles);
      const newTitles = new Set(newArticles.map((a) => a.title));
      if (
        newTitles.size !== currentTitles.size ||
        [...newTitles].some((t) => !currentTitles.has(t))
      ) {
        currentTitles = newTitles;
        fitToMarkers(newPosition, newArticles);
      }
    },
    destroy() {
      map.remove();
    },
  };
}
