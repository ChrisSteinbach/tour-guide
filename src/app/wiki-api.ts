import type { Lang } from "../lang";
import { USER_AGENT } from "../user-agent";

const WIKI_HEADERS = {
  "Api-User-Agent": USER_AGENT,
};

/**
 * Fallback pause when a 429 omits Retry-After. Matches Wikimedia's ~30-min
 * sliding window (see RateLimitError) so we don't keep retrying inside an
 * already-blocked window.
 */
const DEFAULT_RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * Thrown when Wikipedia's REST API returns 429. Carries the Retry-After
 * value so the caller can pause its queue for the full window instead of
 * hammering an already-blocked endpoint. Wikimedia's Envoy rate limiter
 * uses a sliding window (~30 min) and will return 429 for every uncached
 * article until the window expires — per-request retries are pointless.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Wikipedia API rate limited; retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Shape of the Wikipedia REST API /page/summary response (subset we use). */
interface WikiSummaryResponse {
  title?: string;
  extract?: string;
  description?: string;
  thumbnail?: { source?: string; width?: number; height?: number };
  content_urls?: { desktop?: { page?: string } };
}

export interface ArticleSummary {
  title: string;
  extract: string;
  description: string;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  pageUrl: string;
}

/** Build the Wikipedia REST API summary URL for a given article title. */
export function summaryUrl(title: string, lang: Lang = "en"): string {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`;
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_RETRY_AFTER_MS;
}

export interface WikiApiDeps {
  fetch: typeof globalThis.fetch;
}

export interface WikiApi {
  fetchArticleSummary: (title: string, lang?: Lang) => Promise<ArticleSummary>;
}

// In-memory LRU via Map insertion order. The app has two other caches at
// different layers — an IndexedDB array in tile-loader.ts and Workbox runtime
// caching in vite.config.ts. They intentionally differ in backend, lifetime,
// and eviction strategy, so no shared abstraction is warranted.
const MAX_CACHE_SIZE = 100;

export function createWikiApi(deps: WikiApiDeps): WikiApi {
  const cache = new Map<string, ArticleSummary>();

  async function fetchArticleSummary(
    title: string,
    lang: Lang = "en",
  ): Promise<ArticleSummary> {
    const cacheKey = `${lang}:${title}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }

    const res = await deps.fetch(summaryUrl(title, lang), {
      headers: WIKI_HEADERS,
    });
    if (res.status === 404) throw new Error("Article not found");
    if (res.status === 429) {
      throw new RateLimitError(
        parseRetryAfterMs(res.headers.get("Retry-After")),
      );
    }
    if (!res.ok) throw new Error(`Wikipedia API error: ${res.status}`);

    const data = (await res.json()) as WikiSummaryResponse;
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
    if (cache.size > MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return summary;
  }

  return { fetchArticleSummary };
}
