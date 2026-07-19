// @vitest-environment jsdom
import {
  resolveScrollContainer,
  createScrollCountForwarder,
} from "./compose-app";

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

describe("createScrollCountForwarder", () => {
  // Pass-through group view: article count === group count (no clusters).
  const identityGroupView = { groupCountForArticleCount: (n: number) => n };

  it("forwards count when infinite scroll is active", () => {
    const update = vi.fn();
    const forwarder = createScrollCountForwarder(
      { isActive: () => true, update },
      identityGroupView,
    );

    forwarder(42, 30);

    expect(update).toHaveBeenCalledWith(42, 30);
  });

  it("skips update when infinite scroll is inactive", () => {
    const update = vi.fn();
    const forwarder = createScrollCountForwarder(
      { isActive: () => false, update },
      identityGroupView,
    );

    forwarder(42, 30);

    expect(update).not.toHaveBeenCalled();
  });

  it("converts article-space counts to group space via the group view", () => {
    const update = vi.fn();
    // Simulate a cluster collapsing: knock 5 off every article count.
    const forwarder = createScrollCountForwarder(
      { isActive: () => true, update },
      { groupCountForArticleCount: (n) => n - 5 },
    );

    forwarder(42, 30);

    expect(update).toHaveBeenCalledWith(37, 25);
  });

  it("passes an undefined anchor through without converting", () => {
    const update = vi.fn();
    const forwarder = createScrollCountForwarder(
      { isActive: () => true, update },
      { groupCountForArticleCount: (n) => n - 5 },
    );

    forwarder(42, undefined);

    expect(update).toHaveBeenCalledWith(37, undefined);
  });
});
