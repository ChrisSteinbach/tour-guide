export interface ArticleSummary {
  title: string;
  extract: string;
  description: string;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  pageUrl: string;
}

const cache = new Map<string, ArticleSummary>();

/** Build the Wikipedia REST API summary URL for a given article title. */
export function summaryUrl(title: string): string {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
}

/** Fetch an article summary from the Wikipedia REST API (cached). */
export async function fetchArticleSummary(
  title: string,
): Promise<ArticleSummary> {
  const cached = cache.get(title);
  if (cached) return cached;

  const res = await fetch(summaryUrl(title));
  if (res.status === 404) throw new Error("Article not found");
  if (!res.ok) throw new Error(`Wikipedia API error: ${res.status}`);

  const data = await res.json();
  const summary: ArticleSummary = {
    title: data.title ?? title,
    extract: data.extract ?? "",
    description: data.description ?? "",
    thumbnailUrl: data.thumbnail?.source ?? null,
    thumbnailWidth: data.thumbnail?.width ?? null,
    thumbnailHeight: data.thumbnail?.height ?? null,
    pageUrl: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  };

  cache.set(title, summary);
  return summary;
}

/** Clear the in-memory cache (for testing). */
export function clearCache(): void {
  cache.clear();
}
