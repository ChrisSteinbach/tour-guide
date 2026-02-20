import type { Lang } from "../lang";

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
export function summaryUrl(title: string, lang: Lang = "en"): string {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`;
}

/** Fetch an article summary from the Wikipedia REST API (cached). */
export async function fetchArticleSummary(
  title: string,
  lang: Lang = "en",
): Promise<ArticleSummary> {
  const cacheKey = `${lang}:${title}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(summaryUrl(title, lang));
  if (res.status === 404) throw new Error("Article not found");
  if (!res.ok) throw new Error(`Wikipedia API error: ${res.status}`);

  const data = (await res.json()) as {
    title?: string;
    extract?: string;
    description?: string;
    thumbnail?: { source?: string; width?: number; height?: number };
    content_urls?: { desktop?: { page?: string } };
  };
  const summary: ArticleSummary = {
    title: data.title ?? title,
    extract: data.extract ?? "",
    description: data.description ?? "",
    thumbnailUrl: data.thumbnail?.source ?? null,
    thumbnailWidth: data.thumbnail?.width ?? null,
    thumbnailHeight: data.thumbnail?.height ?? null,
    pageUrl:
      data.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  };

  cache.set(cacheKey, summary);
  return summary;
}

/** Clear the in-memory cache (for testing). */
export function clearCache(): void {
  cache.clear();
}
