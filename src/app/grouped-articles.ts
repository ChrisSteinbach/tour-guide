// Group-index view over the flat, distance-sorted article list that backs
// infinite scroll. The virtual scroll renders ONE fixed-height row per
// coincident group (a representative + a "+N more" affordance) instead of one
// row per article, so a big co-located cluster no longer draws N identical
// rows. See src/app/coincident.ts for why clusters exist.
//
// Only the *view* is grouped: the ArticleWindow, `getArticleByIndex`, and
// `state.phase.articles` stay flat, so the map/radar (which collapse their own
// input independently) are unaffected. This module is the single place that
// translates between article-index space (what the window loads) and
// group-index space (what the virtual scroll renders).

import { collapseCoincident, type CoincidentGroup } from "./coincident";
import type { NearbyArticle } from "./types";

export interface GroupView {
  /** Collapsed group at group-index `i`, or undefined if beyond the loaded prefix. */
  getGroup(i: number): CoincidentGroup | undefined;
  /** Number of collapsed groups in the currently loaded prefix. */
  loadedGroupCount(): number;
  /** Representative title at group-index `i` (for enrichment), or null. */
  titleAt(i: number): string | null;
  /**
   * Flat members of every group in `[startGroup, endGroup)`, in list order.
   * Feeds the map/radar sync, which re-collapse this flat slice themselves —
   * so a single visible cluster row still yields all its members (and thus the
   * correct marker count).
   */
  membersInRange(startGroup: number, endGroup: number): NearbyArticle[];
  /** Article-index span covered by the groups in `[startGroup, endGroup)`. */
  articleBoundsForGroupRange(
    startGroup: number,
    endGroup: number,
  ): { start: number; end: number };
  /**
   * Convert an article-space count (a loaded or optimistic total used to size
   * the virtual list) into a group-space count. The loaded prefix collapses
   * exactly; the not-yet-loaded tail is assumed 1:1 (no collapsing) — an upper
   * bound that never under-sizes the scroll and converges to the exact count
   * as the tail loads.
   */
  groupCountForArticleCount(articleCount: number): number;
}

/**
 * Create a GroupView backed by `getArticles`, which returns the current flat
 * loaded list (`state.phase.articles`). Grouping is memoized by array identity:
 * `state.phase.articles` is replaced only when the window re-syncs, so the same
 * reference is served across a render pass and recomputed exactly when the data
 * changes — no explicit invalidation needed.
 */
export function createGroupView(getArticles: () => NearbyArticle[]): GroupView {
  let cachedInput: NearbyArticle[] | null = null;
  let cachedGroups: CoincidentGroup[] = [];
  // Prefix sums of member counts: starts[k] is the article index at which
  // group k begins. Length is cachedGroups.length + 1; the final entry equals
  // the loaded article count.
  let cachedStarts: number[] = [0];

  function ensureFresh(): void {
    const input = getArticles();
    if (input === cachedInput) return;
    cachedInput = input;
    cachedGroups = collapseCoincident(input);
    const starts = new Array<number>(cachedGroups.length + 1);
    starts[0] = 0;
    for (let i = 0; i < cachedGroups.length; i++) {
      starts[i + 1] = starts[i] + cachedGroups[i].members.length;
    }
    cachedStarts = starts;
  }

  function clampGroupIndex(i: number): number {
    if (i < 0) return 0;
    if (i > cachedGroups.length) return cachedGroups.length;
    return i;
  }

  return {
    getGroup(i) {
      ensureFresh();
      return cachedGroups[i];
    },

    loadedGroupCount() {
      ensureFresh();
      return cachedGroups.length;
    },

    titleAt(i) {
      ensureFresh();
      return cachedGroups[i]?.representative.title ?? null;
    },

    membersInRange(startGroup, endGroup) {
      ensureFresh();
      const start = clampGroupIndex(startGroup);
      const end = clampGroupIndex(endGroup);
      const members: NearbyArticle[] = [];
      for (let i = start; i < end; i++) {
        for (const member of cachedGroups[i].members) members.push(member);
      }
      return members;
    },

    articleBoundsForGroupRange(startGroup, endGroup) {
      ensureFresh();
      const start = clampGroupIndex(startGroup);
      const end = clampGroupIndex(endGroup);
      return { start: cachedStarts[start], end: cachedStarts[end] };
    },

    groupCountForArticleCount(articleCount) {
      ensureFresh();
      const loadedArticles = cachedInput?.length ?? 0;
      const loadedGroups = cachedGroups.length;
      return loadedGroups + Math.max(0, articleCount - loadedArticles);
    },
  };
}
