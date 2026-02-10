import type { NearbyArticle } from "./types";
import { formatDistance } from "./format";

/** Build and replace the contents of `container` with a nearby-articles list. */
export function renderNearbyList(
  container: HTMLElement,
  articles: NearbyArticle[],
  onSelectArticle: (article: NearbyArticle) => void,
): void {
  container.innerHTML = "";

  const header = document.createElement("header");
  header.className = "app-header";
  const h1 = document.createElement("h1");
  h1.textContent = "Tour Guide";
  const subtitle = document.createElement("p");
  subtitle.textContent = `${articles.length} nearby attraction${articles.length !== 1 ? "s" : ""}`;
  header.append(h1, subtitle);

  const list = document.createElement("ul");
  list.className = "nearby-list";

  for (const article of articles) {
    const li = document.createElement("li");
    const item = document.createElement("div");
    item.className = "nearby-item";
    item.setAttribute("role", "button");
    item.tabIndex = 0;
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
    const desc = document.createElement("span");
    desc.className = "nearby-desc";
    desc.textContent = article.desc ?? "";
    info.append(name, desc);

    const badge = document.createElement("span");
    badge.className = "nearby-distance";
    badge.textContent = formatDistance(article.distanceM);

    item.append(info, badge);
    li.appendChild(item);
    list.appendChild(li);
  }

  container.append(header, list);
}
