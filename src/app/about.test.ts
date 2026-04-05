// @vitest-environment jsdom

import "./test-dialog-polyfill";
import { createAboutButton, hideAbout, showAbout } from "./about";

afterEach(() => {
  hideAbout();
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
});

describe("showAbout", () => {
  it("removes dialog from DOM when closed via X button", () => {
    showAbout();
    expect(document.querySelector("dialog.about-dialog")).not.toBeNull();

    const close = document.querySelector(".about-close") as HTMLButtonElement;
    close.click();

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("removes dialog from DOM when closed via Escape (cancel event)", () => {
    showAbout();
    expect(document.querySelector("dialog.about-dialog")).not.toBeNull();

    const dialog = document.querySelector(
      "dialog.about-dialog",
    ) as HTMLDialogElement;
    dialog.dispatchEvent(new Event("cancel"));

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("removes dialog from DOM on backdrop click", () => {
    showAbout();
    const dialog = document.querySelector(
      "dialog.about-dialog",
    ) as HTMLDialogElement;

    // Simulate a click on the dialog element at coordinates outside its bounds
    // (getBoundingClientRect returns zeros in jsdom, so clientX/Y of -1 are outside)
    dialog.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }),
    );

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("does not close on click inside dialog content", () => {
    showAbout();
    const title = document.querySelector(".about-dialog h2") as HTMLElement;

    // Click on child — target is not the dialog, so it should stay open
    title.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(document.querySelector("dialog.about-dialog")).not.toBeNull();
  });

  it("cleans up DOM after repeated open/close cycles", () => {
    for (let i = 0; i < 5; i++) {
      showAbout();
      const close = document.querySelector(".about-close") as HTMLButtonElement;
      close.click();
    }

    // All dialogs should be cleaned up — none left in DOM
    expect(document.querySelectorAll("dialog.about-dialog")).toHaveLength(0);
  });

  it("restores focus to the previously focused element on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();

    showAbout();

    const close = document.querySelector(".about-close") as HTMLButtonElement;
    close.click();

    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to .about-btn when original trigger is detached", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    showAbout();

    // Simulate a re-render removing the original trigger
    trigger.remove();

    // Place a new About button in the DOM (as a re-render would)
    const newBtn = document.createElement("button");
    newBtn.className = "about-btn";
    document.body.appendChild(newBtn);

    const close = document.querySelector(".about-close") as HTMLButtonElement;
    close.click();

    expect(document.activeElement).toBe(newBtn);
  });

  it("tears down existing dialog when called while one is already open", () => {
    showAbout();
    const firstDialog = document.querySelector("dialog.about-dialog");
    expect(firstDialog).not.toBeNull();

    showAbout();

    // First dialog should be removed, exactly one dialog remains
    expect(firstDialog!.isConnected).toBe(false);
    expect(document.querySelectorAll("dialog.about-dialog")).toHaveLength(1);
  });

  it("has aria-label on the dialog", () => {
    showAbout();
    const dialog = document.querySelector(
      "dialog.about-dialog",
    ) as HTMLDialogElement;
    expect(dialog.getAttribute("aria-label")).toBe("About");
  });

  describe("attribution content", () => {
    it("includes an Attribution heading", () => {
      showAbout();
      const heading = document.querySelector(".about-section h3");
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toBe("Attribution");
    });

    it("links to Creative Commons BY-SA 3.0 license", () => {
      showAbout();
      const links =
        document.querySelectorAll<HTMLAnchorElement>(".about-section a");
      const ccLink = Array.from(links).find((a) =>
        a.href.includes("creativecommons.org/licenses/by-sa/3.0"),
      );
      expect(ccLink).toBeDefined();
    });

    it("links to OpenStreetMap copyright", () => {
      showAbout();
      const links =
        document.querySelectorAll<HTMLAnchorElement>(".about-section a");
      const osmLink = Array.from(links).find((a) =>
        a.href.includes("openstreetmap.org/copyright"),
      );
      expect(osmLink).toBeDefined();
    });

    it("links to Wikipedia terms of use", () => {
      showAbout();
      const links =
        document.querySelectorAll<HTMLAnchorElement>(".about-section a");
      const wikiLink = Array.from(links).find(
        (a) =>
          a.href.includes("wikimedia.org") && a.href.includes("Terms_of_Use"),
      );
      expect(wikiLink).toBeDefined();
    });

    it("opens all links in a new tab with noopener noreferrer", () => {
      showAbout();
      const links =
        document.querySelectorAll<HTMLAnchorElement>(".about-dialog a");
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
      }
    });
  });

  describe("privacy content", () => {
    it("includes a Privacy heading", () => {
      showAbout();
      const headings = document.querySelectorAll(".about-section h3");
      const texts = Array.from(headings).map((h) => h.textContent);
      expect(texts).toContain("Privacy");
    });

    it("discloses that GPS coordinates are collected and stay on-device", () => {
      showAbout();
      const text =
        document.querySelector("dialog.about-dialog")?.textContent ?? "";
      expect(text).toMatch(/GPS coordinates/i);
      expect(text).toMatch(/never sent to any server/i);
    });

    it("discloses retention and how to revoke access", () => {
      showAbout();
      const text =
        document.querySelector("dialog.about-dialog")?.textContent ?? "";
      expect(text).toMatch(/held only in memory/i);
      expect(text).toMatch(/revoke location access/i);
    });
  });
});

describe("hideAbout", () => {
  it("removes dialog from DOM when called after showAbout", () => {
    showAbout();
    expect(document.querySelector("dialog.about-dialog")).not.toBeNull();

    hideAbout();

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("does not throw when no dialog is open", () => {
    expect(() => hideAbout()).not.toThrow();
  });
});

describe("createAboutButton", () => {
  it("returns a button that calls onClick handler on click", () => {
    const onClick = vi.fn();
    const btn = createAboutButton(onClick);

    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-label")).toBe("About");
    expect(btn.classList.contains("about-btn")).toBe(true);

    document.body.appendChild(btn);
    btn.click();

    expect(onClick).toHaveBeenCalledOnce();
  });
});
