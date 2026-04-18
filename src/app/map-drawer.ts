// Map drawer: a slide-in panel from the right edge of the screen.
// The drawer hosts the map container (rendered by a separate lifecycle).

import { setupDrawerGesture } from "./drawer-gesture";
import { createFoldedMapIcon } from "./icons";

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

  const icon = createFoldedMapIcon();
  icon.setAttribute("class", "map-drawer-icon");
  handle.appendChild(icon);

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
    if (isOpen()) {
      close();
    } else {
      open();
    }
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
