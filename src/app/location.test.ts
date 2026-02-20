import { watchLocation } from "./location";
import type { LocationError } from "./location";
import type { UserPosition } from "./types";

function fakeGeo() {
  let onSuccess: PositionCallback;
  let onError: PositionErrorCallback;
  const clearWatch = vi.fn();

  return {
    watchPosition(
      success: PositionCallback,
      error?: PositionErrorCallback | null,
    ) {
      onSuccess = success;
      onError = error!;
      return 1;
    },
    clearWatch,
    firePosition(lat: number, lon: number) {
      onSuccess({
        coords: { latitude: lat, longitude: lon },
      } as GeolocationPosition);
    },
    fireError(code: number, message = "") {
      onError({ code, message } as GeolocationPositionError);
    },
  };
}

describe("watchLocation", () => {
  it("maps position to lat/lon", () => {
    const geo = fakeGeo();
    const onPosition = vi.fn<(pos: UserPosition) => void>();
    watchLocation({ onPosition, onError: vi.fn() }, geo);

    geo.firePosition(48.8584, 2.2945);

    expect(onPosition).toHaveBeenCalledWith({ lat: 48.8584, lon: 2.2945 });
  });

  it("maps error code 1 to PERMISSION_DENIED", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(1, "denied");

    expect(onError).toHaveBeenCalledWith({
      code: "PERMISSION_DENIED",
      message: "denied",
    });
  });

  it("maps error code 2 to POSITION_UNAVAILABLE", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(2, "unavailable");

    expect(onError).toHaveBeenCalledWith({
      code: "POSITION_UNAVAILABLE",
      message: "unavailable",
    });
  });

  it("maps error code 3 to TIMEOUT", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(3, "timed out");

    expect(onError).toHaveBeenCalledWith({
      code: "TIMEOUT",
      message: "timed out",
    });
  });

  it("falls back to POSITION_UNAVAILABLE for unknown error codes", () => {
    const geo = fakeGeo();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError }, geo);

    geo.fireError(99, "something weird");

    expect(onError).toHaveBeenCalledWith({
      code: "POSITION_UNAVAILABLE",
      message: "something weird",
    });
  });

  it("returned stop function clears the watch", () => {
    const geo = fakeGeo();
    const stop = watchLocation({ onPosition: vi.fn(), onError: vi.fn() }, geo);

    stop();

    expect(geo.clearWatch).toHaveBeenCalledWith(1);
  });
});
