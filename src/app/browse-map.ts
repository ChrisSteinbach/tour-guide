import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { worldZoomBounds } from "./map-bounds";
import { collapseCoincident } from "./coincident";
import type { CoincidentGroup } from "./coincident";
import { createMemberRows } from "./cluster-popover";
import type { NearbyArticle, UserPosition } from "./types";
import {
  wikiPinIcon,
  wikiPinHighlightIcon,
  wikiPinClusterIcon,
  wikiPinClusterHighlightIcon,
  locationPinIcon,
} from "./map-icons";

export interface BrowseMapHandle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  highlight(title: string | null): void;
  resize(): void;
  destroy(): void;
}

/** The slice of the X-ray overlay the browse map drives. */
export interface BrowseMapXRay {
  toggle(): void;
  refresh(): void;
  destroy(): void;
}

export interface BrowseMapOptions {
  /** Attach an X-ray overlay to the underlying Leaflet map. */
  attachXRay?: (map: L.Map) => BrowseMapXRay;
}

export function createBrowseMap(
  container: HTMLElement,
  position: UserPosition,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
  options?: BrowseMapOptions,
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

  const xray = options?.attachXRay?.(map);
  if (xray) {
    // Right-click on desktop / long-press on mobile toggles the X-ray panel.
    // Leaflet suppresses the native context menu while a listener is attached.
    map.on("contextmenu", () => xray.toggle());
  }

  // Distinct articles can share bit-identical coordinates (see
  // src/app/coincident.ts); each coordinate gets exactly one marker, so every
  // member's title maps to that shared entry — a co-located non-representative
  // member still resolves to (and highlights) its group's marker.
  interface MarkerEntry {
    marker: L.Marker;
    group: CoincidentGroup;
  }

  let articleMarkers = new Map<string, MarkerEntry>();
  let highlightedTitle: string | null = null;

  function groupIcon(
    group: CoincidentGroup,
    isHighlighted: boolean,
  ): L.Icon | L.DivIcon {
    if (group.members.length === 1) {
      return isHighlighted ? wikiPinHighlightIcon : wikiPinIcon;
    }
    return isHighlighted
      ? wikiPinClusterHighlightIcon(group.members.length)
      : wikiPinClusterIcon(group.members.length);
  }

  /**
   * Popup listing every co-located article, opened on a cluster marker click.
   * Shares `createMemberRows` (and the `.cluster-member-row` styling) with the
   * infinite list's "+N more here" popover so clusters look the same wherever
   * they're opened.
   */
  function openGroupPopup(group: CoincidentGroup): void {
    const content = document.createElement("div");
    content.className = "cluster-popup-content";
    // `popup` is referenced by the row handlers below before its own
    // declaration, but they only run later (on a real click), by which time
    // the assignment has long completed.
    const rows = createMemberRows(group.members, (member) => {
      onSelectArticle(member);
      popup.close();
    });
    for (const row of rows) content.appendChild(row);
    const popup = L.popup()
      .setLatLng([group.lat, group.lon])
      .setContent(content)
      .openOn(map);
  }

  function buildMarkerEntry(
    group: CoincidentGroup,
    isHighlighted: boolean,
  ): MarkerEntry {
    const marker = L.marker([group.lat, group.lon], {
      icon: groupIcon(group, isHighlighted),
      zIndexOffset: isHighlighted ? 1000 : 0,
    }).addTo(map);

    if (group.members.length === 1) {
      const only = group.representative;
      marker.bindTooltip(only.title);
      marker.on("click", () => onSelectArticle(only));
    } else {
      marker.bindTooltip(`${group.members.length} articles here`);
      marker.on("click", () => openGroupPopup(group));
    }
    return { marker, group };
  }

  function updateMarkers(newArticles: NearbyArticle[]): void {
    for (const entry of new Set(articleMarkers.values())) entry.marker.remove();
    articleMarkers = new Map();
    for (const group of collapseCoincident(newArticles)) {
      const isHighlighted = group.members.some(
        (member) => member.title === highlightedTitle,
      );
      const entry = buildMarkerEntry(group, isHighlighted);
      for (const member of group.members) {
        articleMarkers.set(member.title, entry);
      }
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
      // Position / article set may have changed which tiles are loaded.
      xray?.refresh();
    },
    highlight(title) {
      // Remove previous highlight
      if (highlightedTitle) {
        const prev = articleMarkers.get(highlightedTitle);
        if (prev) {
          prev.marker.setIcon(groupIcon(prev.group, false));
          prev.marker.setZIndexOffset(0);
        }
      }
      highlightedTitle = title;
      // Apply new highlight
      if (title) {
        const entry = articleMarkers.get(title);
        if (entry) {
          entry.marker.setIcon(groupIcon(entry.group, true));
          entry.marker.setZIndexOffset(1000);
        }
      }
    },
    resize() {
      map.invalidateSize();
    },
    destroy() {
      removeResizeHandler();
      xray?.destroy();
      map.remove();
    },
  };
}
