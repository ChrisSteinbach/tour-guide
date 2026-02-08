// SPARQL query construction and HTTP execution for Wikidata coordinate extraction

export interface SparqlBinding {
  item: { type: string; value: string };
  itemLabel: { type: string; value: string };
  lat: { type: string; value: string; datatype?: string };
  lon: { type: string; value: string; datatype?: string };
  itemDescription?: { type: string; value: string };
  article: { type: string; value: string };
}

export interface SparqlResponse {
  results: {
    bindings: SparqlBinding[];
  };
}

export interface QueryOptions {
  limit: number;
  offset: number;
  bounds: { south: number; north: number; west: number; east: number };
}

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

export function buildQuery({ limit, offset, bounds }: QueryOptions): string {
  return `SELECT ?item ?itemLabel ?lat ?lon ?itemDescription ?article WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${bounds.west} ${bounds.south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${bounds.east} ${bounds.north})"^^geo:wktLiteral .
  }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit} OFFSET ${offset}`;
}

export async function executeSparql(
  query: string,
  endpoint: string = WIKIDATA_ENDPOINT,
  fetchFn: typeof fetch = fetch,
): Promise<SparqlResponse> {
  const url = `${endpoint}?query=${encodeURIComponent(query)}`;

  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "tour-guide/1.0 (https://github.com/ChrisSteinbach/tour-guide)",
    },
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SparqlError(
      `SPARQL request failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as SparqlResponse;
  } catch {
    throw new SparqlError("Truncated or malformed JSON response", 0, text.slice(-200));
  }
}

export class SparqlError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "SparqlError";
  }
}
