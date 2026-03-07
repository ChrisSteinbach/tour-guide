import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";
import { formatDistance } from "./format";
import { SUPPORTED_LANGS, LANG_NAMES } from "../lang";
import type { Lang } from "../lang";
import { createAppHeader } from "./header";

// ── Focus capture / restore ──────────────────────────────────

type FocusInfo =
  | { type: "langSelect" }
  | { type: "pauseToggle" }
  | { type: "pickLocation" }
  | { type: "useGps" }
  | { type: "showMore" }
  | { type: "article"; title: string };

function captureFocus(container: HTMLElement): FocusInfo | null {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.classList.contains("header-lang-select"))
    return { type: "langSelect" };
  if (active.classList.contains("pause-toggle")) return { type: "pauseToggle" };
  if (active.classList.contains("pick-location-btn"))
    return { type: "pickLocation" };
  if (active.classList.contains("use-gps-btn")) return { type: "useGps" };
  if (active.classList.contains("show-more")) return { type: "showMore" };

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
      target = container.querySelector(".header-lang-select");
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
    case "showMore":
      target = container.querySelector(".show-more");
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
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
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
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
  } = options;
  const header = createAppHeader();
  const h1 = header.querySelector("h1")!;
  h1.remove();

  const row = document.createElement("div");
  row.className = "app-header-row";

  const titleGroup = document.createElement("div");
  const subtitle = document.createElement("p");
  const subtitleText = `${articleCount} nearby attraction${articleCount !== 1 ? "s" : ""}`;
  subtitle.textContent = paused ? `${subtitleText} · paused` : subtitleText;
  titleGroup.append(h1, subtitle);

  const headerControls = document.createElement("div");
  headerControls.className = "header-controls";

  if (onTogglePause) {
    const pauseBtn = document.createElement("button");
    pauseBtn.className = "header-icon-btn pause-toggle";
    pauseBtn.setAttribute(
      "aria-label",
      paused ? "Resume updates" : "Pause updates",
    );
    pauseBtn.textContent = paused ? "\u25B6" : "\u23F8";
    pauseBtn.addEventListener("click", onTogglePause);
    headerControls.appendChild(pauseBtn);
  }

  if (positionSource && onUseGps && onPickLocation) {
    const modeToggle = document.createElement("div");
    modeToggle.className = "mode-toggle";

    const gpsBtn = document.createElement("button");
    gpsBtn.className = `header-icon-btn use-gps-btn${positionSource === "gps" ? " mode-active" : " mode-inactive"}`;
    gpsBtn.setAttribute("aria-label", "Use GPS location");
    gpsBtn.setAttribute("aria-pressed", String(positionSource === "gps"));
    gpsBtn.textContent = "\uD83D\uDEF0\uFE0F"; // 🛰️
    if (positionSource !== "gps") {
      gpsBtn.addEventListener("click", onUseGps);
    }

    const pinBtn = document.createElement("button");
    pinBtn.className = `header-icon-btn pick-location-btn${positionSource === "picked" ? " mode-active" : " mode-inactive"}`;
    pinBtn.setAttribute("aria-label", "Pick location on map");
    pinBtn.setAttribute("aria-pressed", String(positionSource === "picked"));
    pinBtn.textContent = "\uD83D\uDCCD"; // 📍
    if (positionSource !== "picked") {
      pinBtn.addEventListener("click", onPickLocation);
    }

    modeToggle.append(gpsBtn, pinBtn);
    headerControls.appendChild(modeToggle);
  }

  const langSelect = document.createElement("select");
  langSelect.className = "header-lang-select";
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

  headerControls.appendChild(langSelect);
  row.append(titleGroup, headerControls);
  header.appendChild(row);
  return header;
}

/** Render a "Show N" button, or null if there's no next tier. */
export function renderShowMoreButton(
  nextCount: number | undefined,
  onShowMore?: () => void,
): HTMLElement | null {
  if (!onShowMore || nextCount === undefined) return null;
  const btn = document.createElement("button");
  btn.className = "show-more";
  btn.textContent = `Show ${nextCount}`;
  btn.addEventListener("click", onShowMore);
  return btn;
}

/** Create a single article list item element. */
function createArticleItem(
  article: NearbyArticle,
  onSelectArticle: (article: NearbyArticle) => void,
): HTMLLIElement {
  const li = document.createElement("li");
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
  li.appendChild(item);
  return li;
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
  onShowMore?: () => void;
  nextCount?: number;
  paused?: boolean;
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
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
    onShowMore,
    nextCount,
    paused,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
  } = options;

  const existingList =
    container.querySelector<HTMLUListElement>(".nearby-list");

  if (!existingList) {
    // First render: build from scratch
    container.textContent = "";

    const header = renderNearbyHeader({
      articleCount: articles.length,
      currentLang,
      onLangChange,
      paused: paused ?? false,
      onTogglePause,
      positionSource,
      onPickLocation,
      onUseGps,
    });

    const list = document.createElement("ul");
    list.className = "nearby-list";
    for (const article of articles) {
      list.appendChild(createArticleItem(article, onSelectArticle));
    }

    container.append(header, list);
    const showMoreBtn = renderShowMoreButton(nextCount, onShowMore);
    if (showMoreBtn) container.appendChild(showMoreBtn);
    return;
  }

  // Re-render: incremental update
  const savedScrollY = window.scrollY;
  const savedFocus = captureFocus(container);

  // Replace header (cheap — ~5 nodes with fresh event listeners)
  const oldHeader = container.querySelector("header.app-header");
  const newHeader = renderNearbyHeader({
    articleCount: articles.length,
    currentLang,
    onLangChange,
    paused: paused ?? false,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
  });
  if (oldHeader) {
    oldHeader.replaceWith(newHeader);
  }

  // Reconcile article list items by title key
  reconcileListItems(existingList, articles, onSelectArticle);

  // Update show-more button
  const oldShowMore = container.querySelector(".show-more");
  const newShowMore = renderShowMoreButton(nextCount, onShowMore);
  if (oldShowMore && newShowMore) {
    oldShowMore.replaceWith(newShowMore);
  } else if (oldShowMore) {
    oldShowMore.remove();
  } else if (newShowMore) {
    container.appendChild(newShowMore);
  }

  window.scrollTo(0, savedScrollY);
  restoreFocus(container, savedFocus);
}
