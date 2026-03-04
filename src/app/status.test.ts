// @vitest-environment jsdom

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

  it("renders the app header with WikiRadar title", () => {
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "en",
      () => {},
    );
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe("WikiRadar");
  });

  it("renders tagline text", () => {
    const container = document.createElement("div");
    renderWelcome(
      container,
      () => {},
      () => {},
      "en",
      () => {},
    );
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toBe(
      "Discover Wikipedia articles about places near you.",
    );
  });
});

// ── renderLoading ───────────────────────────────────────────

describe("renderLoading", () => {
  it("displays default loading message", () => {
    const container = document.createElement("div");
    renderLoading(container);
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toBe("Finding your location\u2026");
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
    expect(msg?.textContent).toBe("Loading article data\u2026");
  });
});

// ── renderError ─────────────────────────────────────────────

describe("renderError", () => {
  it("displays user-friendly message for PERMISSION_DENIED", () => {
    const container = document.createElement("div");
    const error: LocationError = {
      code: "PERMISSION_DENIED",
      message: "User denied",
    };
    renderError(container, error, () => {});
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toContain("Location access was denied");
  });

  it("displays user-friendly message for POSITION_UNAVAILABLE", () => {
    const container = document.createElement("div");
    const error: LocationError = {
      code: "POSITION_UNAVAILABLE",
      message: "Unavailable",
    };
    renderError(container, error, () => {});
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toContain("could not be determined");
    expect(msg?.textContent).toContain("pick a location on the map");
  });

  it("displays user-friendly message for TIMEOUT", () => {
    const container = document.createElement("div");
    const error: LocationError = { code: "TIMEOUT", message: "Timed out" };
    renderError(container, error, () => {});
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toContain("timed out");
    expect(msg?.textContent).toContain("pick a location on the map");
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

  it("pick-location button has correct label", () => {
    const container = document.createElement("div");
    const error: LocationError = { code: "TIMEOUT", message: "timeout" };
    renderError(container, error, () => {});
    const btn = container.querySelector(".status-action") as HTMLButtonElement;
    expect(btn.textContent).toBe("Pick on map");
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

  it("suggests trying a different language", () => {
    const container = document.createElement("div");
    renderDataUnavailable(container, "en", () => {});
    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toContain("Try a different language");
  });
});
