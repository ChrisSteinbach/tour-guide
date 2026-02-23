import type { NearbyArticle } from "./types";
import { formatDistance } from "./format";
import { SUPPORTED_LANGS, LANG_NAMES } from "../lang";
import type { Lang } from "../lang";

// ── Focus capture / restore ──────────────────────────────────

type FocusInfo =
  | { type: "langSelect" }
  | { type: "pauseToggle" }
  | { type: "showMore" }
  | { type: "article"; title: string };

function captureFocus(container: HTMLElement): FocusInfo | null {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;

  if (active.classList.contains("header-lang-select"))
    return { type: "langSelect" };
  if (active.classList.contains("pause-toggle")) return { type: "pauseToggle" };
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

/** Render the header bar with title, pause button, and language selector. */
export function renderNearbyHeader(
  articleCount: number,
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
  paused: boolean,
  onTogglePause?: () => void,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "app-header";

  const row = document.createElement("div");
  row.className = "app-header-row";

  const titleGroup = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = "WikiRadar";
  const subtitle = document.createElement("p");
  const subtitleText = `${articleCount} nearby attraction${articleCount !== 1 ? "s" : ""}`;
  subtitle.textContent = paused ? `${subtitleText} · paused` : subtitleText;
  titleGroup.append(h1, subtitle);

  const headerControls = document.createElement("div");
  headerControls.style.display = "flex";
  headerControls.style.alignItems = "center";
  headerControls.style.gap = "8px";

  if (onTogglePause) {
    const pauseBtn = document.createElement("button");
    pauseBtn.className = "pause-toggle";
    pauseBtn.setAttribute(
      "aria-label",
      paused ? "Resume updates" : "Pause updates",
    );
    pauseBtn.textContent = paused ? "\u25B6" : "\u23F8";
    pauseBtn.addEventListener("click", onTogglePause);
    headerControls.appendChild(pauseBtn);
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

/** Build and replace the contents of `container` with a nearby-articles list. */
export function renderNearbyList(
  container: HTMLElement,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
  onShowMore?: () => void,
  nextCount?: number,
  paused?: boolean,
  onTogglePause?: () => void,
): void {
  const isRerender = !!container.querySelector(".nearby-list");
  const savedScrollY = isRerender ? window.scrollY : 0;
  const savedFocus = isRerender ? captureFocus(container) : null;

  container.textContent = "";

  const header = renderNearbyHeader(
    articles.length,
    currentLang,
    onLangChange,
    paused ?? false,
    onTogglePause,
  );

  const list = document.createElement("ul");
  list.className = "nearby-list";

  for (const article of articles) {
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

    const info = document.createElement("div");
    info.className = "nearby-info";
    const name = document.createElement("span");
    name.className = "nearby-name";
    name.textContent = article.title;
    info.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "nearby-distance";
    badge.textContent = formatDistance(article.distanceM);

    item.append(info, badge);
    li.appendChild(item);
    list.appendChild(li);
  }

  container.append(header, list);

  const showMoreBtn = renderShowMoreButton(nextCount, onShowMore);
  if (showMoreBtn) container.appendChild(showMoreBtn);

  if (isRerender) {
    window.scrollTo(0, savedScrollY);
    restoreFocus(container, savedFocus);
  }
}
