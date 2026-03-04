/** Create the standard app header with WikiRadar title. */
export function createAppHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "app-header";
  const h1 = document.createElement("h1");
  h1.textContent = "WikiRadar";
  header.appendChild(h1);
  return header;
}
