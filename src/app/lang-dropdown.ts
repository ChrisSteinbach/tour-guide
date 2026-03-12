import { SUPPORTED_LANGS, LANG_NAMES } from "../lang";
import type { Lang } from "../lang";

/**
 * Create a custom language-selector dropdown with keyboard navigation
 * and ARIA listbox semantics.
 */
export function createLangDropdown(
  currentLang: Lang,
  onLangChange: (lang: Lang) => void,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "header-lang-select";

  const trigger = document.createElement("button");
  trigger.className = "lang-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute(
    "aria-label",
    `Wikipedia language: ${LANG_NAMES[currentLang]}`,
  );
  trigger.textContent = currentLang.toUpperCase();

  const listbox = document.createElement("ul");
  listbox.className = "lang-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", "Wikipedia language");
  listbox.hidden = true;

  for (const code of SUPPORTED_LANGS) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(code === currentLang));
    li.id = `lang-opt-${code}`;
    li.dataset.lang = code;
    li.textContent = `${code.toUpperCase()} · ${LANG_NAMES[code]}`;
    li.tabIndex = -1;
    if (code === currentLang) li.classList.add("lang-option-active");
    listbox.appendChild(li);
  }

  function setActive(li: HTMLElement) {
    const prev = listbox.querySelector(".lang-option-active");
    if (prev) {
      prev.classList.remove("lang-option-active");
      prev.setAttribute("aria-selected", "false");
    }
    li.classList.add("lang-option-active");
    li.setAttribute("aria-selected", "true");
  }

  // Self-cleaning outside-click handler: removes itself once wrapper
  // is detached from the DOM (e.g. after a header re-render).
  function onOutsideClick(e: Event) {
    if (!wrapper.isConnected) {
      document.removeEventListener("click", onOutsideClick);
      return;
    }
    if (!wrapper.contains(e.target as Node)) close();
  }

  function open() {
    listbox.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const active = listbox.querySelector<HTMLElement>(".lang-option-active");
    if (active && "scrollIntoView" in active) {
      active.scrollIntoView({ block: "nearest" });
    }
    requestAnimationFrame(() =>
      document.addEventListener("click", onOutsideClick),
    );
  }

  function close() {
    document.removeEventListener("click", onOutsideClick);
    listbox.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  trigger.addEventListener("click", () => {
    if (listbox.hidden) open();
    else close();
  });

  listbox.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-lang]");
    if (!li?.dataset.lang) return;
    setActive(li);
    close();
    onLangChange(li.dataset.lang as Lang);
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (listbox.hidden) open();
      const items = listbox.querySelectorAll<HTMLElement>("[data-lang]");
      if (e.key === "ArrowDown") items[0]?.focus();
      else items[items.length - 1]?.focus();
    }
  });

  listbox.addEventListener("keydown", (e) => {
    const items = Array.from(
      listbox.querySelectorAll<HTMLElement>("[data-lang]"),
    );
    const focused = document.activeElement as HTMLElement;
    const idx = items.indexOf(focused);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const lang = focused?.dataset.lang;
      if (lang) {
        setActive(focused);
        close();
        trigger.focus();
        onLangChange(lang as Lang);
      }
    } else if (e.key === "Escape") {
      close();
      trigger.focus();
    }
  });

  wrapper.append(trigger, listbox);
  return wrapper;
}
