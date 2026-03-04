/**
 * Pipeline canary: validate that well-known geotagged articles appear
 * in extracted output with correct coordinates.
 *
 * Guards against silent data corruption from dump format changes.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Article } from "./extract-dump.js";
import type { Lang } from "../lang.js";

/** A known landmark with expected coordinates (±tolerance). */
interface Landmark {
  title: string;
  lat: number;
  lon: number;
}

/**
 * Known landmarks per language. Titles must match the Wikipedia article
 * title (spaces, not underscores) in that language's dump output.
 */
const LANDMARKS: Record<Lang, Landmark[]> = {
  en: [
    { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945 },
    { title: "Statue of Liberty", lat: 40.6892, lon: -74.0445 },
    { title: "Sydney Opera House", lat: -33.8568, lon: 151.2153 },
  ],
  de: [
    { title: "Eiffelturm", lat: 48.8584, lon: 2.2945 },
    { title: "Brandenburger Tor", lat: 52.5163, lon: 13.3777 },
  ],
  fr: [
    { title: "Tour Eiffel", lat: 48.8584, lon: 2.2945 },
    { title: "Arc de triomphe de l'Étoile", lat: 48.8738, lon: 2.295 },
  ],
  es: [
    { title: "Torre Eiffel", lat: 48.8584, lon: 2.2945 },
    { title: "Sagrada Familia", lat: 41.4036, lon: 2.1744 },
  ],
  it: [
    { title: "Torre Eiffel", lat: 48.8584, lon: 2.2945 },
    { title: "Colosseo", lat: 41.8902, lon: 12.4922 },
  ],
  ru: [
    { title: "Эйфелева башня", lat: 48.8584, lon: 2.2945 },
    { title: "Московский Кремль", lat: 55.752, lon: 37.6175 },
  ],
  zh: [
    { title: "埃菲尔铁塔", lat: 48.8584, lon: 2.2945 },
    { title: "故宫", lat: 39.9163, lon: 116.3972 },
  ],
  pt: [
    { title: "Torre Eiffel", lat: 48.8584, lon: 2.2945 },
    { title: "Cristo Redentor", lat: -22.9519, lon: -43.2105 },
  ],
  pl: [
    { title: "Wieża Eiffla", lat: 48.8584, lon: 2.2945 },
    { title: "Zamek Królewski w Warszawie", lat: 52.2479, lon: 21.0143 },
  ],
  nl: [
    { title: "Eiffeltoren", lat: 48.8584, lon: 2.2945 },
    { title: "Rijksmuseum", lat: 52.36, lon: 4.8852 },
  ],
  ko: [
    { title: "에펠탑", lat: 48.8584, lon: 2.2945 },
    { title: "경복궁", lat: 37.5796, lon: 126.977 },
  ],
  ar: [
    { title: "الجامع الأموي (دمشق)", lat: 33.5119, lon: 36.3067 },
    { title: "هرم منقرع", lat: 29.9725, lon: 31.1283 },
  ],
  sv: [
    { title: "Eiffeltornet", lat: 48.8584, lon: 2.2945 },
    { title: "Globen", lat: 59.2939, lon: 18.0834 },
  ],
  ja: [
    { title: "エッフェル塔", lat: 48.8584, lon: 2.2945 },
    { title: "東京タワー", lat: 35.6586, lon: 139.7454 },
  ],
};

/** Maximum allowed deviation in degrees. */
const TOLERANCE_DEG = 0.05;

export interface CanaryResult {
  passed: boolean;
  checked: number;
  matched: number;
  /** Landmarks found but with wrong coordinates (data corruption). */
  mismatches: string[];
  /** Landmarks not found in the output (expected for subset extractions). */
  missing: string[];
}

/**
 * Validate extracted NDJSON against known landmarks.
 *
 * Streams the file to build a title→{lat,lon} lookup for only the
 * landmark titles, then checks coordinates are within tolerance.
 *
 * Missing landmarks are reported separately from coordinate mismatches,
 * since missing articles are expected for bounded/limited extractions.
 */
export async function validateCanary(
  outputPath: string,
  lang: Lang,
): Promise<CanaryResult> {
  const landmarks = LANDMARKS[lang];

  const wantedTitles = new Set(landmarks.map((l) => l.title));
  const found = new Map<string, { lat: number; lon: number }>();

  const rl = createInterface({
    input: createReadStream(outputPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const article = JSON.parse(trimmed) as Article;
    if (wantedTitles.has(article.title)) {
      found.set(article.title, { lat: article.lat, lon: article.lon });
      // Stop early once all landmarks found
      if (found.size === wantedTitles.size) break;
    }
  }

  const mismatches: string[] = [];
  const missing: string[] = [];

  for (const lm of landmarks) {
    const actual = found.get(lm.title);
    if (!actual) {
      missing.push(`Missing: "${lm.title}"`);
      continue;
    }
    const dLat = Math.abs(actual.lat - lm.lat);
    const dLon = Math.abs(actual.lon - lm.lon);
    if (dLat > TOLERANCE_DEG || dLon > TOLERANCE_DEG) {
      mismatches.push(
        `"${lm.title}": expected (${lm.lat}, ${lm.lon}), got (${actual.lat}, ${actual.lon}) — off by (${dLat.toFixed(4)}°, ${dLon.toFixed(4)}°)`,
      );
    }
  }

  return {
    passed: mismatches.length === 0,
    checked: landmarks.length,
    matched: found.size,
    mismatches,
    missing,
  };
}
