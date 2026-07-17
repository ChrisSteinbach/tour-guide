/**
 * Popularity → weight-class mapping.
 *
 * Weight classes are per-language popularity percentiles: an article's class
 * encodes how it ranks by monthly pageviews among all articles of the same
 * language build, scaled to 0-255. Because the scale is relative, a single
 * app-side threshold (see HIGHLIGHT_MIN_WEIGHT in src/app/config.ts) means
 * "top X% most-viewed" in every language — small wikis calibrate themselves.
 */

/**
 * Assign a 0-255 weight class to each article by popularity percentile.
 *
 * class[i] = round(255 * below / N), where below = number of entries with
 * strictly fewer views than views[i] and N = views.length.
 *
 * Properties:
 * - Monotone: more views never yields a lower class.
 * - Ties share a class (equal views → equal class).
 * - Zero, negative, or non-finite views → class 0 (no evidence of
 *   popularity; same encoding as "unknown").
 * - The classes of a strict subset differ from the full set's — percentiles
 *   are relative to the input population. Production builds always run over
 *   a full language; --bounds/--limit dev builds get subset-relative classes.
 */
export function assignWeightClasses(views: readonly number[]): Uint8Array {
  const n = views.length;
  const classes = new Uint8Array(n);
  if (n === 0) return classes;

  const sorted = Array.from(views, sanitize).sort((a, b) => a - b);
  const classByViews = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    if (!classByViews.has(v)) {
      classByViews.set(v, Math.round((255 * i) / n));
    }
  }

  for (let i = 0; i < n; i++) {
    classes[i] = classByViews.get(sanitize(views[i]))!;
  }
  return classes;
}

function sanitize(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}
