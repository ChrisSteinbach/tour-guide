// @vitest-environment jsdom
import { createCompassWatcher, headingFromEvent } from "./compass";

function orientationEvent(
  name: string,
  props: { alpha?: number | null; absolute?: boolean; webkit?: number },
): Event {
  const e = new Event(name);
  Object.assign(e, {
    alpha: props.alpha ?? null,
    absolute: props.absolute ?? false,
    ...(props.webkit !== undefined
      ? { webkitCompassHeading: props.webkit }
      : {}),
  });
  return e;
}

describe("headingFromEvent", () => {
  it("uses webkitCompassHeading directly when present (iOS)", () => {
    expect(headingFromEvent({ webkitCompassHeading: 123.5 })).toBe(123.5);
  });

  it("prefers webkitCompassHeading over alpha", () => {
    expect(
      headingFromEvent({ webkitCompassHeading: 90, absolute: true, alpha: 10 }),
    ).toBe(90);
  });

  it("rejects the iOS 'unreliable' sentinel (-1)", () => {
    expect(headingFromEvent({ webkitCompassHeading: -1 })).toBeNull();
  });

  it("converts absolute alpha to a compass heading (Android)", () => {
    expect(headingFromEvent({ absolute: true, alpha: 90 })).toBe(270);
  });

  it("treats absolute alpha 0 as due north", () => {
    expect(headingFromEvent({ absolute: true, alpha: 0 })).toBe(0);
  });

  it("ignores non-absolute alpha (arbitrary origin)", () => {
    expect(headingFromEvent({ absolute: false, alpha: 90 })).toBeNull();
  });

  it("returns null when the event carries no orientation data", () => {
    expect(headingFromEvent({})).toBeNull();
  });
});

describe("createCompassWatcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports headings from deviceorientation events after start", () => {
    const onHeading = vi.fn();
    const watcher = createCompassWatcher({ onHeading });
    watcher.start();

    window.dispatchEvent(
      orientationEvent("deviceorientation", { absolute: true, alpha: 45 }),
    );

    expect(onHeading).toHaveBeenCalledWith(315);
    watcher.stop();
  });

  it("ignores events that carry no usable heading", () => {
    const onHeading = vi.fn();
    const watcher = createCompassWatcher({ onHeading });
    watcher.start();

    window.dispatchEvent(
      orientationEvent("deviceorientation", { absolute: false, alpha: 45 }),
    );

    expect(onHeading).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("stops reporting after stop()", () => {
    const onHeading = vi.fn();
    const watcher = createCompassWatcher({ onHeading });
    watcher.start();
    watcher.stop();

    window.dispatchEvent(
      orientationEvent("deviceorientation", { absolute: true, alpha: 45 }),
    );

    expect(onHeading).not.toHaveBeenCalled();
  });

  it("listens on deviceorientationabsolute where the platform supports it", () => {
    const onHeading = vi.fn();
    (window as unknown as Record<string, unknown>).ondeviceorientationabsolute =
      null;
    const watcher = createCompassWatcher({ onHeading });
    watcher.start();

    window.dispatchEvent(
      orientationEvent("deviceorientationabsolute", {
        absolute: true,
        alpha: 100,
      }),
    );

    expect(onHeading).toHaveBeenCalledWith(260);
    watcher.stop();
    delete (window as unknown as Record<string, unknown>)
      .ondeviceorientationabsolute;
  });

  describe("permission gate", () => {
    it("does not need permission when the platform has no gate", () => {
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      expect(watcher.needsPermission()).toBe(false);
    });

    it("resolves true without prompting when there is no gate", async () => {
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      await expect(watcher.requestPermission()).resolves.toBe(true);
    });

    it("detects the iOS-style permission gate", () => {
      vi.stubGlobal("DeviceOrientationEvent", {
        requestPermission: vi.fn(),
      });
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      expect(watcher.needsPermission()).toBe(true);
    });

    it("resolves true when the user grants permission", async () => {
      vi.stubGlobal("DeviceOrientationEvent", {
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      await expect(watcher.requestPermission()).resolves.toBe(true);
    });

    it("resolves false when the user denies permission", async () => {
      vi.stubGlobal("DeviceOrientationEvent", {
        requestPermission: vi.fn().mockResolvedValue("denied"),
      });
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      await expect(watcher.requestPermission()).resolves.toBe(false);
    });

    it("resolves false when the prompt itself rejects", async () => {
      vi.stubGlobal("DeviceOrientationEvent", {
        requestPermission: vi.fn().mockRejectedValue(new Error("not allowed")),
      });
      const watcher = createCompassWatcher({ onHeading: vi.fn() });
      await expect(watcher.requestPermission()).resolves.toBe(false);
    });
  });
});
