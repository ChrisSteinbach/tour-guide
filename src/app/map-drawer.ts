// Map drawer: a slide-in panel from the right edge of the screen.
// The drawer hosts the map container (rendered by a separate lifecycle).

import { setupDrawerGesture } from "./drawer-gesture";

export interface MapDrawer {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** The content area where the map will be rendered. */
  element: HTMLElement;
  /** The drawer panel element (.map-drawer). */
  panel: HTMLElement;
  destroy(): void;
}

export function createMapDrawer(container: HTMLElement): MapDrawer {
  const panel = document.createElement("div");
  panel.className = "map-drawer";

  const handle = document.createElement("button");
  handle.className = "map-drawer-handle";
  handle.setAttribute("aria-label", "Toggle map drawer");
  handle.setAttribute("aria-expanded", "false");
  handle.type = "button";

  // Chevron SVG — points left (open=visible) or right (closed)
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "map-drawer-chevron");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const polyline = document.createElementNS(ns, "polyline");
  polyline.setAttribute("points", "15 18 9 12 15 6");
  svg.appendChild(polyline);
  handle.appendChild(svg);

  const content = document.createElement("div");
  content.className = "map-drawer-content";

  panel.appendChild(handle);
  panel.appendChild(content);
  container.appendChild(panel);

  function open(): void {
    panel.classList.add("open");
    handle.setAttribute("aria-expanded", "true");
  }

  function close(): void {
    panel.classList.remove("open");
    handle.setAttribute("aria-expanded", "false");
  }

  function toggle(): void {
    panel.classList.toggle("open");
    handle.setAttribute("aria-expanded", String(isOpen()));
  }

  function isOpen(): boolean {
    return panel.classList.contains("open");
  }

  const destroyGesture = setupDrawerGesture({
    panel,
    handle,
    getDrawerWidth: () => panel.offsetWidth,
    open,
    close,
    isOpen,
  });

  function destroy(): void {
    destroyGesture();
    panel.remove();
  }

  return { open, close, toggle, isOpen, element: content, panel, destroy };
}
