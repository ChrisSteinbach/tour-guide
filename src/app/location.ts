import type { UserPosition } from "./types";

export interface LocationError {
  code: "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT";
  message: string;
}

export interface LocationCallbacks {
  onPosition: (position: UserPosition) => void;
  onError: (error: LocationError) => void;
}

/** Stop function returned by watchLocation. */
export type StopFn = () => void;

const ERROR_CODES: Record<number, LocationError["code"]> = {
  1: "PERMISSION_DENIED",
  2: "POSITION_UNAVAILABLE",
  3: "TIMEOUT",
};

/**
 * Watch the user's GPS position via the Geolocation API.
 * Returns a function that stops watching when called.
 */
export function watchLocation(callbacks: LocationCallbacks): StopFn {
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      callbacks.onPosition({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      });
    },
    (err) => {
      callbacks.onError({
        code: ERROR_CODES[err.code] ?? "POSITION_UNAVAILABLE",
        message: err.message,
      });
    },
    {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 5_000,
    },
  );

  return () => navigator.geolocation.clearWatch(watchId);
}
