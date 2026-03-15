import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";
import { formatDistance } from "./format";
import type { Lang } from "../lang";
import { createAppHeader } from "./header";
import { createLangDropdown } from "./lang-dropdown";

// ── SVG icon helpers ─────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

function createSvgRoot(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("fill", "currentColor");
  return svg;
}

function createPlayIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  const polygon = document.createElementNS(SVG_NS, "polygon");
  polygon.setAttribute("points", "4,2 16,9 4,16");
  svg.appendChild(polygon);
  return svg;
}

function createPauseIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  const left = document.createElementNS(SVG_NS, "rect");
  left.setAttribute("x", "3");
  left.setAttribute("y", "2");
  left.setAttribute("width", "4");
  left.setAttribute("height", "14");
  const right = document.createElementNS(SVG_NS, "rect");
  right.setAttribute("x", "11");
  right.setAttribute("y", "2");
  right.setAttribute("width", "4");
  right.setAttribute("height", "14");
  svg.append(left, right);
  return svg;
}

// ── Focus capture / restore ──────────────────────────────────

type FocusInfo =
  | { type: "langSelect" }
  | { type: "pauseToggle" }
  | { type: "pickLocation" }
  | { type: "useGps" }
  | { type: "article"; title: string };

function captureFocus(container: HTMLElement): FocusInfo | null {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.classList.contains("lang-trigger")) return { type: "langSelect" };
  if (active.classList.contains("pause-toggle")) return { type: "pauseToggle" };
  if (active.classList.contains("pick-location-btn"))
    return { type: "pickLocation" };
  if (active.classList.contains("use-gps-btn")) return { type: "useGps" };

  const item = (active as HTMLElement).closest<HTMLElement>(".nearby-item");
  if (item?.dataset.title)
    return { type: "article", title: item.dataset.title };

  return null;
}

function restoreFocus(container: HTMLElement, info: FocusInfo | null): void {
  if (!info) return;

  let target: HTMLElement | null = null;
  switch (info.type) {
    case "langSelect":
      target = container.querySelector(".lang-trigger");
      break;
    case "pauseToggle":
      target = container.querySelector(".pause-toggle");
      break;
    case "pickLocation":
      target = container.querySelector(".pick-location-btn");
      break;
    case "useGps":
      target = container.querySelector(".use-gps-btn");
      break;
    case "article":
      target =
        Array.from(
          container.querySelectorAll<HTMLElement>(".nearby-item"),
        ).find((el) => el.dataset.title === info.title) ?? null;
      break;
  }
  target?.focus();
}

/** Create the `.app-scroll` wrapper div used to scope scrolling to the article list. */
export function createScrollWrapper(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "app-scroll";
  return el;
}

/** Update only the distance badges in an already-rendered list. */
export function updateNearbyDistances(
  container: HTMLElement,
  articles: NearbyArticle[],
): void {
  const badges = container.querySelectorAll(".nearby-distance");
  for (let i = 0; i < articles.length && i < badges.length; i++) {
    badges[i].textContent = formatDistance(articles[i].distanceM);
  }
}

export interface RenderNearbyHeaderOptions {
  articleCount: number;
  currentLang: Lang;
  onLangChange: (lang: Lang) => void;
  paused: boolean;
  pauseReason?: "manual" | "scroll" | null;
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
  gpsSignalLost?: boolean;
}

/** Render the header bar with title, pause button, and language selector. */
export function renderNearbyHeader(
  options: RenderNearbyHeaderOptions,
): HTMLElement {
  const {
    articleCount,
    currentLang,
    onLangChange,
    paused,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
  } = options;
  const header = createAppHeader();
  const h1 = header.querySelector("h1")!;
  h1.remove();

  const row = document.createElement("div");
  row.className = "app-header-row";

  const titleGroup = document.createElement("div");
  const subtitle = document.createElement("p");
  const subtitleText = `${articleCount} attraction${articleCount !== 1 ? "s" : ""}`;
  subtitle.textContent = paused ? `${subtitleText} · paused` : subtitleText;
  titleGroup.append(h1, subtitle);

  const headerControls = document.createElement("div");
  headerControls.className = "header-controls";

  if (onTogglePause) {
    const pauseBtn = document.createElement("button");
    let btnClass = "header-icon-btn pause-toggle";
    if (paused && pauseReason === "scroll") {
      btnClass += " scroll-pause-blink";
    }
    pauseBtn.className = btnClass;
    const pauseLabel = paused
      ? pauseReason === "scroll"
        ? "Resume updates (paused by scroll)"
        : "Resume location updates"
      : "Pause location updates";
    pauseBtn.setAttribute("aria-label", pauseLabel);
    pauseBtn.title = pauseLabel;
    pauseBtn.appendChild(paused ? createPlayIcon() : createPauseIcon());
    pauseBtn.addEventListener("click", onTogglePause);
    headerControls.appendChild(pauseBtn);
  }

  if (positionSource && onUseGps && onPickLocation) {
    const modeToggle = document.createElement("div");
    modeToggle.className = "mode-toggle";

    const gpsBtn = document.createElement("button");
    const gpsClasses = ["header-icon-btn", "use-gps-btn"];
    gpsClasses.push(positionSource === "gps" ? "mode-active" : "mode-inactive");
    if (gpsSignalLost) gpsClasses.push("gps-signal-lost");
    gpsBtn.className = gpsClasses.join(" ");
    gpsBtn.setAttribute(
      "aria-label",
      gpsSignalLost ? "GPS signal lost" : "Use GPS location",
    );
    gpsBtn.title = gpsSignalLost ? "GPS signal lost" : "Use GPS location";
    gpsBtn.setAttribute("aria-pressed", String(positionSource === "gps"));
    gpsBtn.textContent = "\uD83D\uDEF0\uFE0F"; // 🛰️
    if (positionSource !== "gps") {
      gpsBtn.addEventListener("click", onUseGps);
    }

    const pinBtn = document.createElement("button");
    pinBtn.className = `header-icon-btn pick-location-btn${positionSource === "picked" ? " mode-active" : " mode-inactive"}`;
    const pinLabel =
      positionSource === "picked"
        ? "Pick a new location"
        : "Pick location on map";
    pinBtn.setAttribute("aria-label", pinLabel);
    pinBtn.title = pinLabel;
    pinBtn.setAttribute("aria-pressed", String(positionSource === "picked"));
    pinBtn.textContent = "\uD83D\uDDFA\uFE0F"; // 🗺️
    if (positionSource === "picked") {
      pinBtn.addEventListener("click", () => {
        if (confirm("Choose a different location?")) onPickLocation();
      });
    } else {
      pinBtn.addEventListener("click", onPickLocation);
    }

    modeToggle.append(gpsBtn, pinBtn);
    headerControls.appendChild(modeToggle);
  }

  const langDropdown = createLangDropdown(currentLang, onLangChange);
  headerControls.appendChild(langDropdown);
  row.append(titleGroup, headerControls);
  header.appendChild(row);
  return header;
}

/** Create the inner content of an article list item (the .nearby-item div). */
export function createArticleItemContent(
  article: NearbyArticle,
  onSelectArticle: (article: NearbyArticle) => void,
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "nearby-item";
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.dataset.title = article.title;
  item.addEventListener("click", () => onSelectArticle(article));
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectArticle(article);
    }
  });

  const thumb = document.createElement("div");
  thumb.className = "nearby-thumb";

  const info = document.createElement("div");
  info.className = "nearby-info";
  const name = document.createElement("span");
  name.className = "nearby-name";
  name.textContent = article.title;
  const desc = document.createElement("span");
  desc.className = "nearby-desc";
  info.append(name, desc);

  const badge = document.createElement("span");
  badge.className = "nearby-distance";
  badge.textContent = formatDistance(article.distanceM);

  item.append(thumb, info, badge);
  return item;
}

/** Create a single article list item element. */
function createArticleItem(
  article: NearbyArticle,
  onSelectArticle: (article: NearbyArticle) => void,
): HTMLLIElement {
  const li = document.createElement("li");
  li.appendChild(createArticleItemContent(article, onSelectArticle));
  return li;
}

/** Apply summary data (thumbnail + description) to a single .nearby-item element. */
export function applyEnrichment(
  item: HTMLElement,
  summary: ArticleSummary,
): void {
  const desc = item.querySelector<HTMLElement>(".nearby-desc");
  if (desc && summary.description) {
    desc.textContent = summary.description;
  }

  const thumbContainer = item.querySelector<HTMLElement>(".nearby-thumb");
  if (thumbContainer && summary.thumbnailUrl) {
    if (!thumbContainer.querySelector("img")) {
      const img = document.createElement("img");
      img.src = summary.thumbnailUrl;
      img.alt = "";
      img.loading = "lazy";
      thumbContainer.appendChild(img);
      thumbContainer.classList.add("nearby-thumb-loaded");
    }
  }
}

/** Enrich a list item with summary data (thumbnail + description). */
export function enrichArticleItem(
  container: HTMLElement,
  title: string,
  summary: ArticleSummary,
): void {
  const items = container.querySelectorAll<HTMLElement>(".nearby-item");
  for (const item of items) {
    if (item.dataset.title !== title) continue;
    applyEnrichment(item, summary);
    break;
  }
}

/**
 * Reconcile list items by article title key.
 * Reuses existing DOM nodes for articles still present, only creating nodes
 * for new articles. Removed articles are discarded by replaceChildren.
 */
function reconcileListItems(
  ul: HTMLUListElement,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
): void {
  const existingByTitle = new Map<string, HTMLLIElement>();
  for (const child of Array.from(ul.children)) {
    const li = child as HTMLLIElement;
    const item = li.querySelector<HTMLElement>(".nearby-item");
    if (item?.dataset.title) {
      existingByTitle.set(item.dataset.title, li);
    }
  }

  const newChildren: HTMLLIElement[] = [];
  for (const article of articles) {
    const existing = existingByTitle.get(article.title);
    if (existing) {
      const badge = existing.querySelector(".nearby-distance");
      if (badge) badge.textContent = formatDistance(article.distanceM);
      existingByTitle.delete(article.title);
      newChildren.push(existing);
    } else {
      newChildren.push(createArticleItem(article, onSelectArticle));
    }
  }

  ul.replaceChildren(...newChildren);
}

export interface RenderNearbyListOptions {
  onSelectArticle: (article: NearbyArticle) => void;
  currentLang: Lang;
  onLangChange: (lang: Lang) => void;
  paused?: boolean;
  pauseReason?: "manual" | "scroll" | null;
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
  gpsSignalLost?: boolean;
}

/** Build and replace the contents of `container` with a nearby-articles list. */
export function renderNearbyList(
  container: HTMLElement,
  articles: NearbyArticle[],
  options: RenderNearbyListOptions,
): void {
  const {
    onSelectArticle,
    currentLang,
    onLangChange,
    paused,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
  } = options;

  const headerOpts = {
    articleCount: articles.length,
    currentLang,
    onLangChange,
    paused: paused ?? false,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
  };

  const existingList =
    container.querySelector<HTMLUListElement>(".nearby-list");

  if (!existingList) {
    // First render: build from scratch
    container.textContent = "";

    const header = renderNearbyHeader(headerOpts);

    const scrollWrapper = createScrollWrapper();
    const list = document.createElement("ul");
    list.className = "nearby-list";
    for (const article of articles) {
      list.appendChild(createArticleItem(article, onSelectArticle));
    }
    scrollWrapper.appendChild(list);

    container.append(header, scrollWrapper);
    return;
  }

  // Re-render: incremental update
  const scrollWrapper = container.querySelector<HTMLElement>(".app-scroll");
  const scrollEl = scrollWrapper ?? container;
  const savedScrollTop = scrollEl.scrollTop;
  const savedFocus = captureFocus(container);

  // Replace header (cheap — ~5 nodes with fresh event listeners).
  // Skip replacement while the language dropdown is open so background
  // re-renders (tile loads, distance updates) don't dismiss it.
  const oldHeader = container.querySelector("header.app-header");
  if (oldHeader && !oldHeader.querySelector(".lang-listbox:not([hidden])")) {
    oldHeader.replaceWith(renderNearbyHeader(headerOpts));
  }

  // Reconcile article list items by title key
  reconcileListItems(existingList, articles, onSelectArticle);

  scrollEl.scrollTop = savedScrollTop;
  restoreFocus(container, savedFocus);
}
