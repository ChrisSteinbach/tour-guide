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
  destroy(): void;
}

export function createMapDrawer(
  container: HTMLElement,
  isDesktop: () => boolean,
): MapDrawer {
  const panel = document.createElement("div");
  panel.className = "map-drawer";

  const handle = document.createElement("div");
  handle.className = "map-drawer-handle";
  handle.setAttribute("aria-label", "Toggle map drawer");

  const grip = document.createElement("div");
  grip.className = "map-drawer-grip";
  handle.appendChild(grip);

  const content = document.createElement("div");
  content.className = "map-drawer-content";

  panel.appendChild(handle);
  panel.appendChild(content);
  container.appendChild(panel);

  // Set initial state
  if (isDesktop()) {
    panel.classList.add("open");
  }

  function open(): void {
    panel.classList.add("open");
  }

  function close(): void {
    panel.classList.remove("open");
  }

  function toggle(): void {
    panel.classList.toggle("open");
  }

  function isOpen(): boolean {
    return panel.classList.contains("open");
  }

  const destroyGesture = setupDrawerGesture({
    panel,
    handle,
    getDrawerWidth: () => panel.offsetWidth || window.innerWidth,
    open,
    close,
    isOpen,
  });

  function destroy(): void {
    destroyGesture();
    panel.remove();
  }

  return { open, close, toggle, isOpen, element: content, destroy };
}
