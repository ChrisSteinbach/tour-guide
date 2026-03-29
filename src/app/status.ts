import type { LocationError } from "./location";
import { SUPPORTED_LANGS, LANG_NAMES } from "../lang";
import type { Lang } from "../lang";
import { createAppHeader } from "./header";

/** Native `<select>` language picker for status screens (welcome, data-unavailable).
 *  The browsing header uses {@link createLangDropdown} from `lang-dropdown.ts` instead,
 *  which has open-state tracking to prevent re-renders while the user is choosing. */
function createLangSelect(
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "lang-select";
  select.setAttribute("aria-label", "Wikipedia language");
  for (const code of SUPPORTED_LANGS) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = LANG_NAMES[code];
    if (code === currentLang) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    onLangChange(select.value as Lang);
  });
  return select;
}

/** Render a centered status screen (loading or error). */
function renderStatusScreen(
  container: HTMLElement,
  content: HTMLElement[],
): void {
  container.textContent = "";

  const header = createAppHeader();

  const screen = document.createElement("div");
  screen.className = "status-screen";
  for (const el of content) screen.appendChild(el);

  container.append(header, screen);
}

/** Render the loading state with a pulsing dot. */
export function renderLoading(
  container: HTMLElement,
  message = "Finding your location\u2026",
): void {
  const dot = document.createElement("div");
  dot.className = "loading-dot";

  const msg = document.createElement("p");
  msg.className = "status-message";
  msg.textContent = message;

  renderStatusScreen(container, [dot, msg]);
}

/** Render the loading state with a progress bar for data download. */
export function renderLoadingProgress(
  container: HTMLElement,
  fraction: number,
): void {
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
  options: {
    onStart: () => void;
    onPickLocation: () => void;
    currentLang: Lang;
    onLangChange: (lang: Lang) => void;
    onShowAbout: () => void;
  },
): void {
  const { onStart, onPickLocation, currentLang, onLangChange, onShowAbout } =
    options;
  const tagline = document.createElement("p");
  tagline.className = "status-message";
  tagline.textContent = "Discover Wikipedia articles about nearby places.";

  const langSelect = createLangSelect(currentLang, onLangChange);

  const choices = document.createElement("div");
  choices.className = "welcome-choices";

  const liveIcon = document.createElement("span");
  liveIcon.className = "welcome-choice-icon";
  liveIcon.textContent = "\uD83D\uDEF0\uFE0F"; // 🛰️
  const liveBtn = document.createElement("button");
  liveBtn.className = "welcome-choice";
  liveBtn.append(liveIcon, " Use my location");
  liveBtn.addEventListener("click", onStart);

  const pickIcon = document.createElement("span");
  pickIcon.className = "welcome-choice-icon";
  pickIcon.textContent = "\uD83D\uDDFA\uFE0F"; // 🗺️
  const pickBtn = document.createElement("button");
  pickBtn.className = "welcome-choice";
  pickBtn.append(pickIcon, " Pick a spot on the map");
  pickBtn.addEventListener("click", onPickLocation);

  choices.append(liveBtn, pickBtn);

  const aboutLink = document.createElement("button");
  aboutLink.className = "welcome-about";
  aboutLink.textContent = "About";
  aboutLink.addEventListener("click", onShowAbout);

  renderStatusScreen(container, [tagline, langSelect, choices, aboutLink]);
}

/** Render the data-unavailable state with language picker. */
export function renderDataUnavailable(
  container: HTMLElement,
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
): void {
  const msg = document.createElement("p");
  msg.className = "status-message";
  msg.textContent = `No data available for ${LANG_NAMES[currentLang]}. Try a different language.`;

  const langSelect = createLangSelect(currentLang, onLangChange);

  renderStatusScreen(container, [msg, langSelect]);
}

/** Render the error state with a message and fallback button. */
export function renderError(
  container: HTMLElement,
  error: LocationError,
  onPickLocation: () => void,
): void {
  const msg = document.createElement("p");
  msg.className = "status-message";

  const messages: Record<LocationError["code"], string> = {
    PERMISSION_DENIED:
      "Location access was denied. Please enable location permissions or pick a location on the map.",
    POSITION_UNAVAILABLE:
      "Your location could not be determined. Please try again or pick a location on the map.",
    TIMEOUT:
      "Location request timed out. Please try again or pick a location on the map.",
  };
  msg.textContent = messages[error.code];

  const btn = document.createElement("button");
  btn.className = "status-action";
  btn.textContent = "Pick on map";
  btn.addEventListener("click", onPickLocation);

  renderStatusScreen(container, [msg, btn]);
}
