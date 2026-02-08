// SPARQL query construction and HTTP execution for Wikidata coordinate extraction

export interface SparqlBinding {
  item: { type: string; value: string };
  itemLabel: { type: string; value: string };
  lat: { type: string; value: string; datatype?: string };
  lon: { type: string; value: string; datatype?: string };
  desc?: { type: string; value: string };
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
  bounds?: { south: number; north: number; west: number; east: number };
}

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

export function buildQuery({ limit, offset, bounds }: QueryOptions): string {
  const boundsFilter = bounds
    ? `FILTER(?lat >= ${bounds.south} && ?lat <= ${bounds.north} && ?lon >= ${bounds.west} && ?lon <= ${bounds.east})`
    : "";

  return `SELECT ?item ?itemLabel ?lat ?lon ?desc ?article WHERE {
  ?item wdt:P625 ?coord .
  ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en")
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  ${boundsFilter}
} ORDER BY ?item LIMIT ${limit} OFFSET ${offset}`;
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

  return (await response.json()) as SparqlResponse;
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
