// @vitest-environment jsdom

import { vi } from "vitest";
import { createPlaceSearch } from "./place-search";
import type { NominatimResult } from "./nominatim";

// Flush the microtask queue so a settled search promise's `.then`/`.finally`
// callbacks have run before we assert.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function submitQuery(element: HTMLElement, query: string): void {
  const input = element.querySelector(
    ".map-picker-search-input",
  ) as HTMLInputElement;
  const form = element.querySelector(
    ".map-picker-search-form",
  ) as HTMLFormElement;
  input.value = query;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("createPlaceSearch", () => {
  it("renders the matching places as a tappable list after submit", async () => {
    const search = vi.fn().mockResolvedValue([
      { displayName: "Paris, France", lat: 48.86, lon: 2.35 },
      { displayName: "Paris, Texas", lat: 33.66, lon: -95.56 },
    ] satisfies NominatimResult[]);
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    submitQuery(element, "Paris");
    await flush();

    const labels = [
      ...element.querySelectorAll(".map-picker-search-result"),
    ].map((el) => el.textContent);
    expect(search).toHaveBeenCalledWith("Paris");
    expect(labels).toEqual(["Paris, France", "Paris, Texas"]);
  });

  it("fires onSelect with numeric coordinates and hides the list when a result is tapped", async () => {
    const onSelect = vi.fn();
    const search = vi
      .fn()
      .mockResolvedValue([
        { displayName: "Paris, France", lat: 48.86, lon: 2.35 },
      ] satisfies NominatimResult[]);
    const { element } = createPlaceSearch({ search, onSelect });

    submitQuery(element, "Paris");
    await flush();
    (
      element.querySelector(".map-picker-search-result") as HTMLButtonElement
    ).click();

    expect(onSelect).toHaveBeenCalledWith({
      displayName: "Paris, France",
      lat: 48.86,
      lon: 2.35,
    });
    const [arg] = onSelect.mock.calls[0] as [NominatimResult];
    expect(typeof arg.lat).toBe("number");
    expect(typeof arg.lon).toBe("number");
    const list = element.querySelector(
      ".map-picker-search-results",
    ) as HTMLUListElement;
    expect(list.hidden).toBe(true);
    expect(list.querySelector(".map-picker-search-result")).toBeNull();
  });

  it("shows a no-results message when the search returns nothing", async () => {
    const search = vi.fn().mockResolvedValue([] satisfies NominatimResult[]);
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    submitQuery(element, "asdfghjkl");
    await flush();

    expect(
      element.querySelector(".map-picker-search-message")?.textContent,
    ).toBe("No results");
  });

  it("shows an error message when the search fails", async () => {
    const search = vi.fn().mockRejectedValue(new Error("network"));
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    submitQuery(element, "Paris");
    await flush();

    expect(
      element.querySelector(".map-picker-search-message")?.textContent,
    ).toMatch(/failed/i);
  });

  it("disables the submit control while a request is in flight", async () => {
    let resolveSearch: (results: NominatimResult[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<NominatimResult[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });
    const submit = element.querySelector(
      ".map-picker-search-submit",
    ) as HTMLButtonElement;

    submitQuery(element, "Paris");
    expect(submit.disabled).toBe(true);

    resolveSearch([]);
    await flush();
    expect(submit.disabled).toBe(false);
  });

  it("does not search when the query is only whitespace", () => {
    const search = vi.fn();
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    submitQuery(element, "   ");

    expect(search).not.toHaveBeenCalled();
  });
});
