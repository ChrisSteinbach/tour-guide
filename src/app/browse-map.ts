import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { worldZoomBounds } from "./map-bounds";
import type { NearbyArticle, UserPosition } from "./types";
import {
  wikiPinIcon,
  wikiPinHighlightIcon,
  locationPinIcon,
} from "./map-icons";

export interface BrowseMapHandle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  highlight(title: string | null): void;
  resize(): void;
  destroy(): void;
}

export function createBrowseMap(
  container: HTMLElement,
  position: UserPosition,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
): BrowseMapHandle {
  const wb = worldZoomBounds();
  const map = L.map(container, {
    zoomControl: false,
    ...wb.mapOptions,
  }).setView([position.lat, position.lon], 13);

  const removeResizeHandler = wb.install(map);

  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    ...wb.tileOptions,
  }).addTo(map);

  const userMarker = L.marker([position.lat, position.lon], {
    icon: locationPinIcon,
  }).addTo(map);

  let articleMarkers = new Map<string, L.Marker>();
  let highlightedTitle: string | null = null;

  function updateMarkers(newArticles: NearbyArticle[]): void {
    for (const m of articleMarkers.values()) m.remove();
    articleMarkers = new Map();
    for (const article of newArticles) {
      const isHighlighted = article.title === highlightedTitle;
      const m = L.marker([article.lat, article.lon], {
        icon: isHighlighted ? wikiPinHighlightIcon : wikiPinIcon,
        zIndexOffset: isHighlighted ? 1000 : 0,
      }).addTo(map);
      m.bindTooltip(article.title);
      m.on("click", () => onSelectArticle(article));
      articleMarkers.set(article.title, m);
    }
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
    highlight(title) {
      // Remove previous highlight
      if (highlightedTitle) {
        const prev = articleMarkers.get(highlightedTitle);
        if (prev) {
          prev.setIcon(wikiPinIcon);
          prev.setZIndexOffset(0);
        }
      }
      highlightedTitle = title;
      // Apply new highlight
      if (title) {
        const marker = articleMarkers.get(title);
        if (marker) {
          marker.setIcon(wikiPinHighlightIcon);
          marker.setZIndexOffset(1000);
        }
      }
    },
    resize() {
      map.invalidateSize();
    },
    destroy() {
      removeResizeHandler();
      map.remove();
    },
  };
}
