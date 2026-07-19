import type { ArticleFilter, NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";
import { collapseCoincident, type CoincidentGroup } from "./coincident";
import { formatDistance } from "./format";
import type { Lang } from "../lang";
import { createAppHeader } from "./header";
import { APP_NAME } from "./config";
import { createLangDropdown } from "./lang-dropdown";
import { createAboutButton } from "./about";
import {
  createPlayIcon,
  createPauseIcon,
  createSatelliteIcon,
  createMapIcon,
  createStarIcon,
} from "./icons";

// ── Focus capture / restore ──────────────────────────────────

type FocusInfo =
  | { type: "langSelect" }
  | { type: "pauseToggle" }
  | { type: "filterToggle" }
  | { type: "pickLocation" }
  | { type: "useGps" }
  | { type: "aboutBtn" }
  | { type: "article"; title: string }
  | { type: "moreToggle"; repTitle: string };

function captureFocus(container: HTMLElement): FocusInfo | null {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.classList.contains("lang-trigger")) return { type: "langSelect" };
  if (active.classList.contains("pause-toggle")) return { type: "pauseToggle" };
  if (active.classList.contains("filter-toggle"))
    return { type: "filterToggle" };
  if (active.classList.contains("pick-location-btn"))
    return { type: "pickLocation" };
  if (active.classList.contains("use-gps-btn")) return { type: "useGps" };
  if (active.classList.contains("about-btn")) return { type: "aboutBtn" };

  if (active.classList.contains("nearby-more")) {
    const group = (active as HTMLElement).closest<HTMLElement>(".nearby-group");
    if (group?.dataset.repTitle)
      return { type: "moreToggle", repTitle: group.dataset.repTitle };
    return null;
  }

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
    case "filterToggle":
      target = container.querySelector(".filter-toggle");
      break;
    case "pickLocation":
      target = container.querySelector(".pick-location-btn");
      break;
    case "useGps":
      target = container.querySelector(".use-gps-btn");
      break;
    case "aboutBtn":
      target = container.querySelector(".about-btn");
      break;
    case "article":
      target =
        Array.from(
          container.querySelectorAll<HTMLElement>(".nearby-item"),
        ).find((el) => el.dataset.title === info.title) ?? null;
      break;
    case "moreToggle":
      target =
        Array.from(container.querySelectorAll<HTMLElement>(".nearby-group"))
          .find((el) => el.dataset.repTitle === info.repTitle)
          ?.querySelector<HTMLElement>(".nearby-more") ?? null;
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

/**
 * Update only the distance badges in an already-rendered list.
 *
 * Keyed by article title rather than by index: coincident groups collapse
 * several articles into one expandable row, so the DOM row order no longer
 * matches the flat `articles` order. Every rendered row (representative or a
 * revealed member) is a `.nearby-item[data-title]`, so a title→distance map
 * patches all of them regardless of how they are grouped.
 */
export function updateNearbyDistances(
  container: HTMLElement,
  articles: NearbyArticle[],
): void {
  const distanceByTitle = new Map(articles.map((a) => [a.title, a.distanceM]));
  const items = container.querySelectorAll<HTMLElement>(".nearby-item");
  for (const item of items) {
    const title = item.dataset.title;
    if (title === undefined) continue;
    const distanceM = distanceByTitle.get(title);
    if (distanceM === undefined) continue;
    const badge = item.querySelector(".nearby-distance");
    if (badge) badge.textContent = formatDistance(distanceM);
  }
}

export interface RenderNearbyHeaderOptions {
  currentLang: Lang;
  onLangChange: (lang: Lang) => void;
  paused: boolean;
  pauseReason?: "manual" | "scroll" | null;
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
  gpsSignalLost?: boolean;
  /** Current article filter; drives the toggle's pressed state. */
  filter?: ArticleFilter;
  /** When provided, the Highlights/Everything toggle is rendered. */
  onToggleFilter?: () => void;
  onShowAbout: () => void;
}

/** Render the header bar with title, pause button, and language selector. */
export function renderNearbyHeader(
  options: RenderNearbyHeaderOptions,
): HTMLElement {
  const {
    currentLang,
    onLangChange,
    paused,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
    filter,
    onToggleFilter,
    onShowAbout,
  } = options;
  const header = createAppHeader({ title: false });

  const row = document.createElement("div");
  row.className = "app-header-row";

  const titleGroup = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = APP_NAME;
  titleGroup.appendChild(h1);
  if (paused) {
    const subtitle = document.createElement("p");
    subtitle.textContent = "paused";
    titleGroup.appendChild(subtitle);
  }

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
    gpsBtn.appendChild(createSatelliteIcon());
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
    pinBtn.appendChild(createMapIcon());
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

  if (onToggleFilter) {
    const highlightsOn = filter !== "all";
    const filterBtn = document.createElement("button");
    filterBtn.className = "header-icon-btn filter-toggle";
    filterBtn.setAttribute("aria-pressed", String(highlightsOn));
    const filterLabel = highlightsOn
      ? "Highlights only — show everything"
      : "Show highlights only";
    filterBtn.setAttribute("aria-label", filterLabel);
    filterBtn.title = filterLabel;
    filterBtn.appendChild(createStarIcon());
    filterBtn.addEventListener("click", onToggleFilter);
    headerControls.appendChild(filterBtn);
  }

  const langDropdown = createLangDropdown(currentLang, onLangChange);
  headerControls.appendChild(langDropdown);
  headerControls.appendChild(createAboutButton(onShowAbout));
  row.append(titleGroup, headerControls);
  header.appendChild(row);
  return header;
}

/**
 * "No highlights nearby" hint with a one-tap escape to Everything mode.
 * Shown when the Highlights filter yields zero articles; shared by the
 * viewport list (render.ts) and the infinite scroll (via wiring).
 */
export function createEmptyHighlightsHint(
  onShowEverything: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "nearby-empty";
  const msg = document.createElement("p");
  msg.textContent = "No highlights nearby.";
  const btn = document.createElement("button");
  btn.className = "nearby-empty-action";
  btn.textContent = "Show everything";
  btn.addEventListener("click", onShowEverything);
  wrap.append(msg, btn);
  return wrap;
}

/** Create the inner content of an article list item (the .nearby-item div). */
export function createArticleItemContent(
  article: NearbyArticle,
  onSelectArticle: (article: NearbyArticle) => void,
  onHoverArticle?: (title: string | null) => void,
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
  if (onHoverArticle) {
    item.addEventListener("pointerenter", () => onHoverArticle(article.title));
    item.addEventListener("pointerleave", () => onHoverArticle(null));
  }

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

/**
 * A compact "+N" chip appended to a coincident cluster's representative row in
 * the fixed-height infinite list. Tapping it opens the member popover (the
 * inline expandable row used in viewport mode can't grow a fixed-height virtual
 * row). `count` is the number of OTHER co-located articles (members − 1), so it
 * reads the same as viewport mode's "+N more here".
 */
export function createClusterMoreButton(
  count: number,
  onOpen: (anchor: HTMLElement) => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nearby-cluster-more";
  btn.textContent = `+${count}`;
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute(
    "aria-label",
    `Show ${count} more article${count === 1 ? "" : "s"} at this location`,
  );
  btn.title = `${count} more here`;
  // Stop propagation so opening the cluster doesn't also fire the row's
  // navigate-to-representative handler (click and keyboard activation).
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpen(btn);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  });
  return btn;
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
      img.alt = "";
      img.loading = "lazy";

      // Reveal the 40px thumbnail column only once the image has actually
      // painted. `nearby-thumb-loaded` reserves the column and shifts the
      // card's text to the right; adding it the instant the summary arrives —
      // before the image has loaded — leaves a blank indented gap that reads
      // as a per-card layout glitch while deep-scroll enrichment is in flight.
      // Gating the reveal on the load event keeps the card a clean full-width
      // text row until there is a real thumbnail to show.
      img.src = summary.thumbnailUrl;
      if (img.complete && img.naturalWidth > 0) {
        // Already decoded (e.g. a cached image on a recycled virtual-scroll
        // row) — reveal synchronously so scrolling never flickers it in.
        thumbContainer.classList.add("nearby-thumb-loaded");
      } else {
        img.addEventListener(
          "load",
          () => thumbContainer.classList.add("nearby-thumb-loaded"),
          { once: true },
        );
        // A thumbnail that fails to load collapses back to a text-only row
        // instead of leaving a permanent blank indent.
        img.addEventListener("error", () => img.remove(), { once: true });
      }
      thumbContainer.appendChild(img);
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
 * A coincident group collapses into one expandable row once it reaches this
 * many members; smaller groups (i.e. lone articles) render as a single plain
 * row. Two matches the radar/map, which draw a count badge for every
 * coincident group of two or more.
 */
const COINCIDENT_COLLAPSE_MIN = 2;

/**
 * Render `groups` into `ul`, reusing existing `.nearby-item` nodes by title so
 * thumbnails/descriptions survive a re-render even when an article moves
 * between the representative and member slots. A lone article renders as one
 * plain row (unchanged behavior). A coincident group renders its
 * representative plus a "+N more here" toggle that reveals the other members;
 * every member stays individually tappable. Expansion state is preserved
 * across re-renders, keyed by representative title.
 *
 * This replaces the old flat title-keyed reconciliation: distances are still
 * patched on reused nodes, but rows are now assembled into collapsed groups
 * rather than a flat one-li-per-article list.
 */
function renderCollapsedGroups(
  ul: HTMLUListElement,
  groups: CoincidentGroup[],
  onSelectArticle: (article: NearbyArticle) => void,
  onHoverArticle?: (title: string | null) => void,
): void {
  const existingItems = new Map<string, HTMLElement>();
  for (const item of ul.querySelectorAll<HTMLElement>(".nearby-item")) {
    const title = item.dataset.title;
    if (title !== undefined) existingItems.set(title, item);
  }

  // Preserve which groups the user has expanded, keyed by representative title.
  const expandedReps = new Set<string>();
  for (const li of ul.querySelectorAll<HTMLElement>(".nearby-group")) {
    if (li.dataset.expanded === "true" && li.dataset.repTitle !== undefined) {
      expandedReps.add(li.dataset.repTitle);
    }
  }

  const takeRow = (article: NearbyArticle): HTMLElement => {
    const row =
      existingItems.get(article.title) ??
      createArticleItemContent(article, onSelectArticle, onHoverArticle);
    const badge = row.querySelector(".nearby-distance");
    if (badge) badge.textContent = formatDistance(article.distanceM);
    return row;
  };

  const children: HTMLLIElement[] = [];
  for (const group of groups) {
    const li = document.createElement("li");
    li.className = "nearby-group";
    li.dataset.repTitle = group.representative.title;
    li.appendChild(takeRow(group.representative));

    const others = group.members.filter((m) => m !== group.representative);
    if (group.members.length >= COINCIDENT_COLLAPSE_MIN && others.length > 0) {
      const membersWrap = document.createElement("div");
      membersWrap.className = "nearby-members";
      for (const member of others) membersWrap.appendChild(takeRow(member));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nearby-more";
      const applyExpanded = (open: boolean): void => {
        li.dataset.expanded = String(open);
        membersWrap.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Show less" : `+${others.length} more here`;
      };
      toggle.addEventListener("click", () =>
        applyExpanded(li.dataset.expanded !== "true"),
      );
      applyExpanded(expandedReps.has(group.representative.title));

      li.append(toggle, membersWrap);
    }

    children.push(li);
  }

  ul.replaceChildren(...children);
}

export interface RenderNearbyListOptions {
  onSelectArticle: (article: NearbyArticle) => void;
  onHoverArticle?: (title: string | null) => void;
  currentLang: Lang;
  onLangChange: (lang: Lang) => void;
  paused?: boolean;
  pauseReason?: "manual" | "scroll" | null;
  onTogglePause?: () => void;
  positionSource?: "gps" | "picked";
  onPickLocation?: () => void;
  onUseGps?: () => void;
  gpsSignalLost?: boolean;
  filter?: ArticleFilter;
  onToggleFilter?: () => void;
  onShowAbout: () => void;
}

/** Build the empty-highlights hint when it applies, else null. */
function buildEmptyHint(
  articles: NearbyArticle[],
  options: RenderNearbyListOptions,
): HTMLElement | null {
  if (articles.length > 0) return null;
  if (options.filter !== "highlights" || !options.onToggleFilter) return null;
  return createEmptyHighlightsHint(options.onToggleFilter);
}

/** Build and replace the contents of `container` with a nearby-articles list. */
export function renderNearbyList(
  container: HTMLElement,
  articles: NearbyArticle[],
  options: RenderNearbyListOptions,
): void {
  const {
    onSelectArticle,
    onHoverArticle,
    currentLang,
    onLangChange,
    paused,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
    filter,
    onToggleFilter,
    onShowAbout,
  } = options;

  const headerOpts = {
    currentLang,
    onLangChange,
    paused: paused ?? false,
    pauseReason,
    onTogglePause,
    positionSource,
    onPickLocation,
    onUseGps,
    gpsSignalLost,
    filter,
    onToggleFilter,
    onShowAbout,
  };

  // Collapse coincident articles (same exact coordinate) into groups so a big
  // cluster shows one expandable row instead of N identical-distance rows.
  const groups = collapseCoincident(articles);

  const existingList =
    container.querySelector<HTMLUListElement>(".nearby-list");

  if (!existingList) {
    // First render: build from scratch
    container.textContent = "";

    const header = renderNearbyHeader(headerOpts);

    const scrollWrapper = createScrollWrapper();
    const list = document.createElement("ul");
    list.className = "nearby-list";
    renderCollapsedGroups(list, groups, onSelectArticle, onHoverArticle);
    scrollWrapper.appendChild(list);
    const hint = buildEmptyHint(articles, options);
    if (hint) scrollWrapper.appendChild(hint);

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

  // Reassemble the collapsed group list, reusing rows by title
  renderCollapsedGroups(existingList, groups, onSelectArticle, onHoverArticle);

  // Rebuild the empty-highlights hint so it tracks both the article count
  // and the current filter.
  scrollEl.querySelector(".nearby-empty")?.remove();
  const hint = buildEmptyHint(articles, options);
  if (hint) scrollEl.appendChild(hint);

  scrollEl.scrollTop = savedScrollTop;
  restoreFocus(container, savedFocus);
}
