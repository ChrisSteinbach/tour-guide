import { APP_NAME } from "./config";

/** Create the standard app header. */
export function createAppHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "app-header";
  const h1 = document.createElement("h1");
  h1.textContent = APP_NAME;
  header.appendChild(h1);
  return header;
}
