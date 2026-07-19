// Shared UI for expanding a coincident cluster into its member articles.
//
// `createMemberRows` renders the tappable member list reused by both the map's
// Leaflet cluster popup (browse-map.ts) and the infinite-list "+N more here"
// popover below, so co-located articles look and behave the same wherever a
// cluster is opened.
//
// `openClusterPopover` is the infinite-list affordance: a lightweight
// viewport-anchored panel. The virtual scroll recycles rows on every scroll, so
// the popover lives on <body> (not inside the recycled row) and closes on any
// scroll/resize/outside-tap — the same "dismiss on interaction" contract the
// map popup follows.

import type { NearbyArticle } from "./types";

/**
 * Build one tappable button per member. Each fires `onActivate(member)` on
 * click; callers add their own dismissal (close the popup/popover) around it.
 */
export function createMemberRows(
  members: NearbyArticle[],
  onActivate: (member: NearbyArticle) => void,
): HTMLButtonElement[] {
  return members.map((member) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cluster-member-row";
    row.textContent = member.title;
    row.addEventListener("click", () => onActivate(member));
    return row;
  });
}

export interface ClusterPopoverHandle {
  close(): void;
}

export interface OpenClusterPopoverOptions {
  /** Element the popover points at (the "+N more here" trigger). */
  anchor: HTMLElement;
  /** Co-located articles to list. */
  members: NearbyArticle[];
  /** Navigate to a member; the popover closes itself first. */
  onSelect: (member: NearbyArticle) => void;
  /** Scroll container to watch — scrolling it dismisses the popover. */
  scrollContainer?: HTMLElement | null;
}

// Only one cluster popover is open at a time. Opening a second (or any
// teardown) closes the first.
let active: ClusterPopoverHandle | null = null;

export function openClusterPopover(
  options: OpenClusterPopoverOptions,
): ClusterPopoverHandle {
  active?.close();

  const { anchor, members, onSelect, scrollContainer } = options;

  const panel = document.createElement("div");
  panel.className = "cluster-popover";
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "Articles at this location");

  const rows = createMemberRows(members, (member) => {
    close();
    onSelect(member);
  });
  for (const row of rows) {
    row.setAttribute("role", "menuitem");
    panel.appendChild(row);
  }

  document.body.appendChild(panel);
  position(panel, anchor);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", onScrollClose, true);
    scrollContainer?.removeEventListener("scroll", onScrollClose);
    panel.remove();
    if (active === handle) active = null;
    if (anchor.isConnected) anchor.setAttribute("aria-expanded", "false");
  }

  function onOutsidePointer(e: PointerEvent): void {
    const target = e.target as Node;
    if (panel.contains(target) || anchor.contains(target)) return;
    close();
  }

  // Dismiss when the page/list scrolls out from under the anchor, but NOT when
  // the popover's own overflow scrolls — the window listener is capture-phase,
  // so it also sees the panel's internal scroll unless we exclude it.
  function onScrollClose(e: Event): void {
    const target = e.target as Node | null;
    if (target && panel.contains(target)) return;
    close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    }
  }

  // Defer outside-pointer registration so the opening tap doesn't immediately
  // close the popover.
  requestAnimationFrame(() =>
    document.addEventListener("pointerdown", onOutsidePointer, true),
  );
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", close);
  // Capture window scroll (rows recycle out from under an anchored popover);
  // also watch the specific scroll container for desktop split-view.
  window.addEventListener("scroll", onScrollClose, true);
  scrollContainer?.addEventListener("scroll", onScrollClose);

  anchor.setAttribute("aria-expanded", "true");
  rows[0]?.focus();

  const handle: ClusterPopoverHandle = { close };
  active = handle;
  return handle;
}

/** Position `panel` under `anchor`, flipping up and clamping to the viewport. */
function position(panel: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const margin = 8;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = a.left;
  if (left + pw > vw - margin) left = vw - margin - pw;
  if (left < margin) left = margin;

  // Prefer below the anchor; flip above when it would overflow the viewport.
  let top = a.bottom + 4;
  if (top + ph > vh - margin && a.top - 4 - ph >= margin) {
    top = a.top - 4 - ph;
  }
  if (top < margin) top = margin;

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
