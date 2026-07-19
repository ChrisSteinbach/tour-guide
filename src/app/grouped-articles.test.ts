import { createGroupView } from "./grouped-articles";
import type { NearbyArticle } from "./types";

// Fixture: five articles, distance-sorted. The first three (a0, a1, a2) share
// one coordinate and collapse into a single group led by the highest-weight
// member (a1, weight 9); d0 and e0 are each alone at their own coordinate.
const a0: NearbyArticle = {
  title: "A",
  lat: 1,
  lon: 1,
  distanceM: 10,
  weight: 5,
};
const a1: NearbyArticle = {
  title: "B",
  lat: 1,
  lon: 1,
  distanceM: 10,
  weight: 9,
};
const a2: NearbyArticle = {
  title: "C",
  lat: 1,
  lon: 1,
  distanceM: 10,
  weight: 1,
};
const d0: NearbyArticle = {
  title: "D",
  lat: 2,
  lon: 2,
  distanceM: 20,
  weight: 3,
};
const e0: NearbyArticle = {
  title: "E",
  lat: 3,
  lon: 3,
  distanceM: 30,
  weight: 0,
};
const articles = [a0, a1, a2, d0, e0];

describe("createGroupView", () => {
  describe("loadedGroupCount", () => {
    it("counts collapsed groups, not the flat article count", () => {
      const view = createGroupView(() => articles);

      expect(view.loadedGroupCount()).toBe(3);
    });
  });

  describe("getGroup", () => {
    it("returns the coincident trio as one group led by the highest-weight member", () => {
      const view = createGroupView(() => articles);

      const group = view.getGroup(0);

      expect(group!.representative).toBe(a1);
      expect(group!.members).toEqual([a0, a1, a2]);
    });

    it("returns a singleton group for an article with no coincident neighbors", () => {
      const view = createGroupView(() => articles);

      expect(view.getGroup(1)!.representative).toBe(d0);
      expect(view.getGroup(2)!.representative).toBe(e0);
    });

    it("returns undefined past the loaded prefix", () => {
      const view = createGroupView(() => articles);

      expect(view.getGroup(3)).toBeUndefined();
    });
  });

  describe("titleAt", () => {
    it("returns the representative's title at each group index", () => {
      const view = createGroupView(() => articles);

      expect(view.titleAt(0)).toBe("B");
      expect(view.titleAt(1)).toBe("D");
      expect(view.titleAt(2)).toBe("E");
    });

    it("returns null past the loaded prefix", () => {
      const view = createGroupView(() => articles);

      expect(view.titleAt(3)).toBeNull();
    });
  });

  describe("membersInRange", () => {
    it("returns the flat members of a single group", () => {
      const view = createGroupView(() => articles);

      expect(view.membersInRange(0, 1)).toEqual([a0, a1, a2]);
    });

    it("returns the flat members spanning multiple groups", () => {
      const view = createGroupView(() => articles);

      expect(view.membersInRange(1, 3)).toEqual([d0, e0]);
    });

    it("returns every member when the range covers all groups", () => {
      const view = createGroupView(() => articles);

      expect(view.membersInRange(0, 3)).toEqual([a0, a1, a2, d0, e0]);
    });

    it("returns an empty array for a zero-width range", () => {
      const view = createGroupView(() => articles);

      expect(view.membersInRange(2, 2)).toEqual([]);
    });

    it("clamps an out-of-bounds range to the loaded groups", () => {
      const view = createGroupView(() => articles);

      expect(view.membersInRange(-5, 99)).toEqual([a0, a1, a2, d0, e0]);
    });
  });

  describe("articleBoundsForGroupRange", () => {
    it("maps a single-group range to its article-index span", () => {
      const view = createGroupView(() => articles);

      expect(view.articleBoundsForGroupRange(0, 1)).toEqual({
        start: 0,
        end: 3,
      });
    });

    it("maps a multi-group range to its article-index span", () => {
      const view = createGroupView(() => articles);

      expect(view.articleBoundsForGroupRange(1, 3)).toEqual({
        start: 3,
        end: 5,
      });
    });

    it("maps the full group range to the full article span", () => {
      const view = createGroupView(() => articles);

      expect(view.articleBoundsForGroupRange(0, 3)).toEqual({
        start: 0,
        end: 5,
      });
    });

    it("clamps an out-of-bounds range to the loaded article span", () => {
      const view = createGroupView(() => articles);

      expect(view.articleBoundsForGroupRange(-2, 99)).toEqual({
        start: 0,
        end: 5,
      });
    });
  });

  describe("groupCountForArticleCount", () => {
    it("returns the loaded group count when the article count matches the loaded prefix exactly", () => {
      const view = createGroupView(() => articles);

      expect(view.groupCountForArticleCount(5)).toBe(3);
    });

    it("adds the not-yet-loaded tail 1:1 onto the loaded group count", () => {
      const view = createGroupView(() => articles);

      expect(view.groupCountForArticleCount(10)).toBe(8);
    });

    it("never returns fewer than the loaded group count", () => {
      const view = createGroupView(() => articles);

      expect(view.groupCountForArticleCount(3)).toBe(3);
    });

    it("floors at the loaded group count for an article count of zero", () => {
      const view = createGroupView(() => articles);

      expect(view.groupCountForArticleCount(0)).toBe(3);
    });
  });

  describe("with no articles loaded", () => {
    it("reports an empty view from every query method", () => {
      const view = createGroupView(() => []);

      expect(view.loadedGroupCount()).toBe(0);
      expect(view.getGroup(0)).toBeUndefined();
      expect(view.titleAt(0)).toBeNull();
      expect(view.membersInRange(0, 5)).toEqual([]);
      expect(view.articleBoundsForGroupRange(0, 5)).toEqual({
        start: 0,
        end: 0,
      });
    });

    it("passes an article count straight through when nothing is loaded", () => {
      const view = createGroupView(() => []);

      expect(view.groupCountForArticleCount(7)).toBe(7);
    });
  });

  describe("memoization by array identity", () => {
    it("recomputes groups when the underlying array reference changes", () => {
      let current: NearbyArticle[] = articles;
      const view = createGroupView(() => current);
      expect(view.loadedGroupCount()).toBe(3);

      current = [d0];

      expect(view.loadedGroupCount()).toBe(1);
      expect(view.getGroup(0)!.representative).toBe(d0);
    });
  });
});
