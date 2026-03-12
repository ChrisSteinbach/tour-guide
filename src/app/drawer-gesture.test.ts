// @vitest-environment jsdom
import { setupDrawerGesture } from "./drawer-gesture";

// jsdom lacks PointerEvent — polyfill it from MouseEvent
if (typeof globalThis.PointerEvent === "undefined") {
  (globalThis as Record<string, unknown>).PointerEvent =
    class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init?: PointerEventInit) {
        super(type, init);
        this.pointerId = init?.pointerId ?? 0;
      }
    };
}

function pointerEvent(
  type: string,
  opts: { clientX: number; timeStamp?: number },
): PointerEvent {
  const e = new PointerEvent(type, {
    clientX: opts.clientX,
    pointerId: 1,
    bubbles: true,
  });
  if (opts.timeStamp !== undefined) {
    Object.defineProperty(e, "timeStamp", { value: opts.timeStamp });
  }
  return e;
}

function createDrawer() {
  const panel = document.createElement("div");
  panel.className = "map-drawer";
  const handle = document.createElement("div");
  handle.className = "map-drawer-handle";
  panel.appendChild(handle);
  document.body.appendChild(panel);

  // Stub setPointerCapture/releasePointerCapture (jsdom doesn't support them)
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();

  let opened = false;
  const drawerWidth = 400;

  const destroy = setupDrawerGesture({
    panel,
    handle,
    getDrawerWidth: () => drawerWidth,
    open: () => {
      opened = true;
      panel.classList.add("open");
    },
    close: () => {
      opened = false;
      panel.classList.remove("open");
    },
    isOpen: () => opened,
  });

  return { panel, handle, destroy, isOpen: () => opened, drawerWidth };
}

afterEach(() => {
  while (document.body.firstChild) document.body.firstChild.remove();
});

describe("drawer gesture", () => {
  it("drag left past 50% threshold opens the drawer", () => {
    const { handle, isOpen, drawerWidth } = createDrawer();

    // Start drag at right edge (closed state)
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    // Drag left past 50% of drawer width
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 380 - drawerWidth * 0.6,
        timeStamp: 500,
      }),
    );
    // Release slowly (low velocity)
    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 380 - drawerWidth * 0.6,
        timeStamp: 500,
      }),
    );

    expect(isOpen()).toBe(true);
  });

  it("drag left under 50% threshold snaps back closed", () => {
    const { handle, isOpen, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 380 - drawerWidth * 0.3,
        timeStamp: 500,
      }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 380 - drawerWidth * 0.3,
        timeStamp: 500,
      }),
    );

    expect(isOpen()).toBe(false);
  });

  it("fast swipe left opens regardless of distance", () => {
    const { handle, isOpen } = createDrawer();

    // Fast swipe: small distance but very short time → high velocity
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 350, timeStamp: 20 }),
    );
    // velocity = -30 / 20 = -1.5 px/ms (exceeds 0.5 threshold, negative = left)
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 350, timeStamp: 20 }),
    );

    expect(isOpen()).toBe(true);
  });

  it("fast swipe right closes regardless of distance", () => {
    const { handle, isOpen } = createDrawer();

    // Open with a fast swipe left first
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 350, timeStamp: 20 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 350, timeStamp: 20 }),
    );
    expect(isOpen()).toBe(true);

    // Now swipe right fast to close
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 100, timeStamp: 1000 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 130, timeStamp: 1020 }),
    );
    // velocity = 30 / 20 = 1.5 px/ms (positive = right = close)
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 130, timeStamp: 1020 }),
    );

    expect(isOpen()).toBe(false);
  });

  it("click toggles drawer open and closed", () => {
    const { handle, isOpen } = createDrawer();

    // Click (pointerdown + pointerup + click with no movement) → opens
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 380, timeStamp: 100 }),
    );
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(true);

    // Click again → closes
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 200 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 380, timeStamp: 300 }),
    );
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it("adds dragging class only after movement past threshold", () => {
    const { handle, panel } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    // No dragging class yet — haven't moved
    expect(panel.classList.contains("dragging")).toBe(false);

    // Small move within click threshold — still no dragging
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 378, timeStamp: 25 }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);

    // Move past threshold
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 300, timeStamp: 50 }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 300, timeStamp: 500 }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);
  });

  it("clamps drag to valid range", () => {
    const { handle, panel, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    // Drag way past fully open (negative offset)
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 380 - drawerWidth * 2,
        timeStamp: 50,
      }),
    );

    // Transform should be clamped to translateX(0) (fully open)
    expect(panel.style.transform).toBe("translateX(0px)");

    handle.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 380 - drawerWidth * 2,
        timeStamp: 500,
      }),
    );
  });

  it("clamps drag to not exceed fully closed", () => {
    const { handle, panel, drawerWidth } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    // Drag right past fully closed
    handle.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 380 + drawerWidth,
        timeStamp: 50,
      }),
    );

    // Transform should be clamped to drawerWidth (fully closed)
    expect(panel.style.transform).toBe(`translateX(${drawerWidth}px)`);

    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 380 + drawerWidth, timeStamp: 500 }),
    );
  });

  it("removes inline transform after release", () => {
    const { handle, panel } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 300, timeStamp: 50 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointerup", { clientX: 300, timeStamp: 500 }),
    );

    expect(panel.style.transform).toBe("");
  });

  it("destroy removes event listeners", () => {
    const { handle, panel, destroy } = createDrawer();

    destroy();

    // Dispatching events should have no effect
    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    expect(panel.classList.contains("dragging")).toBe(false);
  });

  it("ignores second pointer while first gesture is active", () => {
    const { handle, panel, isOpen } = createDrawer();

    // First finger starts drag
    const down1 = new PointerEvent("pointerdown", {
      clientX: 380,
      pointerId: 1,
      bubbles: true,
    });
    Object.defineProperty(down1, "timeStamp", { value: 0 });
    handle.dispatchEvent(down1);

    handle.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 350,
        pointerId: 1,
        bubbles: true,
      }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    // Second finger tries to start — should be ignored
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 200,
        pointerId: 2,
        bubbles: true,
      }),
    );

    // Move from second pointer — should be ignored
    handle.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 500,
        pointerId: 2,
        bubbles: true,
      }),
    );

    // Up from second pointer — should be ignored, gesture still active
    handle.dispatchEvent(
      new PointerEvent("pointerup", {
        clientX: 500,
        pointerId: 2,
        bubbles: true,
      }),
    );
    expect(panel.classList.contains("dragging")).toBe(true);

    // First pointer finishes with a fast swipe left to open
    const up = new PointerEvent("pointerup", {
      clientX: 350,
      pointerId: 1,
      bubbles: true,
    });
    Object.defineProperty(up, "timeStamp", { value: 20 });
    handle.dispatchEvent(up);

    expect(panel.classList.contains("dragging")).toBe(false);
    expect(isOpen()).toBe(true);
  });

  it("pointercancel restores original state", () => {
    const { handle, panel, isOpen } = createDrawer();

    handle.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 380, timeStamp: 0 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointermove", { clientX: 200, timeStamp: 50 }),
    );
    handle.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 200, timeStamp: 100 }),
    );

    expect(panel.classList.contains("dragging")).toBe(false);
    expect(panel.style.transform).toBe("");
    // Was closed initially, should stay closed
    expect(isOpen()).toBe(false);
  });
});
