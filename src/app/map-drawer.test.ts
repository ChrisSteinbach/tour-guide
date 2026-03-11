// @vitest-environment jsdom
import { createMapDrawer } from "./map-drawer";

describe("createMapDrawer", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("starts closed", () => {
    const drawer = createMapDrawer(container);
    expect(drawer.isOpen()).toBe(false);
  });

  it("open() opens the drawer", () => {
    const drawer = createMapDrawer(container);
    drawer.open();
    expect(drawer.isOpen()).toBe(true);
  });

  it("close() closes the drawer", () => {
    const drawer = createMapDrawer(container);
    drawer.open();
    drawer.close();
    expect(drawer.isOpen()).toBe(false);
  });

  it("toggle() flips the state", () => {
    const drawer = createMapDrawer(container);
    drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
    drawer.toggle();
    expect(drawer.isOpen()).toBe(false);
  });

  it("exposes the content element", () => {
    const drawer = createMapDrawer(container);
    expect(drawer.element).toBeInstanceOf(HTMLElement);
    expect(drawer.element.classList.contains("map-drawer-content")).toBe(true);
  });

  it("exposes the panel element", () => {
    const drawer = createMapDrawer(container);
    expect(drawer.panel).toBeInstanceOf(HTMLElement);
    expect(drawer.panel.classList.contains("map-drawer")).toBe(true);
  });

  it("has a handle element with chevron in the DOM", () => {
    createMapDrawer(container);
    const handle = container.querySelector(".map-drawer-handle");
    expect(handle).not.toBeNull();
    expect(handle?.tagName).toBe("BUTTON");
    expect(handle?.querySelector(".map-drawer-chevron")).not.toBeNull();
  });

  it("sets aria-expanded on the handle", () => {
    const drawer = createMapDrawer(container);
    const handle = container.querySelector(".map-drawer-handle")!;
    expect(handle.getAttribute("aria-expanded")).toBe("false");

    drawer.open();
    expect(handle.getAttribute("aria-expanded")).toBe("true");

    drawer.close();
    expect(handle.getAttribute("aria-expanded")).toBe("false");

    drawer.toggle();
    expect(handle.getAttribute("aria-expanded")).toBe("true");

    drawer.toggle();
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  });

  it("destroy() removes DOM elements", () => {
    const drawer = createMapDrawer(container);
    expect(container.querySelector(".map-drawer")).not.toBeNull();
    drawer.destroy();
    expect(container.querySelector(".map-drawer")).toBeNull();
  });
});
