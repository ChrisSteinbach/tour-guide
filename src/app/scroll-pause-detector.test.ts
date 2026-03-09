import { createScrollPauseDetector } from "./scroll-pause-detector";

function fakeScrollSource(initialScrollY = 0) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    scrollY: initialScrollY,
    addEventListener(event: string, handler: () => void) {
      (listeners[event] ??= []).push(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      const arr = listeners[event];
      if (arr) listeners[event] = arr.filter((h) => h !== handler);
    },
    fire(event: string) {
      for (const h of listeners[event] ?? []) h();
    },
    listenerCount(event: string) {
      return (listeners[event] ?? []).length;
    },
  };
}

function fakeContainer(opts: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    scrollTop: opts.scrollTop ?? 0,
    scrollHeight: opts.scrollHeight ?? 1000,
    clientHeight: opts.clientHeight ?? 500,
    addEventListener(event: string, handler: () => void) {
      (listeners[event] ??= []).push(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      const arr = listeners[event];
      if (arr) listeners[event] = arr.filter((h) => h !== handler);
    },
    fire(event: string) {
      for (const h of listeners[event] ?? []) h();
    },
    listenerCount(event: string) {
      return (listeners[event] ?? []).length;
    },
  };
}

describe("createScrollPauseDetector", () => {
  it("fires onPause when window scrollY exceeds threshold", () => {
    const source = fakeScrollSource(0);
    const calls: string[] = [];
    createScrollPauseDetector({
      threshold: 100,
      onPause: () => calls.push("paused"),
      scrollSource: source,
    });

    source.scrollY = 50;
    source.fire("scroll");
    expect(calls).toEqual([]);

    source.scrollY = 150;
    source.fire("scroll");
    expect(calls).toEqual(["paused"]);
  });

  it("fires only once even with repeated scrolls past threshold", () => {
    const source = fakeScrollSource(200);
    let count = 0;
    createScrollPauseDetector({
      threshold: 100,
      onPause: () => count++,
      scrollSource: source,
    });

    source.fire("scroll");
    source.fire("scroll");
    source.fire("scroll");
    expect(count).toBe(1);
  });

  it("removes listeners after firing", () => {
    const source = fakeScrollSource(200);
    createScrollPauseDetector({
      threshold: 100,
      onPause: () => {},
      scrollSource: source,
    });

    expect(source.listenerCount("scroll")).toBe(1);
    source.fire("scroll");
    expect(source.listenerCount("scroll")).toBe(0);
  });

  it("fires on container scroll when container is scrollable", () => {
    const source = fakeScrollSource(0);
    const container = fakeContainer({ scrollHeight: 1000, clientHeight: 500 });
    const calls: string[] = [];
    createScrollPauseDetector({
      threshold: 100,
      onPause: () => calls.push("paused"),
      scrollSource: source,
      container,
    });

    container.scrollTop = 150;
    container.fire("scroll");
    expect(calls).toEqual(["paused"]);
  });

  it("does not attach container listener when container is not scrollable", () => {
    const source = fakeScrollSource(0);
    const container = fakeContainer({ scrollHeight: 500, clientHeight: 500 });
    createScrollPauseDetector({
      threshold: 100,
      onPause: () => {},
      scrollSource: source,
      container,
    });

    expect(container.listenerCount("scroll")).toBe(0);
  });

  it("destroy removes all listeners without firing", () => {
    const source = fakeScrollSource(0);
    const container = fakeContainer({ scrollHeight: 1000, clientHeight: 500 });
    let called = false;
    const detector = createScrollPauseDetector({
      threshold: 100,
      onPause: () => {
        called = true;
      },
      scrollSource: source,
      container,
    });

    detector.destroy();
    source.scrollY = 200;
    source.fire("scroll");
    container.scrollTop = 200;
    container.fire("scroll");
    expect(called).toBe(false);
    expect(source.listenerCount("scroll")).toBe(0);
    expect(container.listenerCount("scroll")).toBe(0);
  });
});
