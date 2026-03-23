import { APP_NAME } from "./config";

const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/3.0/";
const WIKIPEDIA_TOS_URL =
  "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use";
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

let activeTeardown: (() => void) | null = null;

/** Programmatically close the About dialog if open, resetting module state. */
export function hideAbout(): void {
  activeTeardown?.();
  activeTeardown = null;
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

/** Show the About dialog. Use hideAbout() to close programmatically. */
export function showAbout(onClose?: () => void): void {
  // Prevent stacking — call teardown so listeners are cleaned up
  if (activeTeardown) activeTeardown();

  const returnTarget = document.activeElement as HTMLElement | null;

  const dialog = document.createElement("dialog");
  dialog.className = "about-dialog";
  dialog.setAttribute("aria-label", "About");
  const close = document.createElement("button");
  close.className = "about-close";
  close.textContent = "\u00d7";
  close.setAttribute("aria-label", "Close");

  const title = document.createElement("h2");
  title.textContent = APP_NAME;

  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent =
    "Discover Wikipedia articles about nearby places using spherical nearest-neighbor search.";

  const section = document.createElement("div");
  section.className = "about-section";

  const attrHeading = document.createElement("h3");
  attrHeading.textContent = "Attribution";

  const wikiAttr = document.createElement("p");
  const wikiLink = link("Wikipedia", WIKIPEDIA_TOS_URL);
  const ccLink = link(
    "Creative Commons Attribution-ShareAlike 3.0",
    CC_BY_SA_URL,
  );
  wikiAttr.append(
    "Content sourced from ",
    wikiLink,
    ", available under the ",
    ccLink,
    " license.",
  );

  const osmAttr = document.createElement("p");
  const osmLink = link("OpenStreetMap", OSM_COPYRIGHT_URL);
  osmAttr.append("Map data \u00a9 ", osmLink, " contributors.");

  section.append(attrHeading, wikiAttr, osmAttr);
  dialog.append(close, title, tagline, section);
  document.body.appendChild(dialog);
  dialog.showModal();

  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    activeTeardown = null;
    dialog.close();
    dialog.remove();
    if (returnTarget?.isConnected) {
      returnTarget.focus();
    } else {
      const fallback = document.querySelector<HTMLElement>(".about-btn");
      fallback?.focus();
    }
    onClose?.();
  };

  activeTeardown = teardown;

  close.addEventListener("click", teardown);

  // Backdrop click: clicks on ::backdrop hit the dialog element itself
  // with coordinates outside its bounding rect.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        teardown();
      }
    }
  });

  // Native <dialog> fires "cancel" on Escape
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault(); // Prevent default close so our teardown handles cleanup
    teardown();
  });
}

/** Create an info button that opens the About dialog. */
export function createAboutButton(
  onClick: () => void,
  className = "header-icon-btn",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `${className} about-btn`;
  btn.setAttribute("aria-label", "About");
  btn.title = "About";
  btn.textContent = "\u24d8"; // ⓘ
  btn.addEventListener("click", onClick);
  return btn;
}
