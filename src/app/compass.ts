// Compass heading via DeviceOrientation events.
//
// Platform notes:
// - iOS Safari exposes the true compass heading as the non-standard
//   `webkitCompassHeading` on `deviceorientation` events, gated behind
//   `DeviceOrientationEvent.requestPermission()` which must be called
//   from a user gesture.
// - Chromium on Android fires `deviceorientationabsolute` where
//   `360 - alpha` is the compass heading.
// - Desktops typically fire nothing; the watcher then never reports a
//   heading and callers stay in north-up mode.

/** iOS extension: compass heading in degrees, or -1 when unreliable. */
interface OrientationEventLike {
  absolute?: boolean;
  alpha?: number | null;
  webkitCompassHeading?: number;
}

/** Static side of DeviceOrientationEvent with the iOS permission gate. */
interface OrientationEventStatic {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/**
 * Extract a compass heading (degrees clockwise from north, [0, 360))
 * from a device-orientation event, or null when the event carries no
 * trustworthy absolute heading.
 */
export function headingFromEvent(e: OrientationEventLike): number | null {
  if (typeof e.webkitCompassHeading === "number") {
    return e.webkitCompassHeading >= 0 ? e.webkitCompassHeading % 360 : null;
  }
  if (e.absolute === true && typeof e.alpha === "number") {
    return (360 - e.alpha + 360) % 360;
  }
  return null;
}

export interface CompassWatcher {
  /** Begin listening for orientation events. Idempotent. */
  start(): void;
  /** Stop listening. Idempotent. */
  stop(): void;
  /** True when the platform gates compass access behind a permission prompt (iOS). */
  needsPermission(): boolean;
  /** Request compass permission (must be called from a user gesture). */
  requestPermission(): Promise<boolean>;
}

export interface CompassWatcherDeps {
  /** Called with each new heading in degrees clockwise from north. */
  onHeading: (headingDeg: number) => void;
  /** Injectable for tests; defaults to the global window. */
  win?: Window;
}

export function createCompassWatcher(deps: CompassWatcherDeps): CompassWatcher {
  const win = deps.win ?? window;
  // Prefer the absolute event where supported (Chromium); elsewhere fall
  // back to plain deviceorientation (iOS, which marks compass headings
  // via webkitCompassHeading instead of the `absolute` flag).
  const eventName =
    "ondeviceorientationabsolute" in win
      ? "deviceorientationabsolute"
      : "deviceorientation";
  let listening = false;

  const handler = (e: Event): void => {
    const heading = headingFromEvent(e as OrientationEventLike);
    if (heading !== null) deps.onHeading(heading);
  };

  function start(): void {
    if (listening) return;
    listening = true;
    win.addEventListener(eventName, handler);
  }

  function stop(): void {
    if (!listening) return;
    listening = false;
    win.removeEventListener(eventName, handler);
  }

  function permissionGate(): OrientationEventStatic | null {
    const ctor = (
      win as unknown as {
        DeviceOrientationEvent?: OrientationEventStatic;
      }
    ).DeviceOrientationEvent;
    return ctor && typeof ctor.requestPermission === "function" ? ctor : null;
  }

  function needsPermission(): boolean {
    return permissionGate() !== null;
  }

  async function requestPermission(): Promise<boolean> {
    const gate = permissionGate();
    if (!gate?.requestPermission) return true;
    try {
      return (await gate.requestPermission()) === "granted";
    } catch {
      // Rejected outside a user gesture, or the user dismissed the prompt.
      return false;
    }
  }

  return { start, stop, needsPermission, requestPermission };
}
