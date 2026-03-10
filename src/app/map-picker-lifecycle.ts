// Map picker lifecycle manager: handles lazy-loading, creation,
// and teardown of the full-screen map picker overlay.
// All I/O boundaries are injected.

import type { MapPickerHandle } from "./map-picker";

export interface MapPickerLifecycleDeps {
  container: HTMLElement;
  appName: string;
  getPosition: () => { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
  importMapPicker: () => Promise<{
    createMapPicker: (
      el: HTMLElement,
      opts: {
        onPick: (lat: number, lon: number) => void;
        center?: { lat: number; lon: number };
      },
    ) => MapPickerHandle;
  }>;
}

export interface MapPickerLifecycle {
  show(): void;
  destroy(): void;
}

export function createMapPickerLifecycle(
  deps: MapPickerLifecycleDeps,
): MapPickerLifecycle {
  let handle: MapPickerHandle | null = null;

  function destroy(): void {
    if (handle) {
      handle.destroy();
      handle = null;
    }
  }

  function show(): void {
    destroy();

    const { container } = deps;
    container.textContent = "";

    const header = document.createElement("header");
    header.className = "app-header";
    const h1 = document.createElement("h1");
    h1.textContent = deps.appName;
    header.appendChild(h1);

    const instructions = document.createElement("p");
    instructions.className = "map-picker-instructions";
    instructions.textContent = "Tap the map to place a marker, then confirm.";

    const mapContainer = document.createElement("div");
    mapContainer.className = "map-picker-container";
    const mapEl = document.createElement("div");
    mapEl.className = "map-picker-map";
    mapContainer.appendChild(mapEl);

    container.append(header, instructions, mapContainer);

    void deps
      .importMapPicker()
      .then(({ createMapPicker }) => {
        handle = createMapPicker(mapEl, {
          onPick: (lat, lon) => {
            destroy();
            deps.onPick(lat, lon);
          },
          center: deps.getPosition() ?? undefined,
        });
      })
      .catch(() => {
        mapContainer.textContent = "";
        const msg = document.createElement("p");
        msg.className = "status-message";
        msg.textContent = "Failed to load the map. Check your connection.";
        const retryBtn = document.createElement("button");
        retryBtn.className = "status-action";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", show);
        mapContainer.append(msg, retryBtn);
      });
  }

  return { show, destroy };
}
