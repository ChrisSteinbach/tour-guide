import type { UserPosition } from "./types";
import type { LocationError } from "./location";
import { SUPPORTED_LANGS, LANG_NAMES } from "../lang";
import type { Lang } from "../lang";

export type AppState =
  | { kind: "loading" }
  | { kind: "error"; error: LocationError }
  | { kind: "ready"; position: UserPosition };

/** Render a centered status screen (loading or error). */
function renderStatusScreen(
  container: HTMLElement,
  content: HTMLElement[],
): void {
  container.innerHTML = "";

  const header = document.createElement("header");
  header.className = "app-header";
  const h1 = document.createElement("h1");
  h1.textContent = "Tour Guide";
  header.appendChild(h1);

  const screen = document.createElement("div");
  screen.className = "status-screen";
  for (const el of content) screen.appendChild(el);

  container.append(header, screen);
}

/** Render the loading state with a pulsing dot. */
export function renderLoading(container: HTMLElement, message = "Finding your location\u2026"): void {
  const dot = document.createElement("div");
  dot.className = "loading-dot";

  const msg = document.createElement("p");
  msg.className = "status-message";
  msg.textContent = message;

  renderStatusScreen(container, [dot, msg]);
}

/** Render the loading state with a progress bar for data download. */
export function renderLoadingProgress(container: HTMLElement, fraction: number): void {
  if (fraction < 0) {
    renderLoading(container, "Loading article data\u2026");
    return;
  }

  const pct = Math.round(fraction * 100);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${pct}%`;
  track.appendChild(fill);

  const label = document.createElement("p");
  label.className = "status-message";
  label.textContent = `${pct}%`;

  renderStatusScreen(container, [track, label]);
}

/** Render the welcome/landing screen before requesting location. */
export function renderWelcome(
  container: HTMLElement,
  onStart: () => void,
  onDemo: () => void,
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
): void {
  const tagline = document.createElement("p");
  tagline.className = "status-message";
  tagline.textContent = "Discover Wikipedia articles about places near you.";

  const langSelect = document.createElement("select");
  langSelect.className = "lang-select";
  langSelect.setAttribute("aria-label", "Wikipedia language");
  for (const code of SUPPORTED_LANGS) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = LANG_NAMES[code];
    if (code === currentLang) opt.selected = true;
    langSelect.appendChild(opt);
  }
  langSelect.addEventListener("change", () => {
    onLangChange(langSelect.value as Lang);
  });

  const startBtn = document.createElement("button");
  startBtn.className = "status-action";
  startBtn.textContent = "Find nearby articles";
  startBtn.addEventListener("click", onStart);

  const demoLink = document.createElement("button");
  demoLink.className = "welcome-demo-link";
  demoLink.textContent = "Or try with demo data";
  demoLink.addEventListener("click", onDemo);

  renderStatusScreen(container, [tagline, langSelect, startBtn, demoLink]);
}

/** Render the error state with a message and fallback button. */
export function renderError(
  container: HTMLElement,
  error: LocationError,
  onUseDemoData: () => void,
): void {
  const msg = document.createElement("p");
  msg.className = "status-message";

  const messages: Record<LocationError["code"], string> = {
    PERMISSION_DENIED: "Location access was denied. Please enable location permissions or use demo data.",
    POSITION_UNAVAILABLE: "Your location could not be determined. Please try again or use demo data.",
    TIMEOUT: "Location request timed out. Please try again or use demo data.",
  };
  msg.textContent = messages[error.code];

  const btn = document.createElement("button");
  btn.className = "status-action";
  btn.textContent = "Use demo data";
  btn.addEventListener("click", onUseDemoData);

  renderStatusScreen(container, [msg, btn]);
}
