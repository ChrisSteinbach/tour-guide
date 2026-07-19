// @vitest-environment jsdom

import { createMemberRows, openClusterPopover } from "./cluster-popover";
import type { NearbyArticle } from "./types";

const m1: NearbyArticle = { title: "First", lat: 1, lon: 1, distanceM: 10 };
const m2: NearbyArticle = { title: "Second", lat: 1, lon: 1, distanceM: 10 };

afterEach(() => {
  document.body.textContent = "";
});

describe("createMemberRows", () => {
  it("creates one tagged, classed button per member", () => {
    const rows = createMemberRows([m1, m2], vi.fn());

    expect(rows).toHaveLength(2);
    expect(rows[0].tagName).toBe("BUTTON");
    expect(rows[0].type).toBe("button");
    expect(rows[0].textContent).toBe("First");
    expect(rows[0].classList.contains("cluster-member-row")).toBe(true);
  });

  it("fires onActivate with the clicked member", () => {
    const onActivate = vi.fn();
    const rows = createMemberRows([m1, m2], onActivate);

    rows[1].click();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(m2);
  });
});

describe("openClusterPopover", () => {
  it("renders a menu of member rows anchored to the document body", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    openClusterPopover({ anchor, members: [m1, m2], onSelect: vi.fn() });

    expect(document.querySelector(".cluster-popover")).not.toBeNull();
    const rows = document.querySelectorAll(
      ".cluster-popover .cluster-member-row",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("First");
    expect(rows[1].textContent).toBe("Second");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("selecting a member notifies onSelect and closes the popover", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onSelect = vi.fn();

    openClusterPopover({ anchor, members: [m1, m2], onSelect });
    const rows = document.querySelectorAll<HTMLButtonElement>(
      ".cluster-popover .cluster-member-row",
    );
    rows[1].click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(m2);
    expect(document.querySelector(".cluster-popover")).toBeNull();
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    openClusterPopover({ anchor, members: [m1, m2], onSelect: vi.fn() });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.querySelector(".cluster-popover")).toBeNull();
  });

  it("closes when the tracked scroll container scrolls", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const scrollContainer = document.createElement("div");
    document.body.appendChild(scrollContainer);

    openClusterPopover({
      anchor,
      members: [m1, m2],
      onSelect: vi.fn(),
      scrollContainer,
    });
    scrollContainer.dispatchEvent(new Event("scroll"));

    expect(document.querySelector(".cluster-popover")).toBeNull();
  });

  it("stays open when its own content scrolls", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    openClusterPopover({ anchor, members: [m1, m2], onSelect: vi.fn() });
    const panel = document.querySelector<HTMLElement>(".cluster-popover")!;
    // The window scroll listener is capture-phase, so it also sees the panel's
    // internal scroll — it must ignore scrolls originating inside the popover.
    panel.dispatchEvent(new Event("scroll"));
    panel
      .querySelector<HTMLElement>(".cluster-member-row")!
      .dispatchEvent(new Event("scroll"));

    expect(document.querySelector(".cluster-popover")).not.toBeNull();
  });

  it("closes the previous popover when a new one opens", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    openClusterPopover({ anchor, members: [m1], onSelect: vi.fn() });
    openClusterPopover({ anchor, members: [m2], onSelect: vi.fn() });

    expect(document.querySelectorAll(".cluster-popover")).toHaveLength(1);
  });

  it("close() removes the popover from the DOM", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    const handle = openClusterPopover({
      anchor,
      members: [m1, m2],
      onSelect: vi.fn(),
    });
    handle.close();

    expect(document.querySelector(".cluster-popover")).toBeNull();
  });
});
