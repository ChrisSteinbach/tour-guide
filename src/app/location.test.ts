import { watchLocation } from "./location";
import type { LocationError } from "./location";
import type { UserPosition } from "./types";

function createMockGeolocation() {
  let successCb: PositionCallback | null = null;
  let errorCb: PositionErrorCallback | null = null;
  const clearWatch = vi.fn();

  const geolocation = {
    watchPosition: vi.fn(
      (onSuccess: PositionCallback, onError?: PositionErrorCallback | null) => {
        successCb = onSuccess;
        errorCb = onError ?? null;
        return 42; // watchId
      },
    ),
    clearWatch,
  };

  return {
    geolocation,
    clearWatch,
    firePosition(lat: number, lon: number) {
      successCb!({
        coords: { latitude: lat, longitude: lon },
      } as GeolocationPosition);
    },
    fireError(code: number, message: string) {
      errorCb!({ code, message } as GeolocationPositionError);
    },
  };
}

describe("watchLocation", () => {
  let savedNavigator: typeof globalThis.navigator;

  beforeEach(() => {
    savedNavigator = globalThis.navigator;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: savedNavigator,
      configurable: true,
      writable: true,
    });
  });

  function installMockGeolocation() {
    const mock = createMockGeolocation();
    Object.defineProperty(globalThis, "navigator", {
      value: { geolocation: mock.geolocation },
      configurable: true,
      writable: true,
    });
    return mock;
  }

  it("calls onPosition with lat/lon from the Geolocation API", () => {
    const mock = installMockGeolocation();

    const onPosition = vi.fn<(pos: UserPosition) => void>();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition, onError });

    mock.firePosition(48.8584, 2.2945);

    expect(onPosition).toHaveBeenCalledWith({ lat: 48.8584, lon: 2.2945 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError with mapped error code on PERMISSION_DENIED", () => {
    const mock = installMockGeolocation();

    const onPosition = vi.fn<(pos: UserPosition) => void>();
    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition, onError });

    mock.fireError(1, "User denied Geolocation");

    expect(onError).toHaveBeenCalledWith({
      code: "PERMISSION_DENIED",
      message: "User denied Geolocation",
    });
    expect(onPosition).not.toHaveBeenCalled();
  });

  it("maps POSITION_UNAVAILABLE (code 2) correctly", () => {
    const mock = installMockGeolocation();

    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError });

    mock.fireError(2, "Position unavailable");

    expect(onError).toHaveBeenCalledWith({
      code: "POSITION_UNAVAILABLE",
      message: "Position unavailable",
    });
  });

  it("maps TIMEOUT (code 3) correctly", () => {
    const mock = installMockGeolocation();

    const onError = vi.fn<(err: LocationError) => void>();
    watchLocation({ onPosition: vi.fn(), onError });

    mock.fireError(3, "Timeout expired");

    expect(onError).toHaveBeenCalledWith({
      code: "TIMEOUT",
      message: "Timeout expired",
    });
  });

  it("returns a stop function that calls clearWatch", () => {
    const mock = installMockGeolocation();

    const stop = watchLocation({ onPosition: vi.fn(), onError: vi.fn() });
    expect(mock.clearWatch).not.toHaveBeenCalled();

    stop();
    expect(mock.clearWatch).toHaveBeenCalledWith(42);
  });

  it("passes correct options to watchPosition", () => {
    const mock = installMockGeolocation();

    watchLocation({ onPosition: vi.fn(), onError: vi.fn() });

    expect(mock.geolocation.watchPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 5_000,
      },
    );
  });
});
