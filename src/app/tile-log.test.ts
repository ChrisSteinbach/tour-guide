import { recordTileLoad, getTileLoadLog, clearTileLoadLog } from "./tile-log";
import type { TileLoadRecord } from "./tile-log";

describe("tile-log", () => {
  afterEach(() => {
    clearTileLoadLog();
    vi.restoreAllMocks();
  });

  it("appends records and makes them readable via getTileLoadLog, in call order", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const first: TileLoadRecord = {
      at: 1000,
      lang: "en",
      id: "18-36",
      source: "cache",
      ok: true,
      ms: 12,
    };
    const second: TileLoadRecord = {
      at: 2000,
      lang: "sv",
      id: "29-39",
      source: "network",
      ok: true,
      ms: 2341,
      bytes: 3493888,
      attempts: 2,
    };

    recordTileLoad(first);
    recordTileLoad(second);

    expect(getTileLoadLog()).toEqual([first, second]);
  });

  it("caps the buffer at 100 entries, dropping the oldest first", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});

    for (let i = 0; i < 105; i++) {
      recordTileLoad({
        at: i,
        lang: "en",
        id: `tile-${i}`,
        source: "network",
        ok: true,
        ms: 1,
        bytes: 1,
        attempts: 1,
      });
    }

    const ids = getTileLoadLog().map((r) => r.id);
    const expectedIds = Array.from({ length: 100 }, (_, i) => `tile-${i + 5}`);
    expect(ids).toEqual(expectedIds);
  });

  it("empties the log via clearTileLoadLog", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    recordTileLoad({
      at: 1,
      lang: "en",
      id: "18-36",
      source: "cache",
      ok: true,
      ms: 1,
    });

    clearTileLoadLog();

    expect(getTileLoadLog()).toEqual([]);
  });

  it("logs via console.debug (not console.warn) when the load succeeded", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    recordTileLoad({
      at: 1,
      lang: "en",
      id: "18-36",
      source: "cache",
      ok: true,
      ms: 1,
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs via console.warn (not console.debug) when the load failed", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    recordTileLoad({
      at: 1,
      lang: "sv",
      id: "29-39",
      source: "network",
      ok: false,
      ms: 4210,
      attempts: 3,
      error: "HTTP 503",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
