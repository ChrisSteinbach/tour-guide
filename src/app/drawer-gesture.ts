// Drag gesture handling for the map drawer.
// Uses PointerEvents for unified touch/mouse support.

export interface DrawerGestureOpts {
  panel: HTMLElement;
  handle: HTMLElement;
  /** Returns the drawer width for clamping (e.g. panel.offsetWidth or window.innerWidth). */
  getDrawerWidth: () => number;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** Velocity threshold in px/ms — swipes faster than this always snap. */
const VELOCITY_THRESHOLD = 0.5;
/** Position threshold as fraction of drawer width for slow drags. */
const POSITION_THRESHOLD = 0.5;

export function setupDrawerGesture(opts: DrawerGestureOpts): () => void {
  const { panel, handle, getDrawerWidth, open, close, isOpen } = opts;

  let startX = 0;
  let startTime = 0;
  let startOpen = false;
  let dragging = false;

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    startX = e.clientX;
    startTime = e.timeStamp;
    startOpen = isOpen();

    handle.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");

    // Remove open class during drag — we control transform directly
    panel.classList.remove("open");
    // Set initial transform to match current visual state
    const drawerWidth = getDrawerWidth();
    panel.style.transform = startOpen
      ? "translateX(0)"
      : `translateX(${drawerWidth}px)`;
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;

    const drawerWidth = getDrawerWidth();
    const deltaX = e.clientX - startX;

    // Calculate current translateX based on start state + drag delta
    const baseOffset = startOpen ? 0 : drawerWidth;
    const rawOffset = baseOffset + deltaX;

    // Clamp: 0 = fully open, drawerWidth = fully closed
    const clampedOffset = Math.max(0, Math.min(drawerWidth, rawOffset));
    panel.style.transform = `translateX(${clampedOffset}px)`;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;

    const drawerWidth = getDrawerWidth();
    const deltaX = e.clientX - startX;
    const deltaTime = e.timeStamp - startTime;
    const velocity = deltaTime > 0 ? deltaX / deltaTime : 0;

    // Calculate where the drawer ended up
    const baseOffset = startOpen ? 0 : drawerWidth;
    const rawOffset = baseOffset + deltaX;
    const clampedOffset = Math.max(0, Math.min(drawerWidth, rawOffset));
    const openFraction = 1 - clampedOffset / drawerWidth;

    // Remove inline transform and dragging class — let CSS transition take over
    panel.style.transform = "";
    panel.classList.remove("dragging");

    // Decide: velocity-based snap or position-based threshold
    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
      // Negative velocity = dragged left = opening
      if (velocity < 0) {
        open();
      } else {
        close();
      }
    } else {
      if (openFraction >= POSITION_THRESHOLD) {
        open();
      } else {
        close();
      }
    }
  }

  function onPointerCancel(_e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;

    // Snap back to original state
    panel.style.transform = "";
    panel.classList.remove("dragging");
    if (startOpen) {
      open();
    } else {
      close();
    }
  }

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerCancel);

  return function destroy(): void {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerCancel);
  };
}
