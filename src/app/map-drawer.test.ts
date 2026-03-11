// @vitest-environment jsdom
import { createMapDrawer } from "./map-drawer";

describe("createMapDrawer", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("starts open on desktop", () => {
    const drawer = createMapDrawer(container, () => true);
    expect(drawer.isOpen()).toBe(true);
    expect(
      container.querySelector(".map-drawer")?.classList.contains("open"),
    ).toBe(true);
  });

  it("starts closed on mobile", () => {
    const drawer = createMapDrawer(container, () => false);
    expect(drawer.isOpen()).toBe(false);
    expect(
      container.querySelector(".map-drawer")?.classList.contains("open"),
    ).toBe(false);
  });

  it("open() opens the drawer", () => {
    const drawer = createMapDrawer(container, () => false);
    drawer.open();
    expect(drawer.isOpen()).toBe(true);
  });

  it("close() closes the drawer", () => {
    const drawer = createMapDrawer(container, () => true);
    drawer.close();
    expect(drawer.isOpen()).toBe(false);
  });

  it("toggle() flips the state", () => {
    const drawer = createMapDrawer(container, () => false);
    drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
    drawer.toggle();
    expect(drawer.isOpen()).toBe(false);
  });

  it("exposes the content element", () => {
    const drawer = createMapDrawer(container, () => true);
    expect(drawer.element).toBeInstanceOf(HTMLElement);
    expect(drawer.element.classList.contains("map-drawer-content")).toBe(true);
  });

  it("has a handle element in the DOM", () => {
    createMapDrawer(container, () => true);
    const handle = container.querySelector(".map-drawer-handle");
    expect(handle).not.toBeNull();
    expect(handle?.querySelector(".map-drawer-grip")).not.toBeNull();
  });

  it("destroy() removes DOM elements", () => {
    const drawer = createMapDrawer(container, () => true);
    expect(container.querySelector(".map-drawer")).not.toBeNull();
    drawer.destroy();
    expect(container.querySelector(".map-drawer")).toBeNull();
  });
});
