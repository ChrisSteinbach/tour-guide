// @vitest-environment jsdom

import { APP_NAME } from "./config";
import {
  renderWelcome,
  renderLoading,
  renderLoadingProgress,
  renderError,
  renderDataUnavailable,
} from "./status";
import type { LocationError } from "./location";

// ── renderWelcome ───────────────────────────────────────────

describe("renderWelcome", () => {
  it("calls onStart when start button is clicked", () => {
    const onStart = vi.fn();
    const container = document.createElement("div");
    renderWelcome(
      container,
      onStart,
      () => {},
      "en",
      () => {},
    );
    const btn = container.querySelector(".status-action") as HTMLButtonElement;
    btn.click();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("calls onPickLocation when pick-location button is clicked", () => {
    const onPickLocation = vi.fn();
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      onPickLocation,
      "en",
      () => {},
    );
    const btn = container.querySelector(
      ".welcome-pick-link",
    ) as HTMLButtonElement;
    btn.click();
    expect(onPickLocation).toHaveBeenCalledOnce();
  });

  it("language selector reflects currentLang", () => {
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "sv",
      () => {},
    );
    const select = container.querySelector(".lang-select") as HTMLSelectElement;
    expect(select.value).toBe("sv");
  });

  it("calls onLangChange when language is changed", () => {
    const onLangChange = vi.fn();
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "en",
      onLangChange,
    );
    const select = container.querySelector(".lang-select") as HTMLSelectElement;
    select.value = "ja";
    select.dispatchEvent(new Event("change"));
    expect(onLangChange).toHaveBeenCalledWith("ja");
  });

  it("renders the app header with app name", () => {
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "en",
      () => {},
    );
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe(APP_NAME);
  });

  it("renders a tagline message", () => {
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "en",
      () => {},
    );
    const msg = container.querySelector(".status-message");
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toMatch(/discover/i);
  });
});

// ── renderLoading ───────────────────────────────────────────

describe("renderLoading", () => {
  it("displays a loading message", () => {
    const container = document.createElement("div");
    renderLoading(container);
    const msg = container.querySelector(".status-message");
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toMatch(/location/i);
  });

  it("displays custom message when provided", () => {
    const container = document.createElement("div");
    renderLoading(container, "Downloading data\u2026");
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toBe("Downloading data\u2026");
  });

  it("renders a loading dot", () => {
    const container = document.createElement("div");
    renderLoading(container);
    expect(container.querySelector(".loading-dot")).not.toBeNull();
  });
});

// ── renderLoadingProgress ───────────────────────────────────

describe("renderLoadingProgress", () => {
  it("progress bar width reflects fraction", () => {
    const container = document.createElement("div");
    renderLoadingProgress(container, 0.75);
    const fill = container.querySelector(".progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("75%");
  });

  it("displays percentage label", () => {
    const container = document.createElement("div");
    renderLoadingProgress(container, 0.42);
    const label = container.querySelector(".status-message");
    expect(label?.textContent).toBe("42%");
  });

  it("shows 0% for zero fraction", () => {
    const container = document.createElement("div");
    renderLoadingProgress(container, 0);
    const fill = container.querySelector(".progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
    const label = container.querySelector(".status-message");
    expect(label?.textContent).toBe("0%");
  });

  it("shows 100% for fraction of 1", () => {
    const container = document.createElement("div");
    renderLoadingProgress(container, 1);
    const fill = container.querySelector(".progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
    const label = container.querySelector(".status-message");
    expect(label?.textContent).toBe("100%");
  });

  it("falls back to loading dot for negative fraction", () => {
    const container = document.createElement("div");
    renderLoadingProgress(container, -1);
    expect(container.querySelector(".progress-track")).toBeNull();
    expect(container.querySelector(".loading-dot")).not.toBeNull();
    const msg = container.querySelector(".status-message");
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toMatch(/article data/i);
  });
});

// ── renderError ─────────────────────────────────────────────

describe("renderError", () => {
  it("renders a message for each error code", () => {
    const codes: LocationError["code"][] = [
      "PERMISSION_DENIED",
      "POSITION_UNAVAILABLE",
      "TIMEOUT",
    ];
    const messages = codes.map((code) => {
      const container = document.createElement("div");
      renderError(container, { code, message: "" }, () => {});
      const msg = container.querySelector(".status-message");
      expect(msg).not.toBeNull();
      expect(msg?.textContent).toMatch(/denied|determined|timed out/i);
      return msg!.textContent;
    });
    expect(new Set(messages).size).toBe(codes.length);
  });

  it("calls onPickLocation when pick-location button is clicked", () => {
    const onPickLocation = vi.fn();
    const container = document.createElement("div");
    const error: LocationError = {
      code: "PERMISSION_DENIED",
      message: "denied",
    };
    renderError(container, error, onPickLocation);
    const btn = container.querySelector(".status-action") as HTMLButtonElement;
    btn.click();
    expect(onPickLocation).toHaveBeenCalledOnce();
  });

  it("renders a pick-location button", () => {
    const container = document.createElement("div");
    const error: LocationError = { code: "TIMEOUT", message: "timeout" };
    renderError(container, error, () => {});
    const btn = container.querySelector(".status-action") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/map/i);
  });
});

// ── renderDataUnavailable ───────────────────────────────────

describe("renderDataUnavailable", () => {
  it("displays language name in message", () => {
    const container = document.createElement("div");
    renderDataUnavailable(container, "sv", () => {});
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toContain("Svenska");
  });

  it("language selector reflects currentLang", () => {
    const container = document.createElement("div");
    renderDataUnavailable(container, "ja", () => {});
    const select = container.querySelector(".lang-select") as HTMLSelectElement;
    expect(select.value).toBe("ja");
  });

  it("calls onLangChange when language is changed", () => {
    const onLangChange = vi.fn();
    const container = document.createElement("div");
    renderDataUnavailable(container, "en", onLangChange);
    const select = container.querySelector(".lang-select") as HTMLSelectElement;
    select.value = "sv";
    select.dispatchEvent(new Event("change"));
    expect(onLangChange).toHaveBeenCalledWith("sv");
  });

  it("renders a message suggesting alternatives", () => {
    const container = document.createElement("div");
    renderDataUnavailable(container, "en", () => {});
    const msg = container.querySelector(".status-message");
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toMatch(/try a different language/i);
  });
});
