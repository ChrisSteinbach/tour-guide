// @vitest-environment jsdom

import { createLangDropdown } from "./lang-dropdown";

afterEach(() => {
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
});

const flushRAF = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("createLangDropdown", () => {
  it("shows current language on the trigger button", () => {
    const dropdown = createLangDropdown("sv", () => {});
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    expect(trigger.textContent).toBe("SV");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Wikipedia language: Svenska",
    );
  });

  it("marks the current language as the active option", () => {
    const dropdown = createLangDropdown("ja", () => {});
    const active = dropdown.querySelector(".lang-option-active") as HTMLElement;
    expect(active.dataset.lang).toBe("ja");
    expect(active.getAttribute("aria-selected")).toBe("true");
  });

  it("listbox is hidden by default", () => {
    const dropdown = createLangDropdown("en", () => {});
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;
    expect(listbox.hidden).toBe(true);
    expect(
      dropdown.querySelector(".lang-trigger")!.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens listbox on trigger click", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;

    trigger.click();

    expect(listbox.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes listbox on second trigger click", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;

    trigger.click();
    trigger.click();

    expect(listbox.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a language on option click and closes", () => {
    const onLangChange = vi.fn();
    const dropdown = createLangDropdown("en", onLangChange);
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;

    trigger.click();
    const frOption = dropdown.querySelector('[data-lang="fr"]') as HTMLElement;
    frOption.click();

    expect(onLangChange).toHaveBeenCalledWith("fr");
    expect(listbox.hidden).toBe(true);
  });

  it("closes on outside click", async () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;

    trigger.click();
    await flushRAF();
    expect(listbox.hidden).toBe(false);

    document.body.dispatchEvent(new Event("click", { bubbles: true }));

    expect(listbox.hidden).toBe(true);
  });

  it("removes outside-click listener after wrapper is detached", async () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;

    // Open the dropdown — listener should be active
    trigger.click();
    await flushRAF();
    expect(listbox.hidden).toBe(false);

    // Outside click closes it and removes the listener
    document.body.dispatchEvent(new Event("click", { bubbles: true }));
    expect(listbox.hidden).toBe(true);

    // Detach the wrapper, re-open, and verify self-cleaning still works
    trigger.click();
    await flushRAF();
    dropdown.remove();
    const spy = vi.spyOn(document, "removeEventListener");
    document.body.dispatchEvent(new Event("click", { bubbles: true }));
    expect(spy).toHaveBeenCalledWith("click", expect.any(Function));
    spy.mockRestore();
  });

  it("opens listbox on ArrowDown from trigger and focuses first item", () => {
    const dropdown = createLangDropdown("fr", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");

    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    expect(listbox.hidden).toBe(false);
    expect(document.activeElement).toBe(items[0]);
  });

  it("opens listbox on ArrowUp from trigger and focuses last item", () => {
    const dropdown = createLangDropdown("fr", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");

    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    expect(listbox.hidden).toBe(false);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("moves focus down through options with ArrowDown", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");

    trigger.click();
    items[0].focus();

    items[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(items[1]);
  });

  it("wraps focus from last option to first on ArrowDown", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");
    const lastItem = items[items.length - 1];

    trigger.click();
    lastItem.focus();

    lastItem.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(items[0]);
  });

  it("moves focus up through options with ArrowUp", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");

    trigger.click();
    items[2].focus();

    items[2].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(document.activeElement).toBe(items[1]);
  });

  it("selects focused option on Enter and returns focus to trigger", () => {
    const onLangChange = vi.fn();
    const dropdown = createLangDropdown("en", onLangChange);
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;
    const deOption = dropdown.querySelector('[data-lang="de"]') as HTMLElement;

    trigger.click();
    deOption.focus();
    deOption.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(onLangChange).toHaveBeenCalledWith("de");
    expect(listbox.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("selects focused option on Space", () => {
    const onLangChange = vi.fn();
    const dropdown = createLangDropdown("en", onLangChange);
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const esOption = dropdown.querySelector('[data-lang="es"]') as HTMLElement;

    trigger.click();
    esOption.focus();
    esOption.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );

    expect(onLangChange).toHaveBeenCalledWith("es");
  });

  it("closes on Escape and returns focus to trigger", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;
    const listbox = dropdown.querySelector(".lang-listbox") as HTMLElement;
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");

    trigger.click();
    items[0].focus();
    items[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(listbox.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("updates active markers on click selection", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;

    trigger.click();
    const frOption = dropdown.querySelector('[data-lang="fr"]') as HTMLElement;
    frOption.click();

    const enOption = dropdown.querySelector('[data-lang="en"]') as HTMLElement;
    expect(enOption.classList.contains("lang-option-active")).toBe(false);
    expect(enOption.getAttribute("aria-selected")).toBe("false");
    expect(frOption.classList.contains("lang-option-active")).toBe(true);
    expect(frOption.getAttribute("aria-selected")).toBe("true");
  });

  it("updates active markers on keyboard selection", () => {
    const dropdown = createLangDropdown("en", () => {});
    document.body.appendChild(dropdown);
    const trigger = dropdown.querySelector(
      ".lang-trigger",
    ) as HTMLButtonElement;

    trigger.click();
    const deOption = dropdown.querySelector('[data-lang="de"]') as HTMLElement;
    deOption.focus();
    deOption.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    const enOption = dropdown.querySelector('[data-lang="en"]') as HTMLElement;
    expect(enOption.classList.contains("lang-option-active")).toBe(false);
    expect(enOption.getAttribute("aria-selected")).toBe("false");
    expect(deOption.classList.contains("lang-option-active")).toBe(true);
    expect(deOption.getAttribute("aria-selected")).toBe("true");
  });

  it("each option has a correct id attribute", () => {
    const dropdown = createLangDropdown("en", () => {});
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");
    for (const item of items) {
      expect(item.id).toBe(`lang-opt-${item.dataset.lang}`);
    }
  });

  it("options are focusable programmatically but not in tab order", () => {
    const dropdown = createLangDropdown("en", () => {});
    const items = dropdown.querySelectorAll<HTMLElement>("[data-lang]");
    for (const item of items) {
      expect(item.tabIndex).toBe(-1);
    }
  });
});
