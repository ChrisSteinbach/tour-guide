// @vitest-environment jsdom
import { resolveScrollContainer, forwardScrollCount } from "./compose-app";

describe("resolveScrollContainer", () => {
  it("returns infinite-scroll element when available", () => {
    const scrollEl = document.createElement("div");
    const app = document.createElement("div");

    const result = resolveScrollContainer(
      { scrollElement: () => scrollEl },
      app,
    );

    expect(result).toBe(scrollEl);
  });

  it("falls back to .app-scroll when infinite-scroll has no element", () => {
    const app = document.createElement("div");
    const appScroll = document.createElement("div");
    appScroll.className = "app-scroll";
    app.appendChild(appScroll);

    const result = resolveScrollContainer({ scrollElement: () => null }, app);

    expect(result).toBe(appScroll);
  });

  it("falls back to app element when no scroll wrapper exists", () => {
    const app = document.createElement("div");

    const result = resolveScrollContainer({ scrollElement: () => null }, app);

    expect(result).toBe(app);
  });
});

describe("forwardScrollCount", () => {
  // Pass-through group view: article count === group count (no clusters).
  const identityGroupView = { groupCountForArticleCount: (n: number) => n };

  it("forwards count when infinite scroll is active", () => {
    const update = vi.fn();

    forwardScrollCount({ isActive: () => true, update }, identityGroupView, 42);

    expect(update).toHaveBeenCalledWith(42);
  });

  it("skips update when infinite scroll is inactive", () => {
    const update = vi.fn();

    forwardScrollCount(
      { isActive: () => false, update },
      identityGroupView,
      42,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it("converts article-space counts to group space via the group view", () => {
    const update = vi.fn();
    // Simulate a cluster collapsing: knock 5 off every article count.
    forwardScrollCount(
      { isActive: () => true, update },
      { groupCountForArticleCount: (n: number) => n - 5 },
      42,
    );

    expect(update).toHaveBeenCalledWith(37);
  });
});
