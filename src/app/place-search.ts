// Place-search UI for the map picker: a search box plus a tappable results
// list. Deliberately free of Leaflet — it only knows how to run a search and
// report the chosen result through `onSelect`, so the Leaflet glue in
// map-picker.ts stays thin and this whole widget is testable in jsdom.

import type { NominatimResult } from "./nominatim";

export interface PlaceSearchDeps {
  /** Runs a geocoding query (injected so tests stay offline). */
  search: (query: string) => Promise<NominatimResult[]>;
  /** Called when the user taps a result. Coordinates are numbers. */
  onSelect: (result: NominatimResult) => void;
}

export interface PlaceSearchHandle {
  /** Root element to mount above the map. */
  element: HTMLElement;
}

export function createPlaceSearch({
  search,
  onSelect,
}: PlaceSearchDeps): PlaceSearchHandle {
  const wrapper = document.createElement("div");
  wrapper.className = "map-picker-search";

  const form = document.createElement("form");
  form.className = "map-picker-search-form";
  form.setAttribute("role", "search");

  const input = document.createElement("input");
  input.type = "search";
  input.className = "map-picker-search-input";
  input.placeholder = "Search for a place…";
  input.setAttribute("aria-label", "Search for a place");
  input.autocomplete = "off";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "map-picker-search-submit";
  submit.textContent = "Search";

  form.append(input, submit);

  const results = document.createElement("ul");
  results.className = "map-picker-search-results";
  results.hidden = true;

  wrapper.append(form, results);

  function hideResults(): void {
    results.textContent = "";
    results.hidden = true;
  }

  function showMessage(text: string): void {
    results.textContent = "";
    const li = document.createElement("li");
    li.className = "map-picker-search-message";
    li.textContent = text;
    results.appendChild(li);
    results.hidden = false;
  }

  function renderResults(items: NominatimResult[]): void {
    results.textContent = "";
    for (const item of items) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-picker-search-result";
      button.textContent = item.displayName;
      button.addEventListener("click", () => {
        onSelect(item);
        hideResults();
      });
      li.appendChild(button);
      results.appendChild(li);
    }
    results.hidden = false;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query === "") return;

    // Disable the control while in flight: prevents duplicate requests and
    // respects Nominatim's "no rapid-fire queries" policy.
    submit.disabled = true;

    search(query)
      .then((items) => {
        if (items.length === 0) {
          showMessage("No results");
        } else {
          renderResults(items);
        }
      })
      .catch(() => {
        showMessage("Search failed. Please try again.");
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  return { element: wrapper };
}
