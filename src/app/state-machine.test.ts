import {
  transition,
  getNextTier,
  NEARBY_TIERS,
  REQUERY_DISTANCE_M,
  type AppState,
  type Event,
} from "./state-machine";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: { phase: "welcome" },
    query: null,
    position: null,
    currentLang: "en",
    loadGeneration: 0,
    loadingTiles: new Set(),
    downloadProgress: -1,
    pendingUpdate: null,
    updateDownloading: false,
    updateProgress: 0,
    ...overrides,
  };
}

describe("getNextTier", () => {
  it("returns the next tier for each valid count", () => {
    expect(getNextTier(10)).toBe(20);
    expect(getNextTier(20)).toBe(50);
    expect(getNextTier(50)).toBe(100);
  });

  it("returns undefined for the last tier", () => {
    expect(getNextTier(100)).toBeUndefined();
  });

  it("returns undefined for a count not in the tier list", () => {
    expect(getNextTier(7)).toBeUndefined();
  });
});

describe("NEARBY_TIERS", () => {
  it("is sorted ascending", () => {
    for (let i = 1; i < NEARBY_TIERS.length; i++) {
      expect(NEARBY_TIERS[i]).toBeGreaterThan(NEARBY_TIERS[i - 1]);
    }
  });
});

describe("REQUERY_DISTANCE_M", () => {
  it("is a positive number", () => {
    expect(REQUERY_DISTANCE_M).toBeGreaterThan(0);
  });
});

describe("transition", () => {
  it("returns the same state and no effects for an unhandled event", () => {
    const state = makeState();
    const event: Event = { type: "showMore" };

    const { next, effects } = transition(state, event);

    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
