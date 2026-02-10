import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";
import { formatDistance, wikipediaUrl } from "./format";

/** Render a detail header with back button, title, and distance. */
function renderDetailHeader(
  article: NearbyArticle,
  onBack: () => void,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "app-header detail-header";

  const back = document.createElement("button");
  back.className = "detail-back";
  back.textContent = "\u2190";
  back.setAttribute("aria-label", "Back");
  back.addEventListener("click", onBack);

  const title = document.createElement("div");
  title.className = "detail-header-text";
  const h1 = document.createElement("h1");
  h1.textContent = article.title;
  const sub = document.createElement("p");
  sub.textContent = formatDistance(article.distanceM);
  title.append(h1, sub);

  header.append(back, title);
  return header;
}

/** Render loading state for article detail view. */
export function renderDetailLoading(
  container: HTMLElement,
  article: NearbyArticle,
  onBack: () => void,
): void {
  container.innerHTML = "";

  const header = renderDetailHeader(article, onBack);
  const body = document.createElement("div");
  body.className = "status-screen";
  const dot = document.createElement("div");
  dot.className = "loading-dot";
  body.appendChild(dot);

  container.append(header, body);
}

/** Render the full article detail with summary content. */
export function renderDetailReady(
  container: HTMLElement,
  article: NearbyArticle,
  summary: ArticleSummary,
  onBack: () => void,
): void {
  container.innerHTML = "";

  const header = renderDetailHeader(article, onBack);
  const content = document.createElement("div");
  content.className = "detail-content";

  if (summary.thumbnailUrl) {
    const img = document.createElement("img");
    img.className = "detail-thumbnail";
    img.src = summary.thumbnailUrl;
    img.alt = summary.title;
    if (summary.thumbnailWidth) img.width = summary.thumbnailWidth;
    if (summary.thumbnailHeight) img.height = summary.thumbnailHeight;
    content.appendChild(img);
  }

  if (summary.description) {
    const desc = document.createElement("p");
    desc.className = "detail-description";
    desc.textContent = summary.description;
    content.appendChild(desc);
  }

  if (summary.extract) {
    const extract = document.createElement("p");
    extract.className = "detail-extract";
    extract.textContent = summary.extract;
    content.appendChild(extract);
  }

  const link = document.createElement("a");
  link.className = "detail-wiki-link";
  link.href = summary.pageUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Read on Wikipedia";
  content.appendChild(link);

  container.append(header, content);
}

/** Render error state for article detail view. */
export function renderDetailError(
  container: HTMLElement,
  article: NearbyArticle,
  message: string,
  onBack: () => void,
  onRetry: () => void,
): void {
  container.innerHTML = "";

  const header = renderDetailHeader(article, onBack);
  const body = document.createElement("div");
  body.className = "status-screen";

  const msg = document.createElement("p");
  msg.className = "status-message";
  msg.textContent = message;

  const retry = document.createElement("button");
  retry.className = "status-action";
  retry.textContent = "Retry";
  retry.addEventListener("click", onRetry);

  const fallback = document.createElement("a");
  fallback.className = "detail-wiki-link";
  fallback.href = wikipediaUrl(article.title);
  fallback.target = "_blank";
  fallback.rel = "noopener";
  fallback.textContent = "Open on Wikipedia";

  body.append(msg, retry, fallback);
  container.append(header, body);
}
