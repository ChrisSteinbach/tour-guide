import { vi } from "vitest";
import { buildSearchUrl, searchPlaces } from "./nominatim";

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response;
}

describe("buildSearchUrl", () => {
  it("targets the Nominatim search endpoint with jsonv2 and a result limit", () => {
    const url = buildSearchUrl("Berlin");
    expect(url).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=Berlin",
    );
  });

  it("url-encodes spaces and accented characters in the query", () => {
    const url = buildSearchUrl("São Paulo");
    expect(url).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=S%C3%A3o+Paulo",
    );
  });
});

describe("searchPlaces", () => {
  it("requests the encoded query through the injected fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([]));

    await searchPlaces("New York", { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=New+York",
      expect.anything(),
    );
  });

  it("parses display names and converts string coordinates to numbers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          display_name: "Eiffel Tower, Paris, France",
          lat: "48.8584",
          lon: "2.2945",
        },
      ]),
    );

    const results = await searchPlaces("Eiffel Tower", { fetchFn });

    expect(results).toEqual([
      { displayName: "Eiffel Tower, Paris, France", lat: 48.8584, lon: 2.2945 },
    ]);
  });

  it("returns an empty array when there are no matches", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([]));

    const results = await searchPlaces("asdfghjkl", { fetchFn });

    expect(results).toEqual([]);
  });

  it("drops hits with missing names or non-numeric coordinates", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        { display_name: "Good Place", lat: "10", lon: "20" },
        { display_name: "No Coords", lat: "not-a-number", lon: "20" },
        { lat: "1", lon: "2" },
      ]),
    );

    const results = await searchPlaces("mixed", { fetchFn });

    expect(results).toEqual([{ displayName: "Good Place", lat: 10, lon: 20 }]);
  });

  it("throws when the response status is not ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve([]),
    });

    await expect(searchPlaces("rate limited", { fetchFn })).rejects.toThrow(
      "429",
    );
  });

  it("propagates network errors from fetch", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(searchPlaces("anything", { fetchFn })).rejects.toThrow(
      "offline",
    );
  });
});
