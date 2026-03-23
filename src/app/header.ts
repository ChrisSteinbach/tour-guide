import { APP_NAME } from "./config";

/** Create the standard app header, optionally without the h1 title. */
export function createAppHeader({ title = true } = {}): HTMLElement {
  const header = document.createElement("header");
  header.className = "app-header";
  if (title) {
    const h1 = document.createElement("h1");
    h1.textContent = APP_NAME;
    header.appendChild(h1);
  }
  return header;
}
