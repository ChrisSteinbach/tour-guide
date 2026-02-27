# WikiRadar

A Wikipedia-powered tour guide PWA that finds nearby articles based on your
geographic location. Uses spherical Delaunay triangulation for fast
nearest-neighbor search across over a million geotagged Wikipedia articles.

**[Try it live](https://chrissteinbach.github.io/tour-guide/)**

## How it works

1. **Extract** — Download Wikipedia SQL dumps and join geo-coordinate data with
   article titles
2. **Build** — Construct per-tile spherical Delaunay triangulations and
   serialize to compact binary files
3. **Query** — The PWA loads tiles on demand and performs O(√N) nearest-neighbor
   lookups via triangle walks on the unit sphere

Points are mapped to 3D Cartesian coordinates on a unit sphere, and the
spherical Delaunay triangulation is derived from their 3D convex hull. This
enables efficient point-location queries using greedy vertex walks with
great-circle distance. See [`docs/nearest-neighbor.md`](docs/nearest-neighbor.md)
for the theory and [`docs/architecture.md`](docs/architecture.md) for the
end-to-end data flow.

## Getting started

```bash
git clone https://github.com/ChrisSteinbach/tour-guide.git
cd tour-guide
npm install
npm run dev
```

The dev server starts at `https://localhost:5173/` with a self-signed
certificate (HTTPS is required for the Geolocation API). The server binds
`0.0.0.0`, so you can test on other devices on your network using
`https://<your-ip>:5173/`. Use the "Or try with demo data" option for quick
testing without GPS.

### Prerequisites

- **Node.js** 18+ (ES2022 target; tested with Node 20 and 22)

### Running tests

```bash
npm test              # Full lint + test suite
npm run test:watch    # Watch mode during development
```

### Quick pipeline test

The full extraction downloads multi-GB Wikipedia dumps. For local testing,
use `--limit` or `--bounds` to work with a small subset:

```bash
npm run pipeline -- --lang=en --limit=10000
```

## Commands

| Command                 | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`           | Start Vite dev server (HTTPS, binds 0.0.0.0)      |
| `npm run build`         | Production build to `dist/app/`                   |
| `npm test`              | Lint + tests                                      |
| `npm run test:watch`    | Tests in watch mode                               |
| `npm run test:coverage` | Tests with coverage report                        |
| `npm run lint`          | Type-check + ESLint + Prettier                    |
| `npm run extract`       | Extract geotagged articles from Wikipedia dumps   |
| `npm run pipeline`      | Build tiled triangulation from extracted articles |

## Data pipeline

### Extraction

Downloads Wikipedia `page` and `geo_tags` SQL dumps and joins them to produce
geotagged articles as NDJSON:

```bash
# Full extraction for a language
npm run extract -- --lang=en

# Reuse previously downloaded dumps
npm run extract -- --lang=sv --skip-download

# Geographic subset (south,north,west,east)
npm run extract -- --lang=en --bounds=49.44,50.19,5.73,6.53
```

Output format (one JSON object per line in `data/articles-{lang}.json`):

```json
{ "title": "Eiffel Tower", "lat": 48.8584, "lon": 2.2945 }
```

### Tiling and triangulation

Reads extracted articles, partitions them into a 5° lat/lon grid with 0.5°
buffer zones, builds a spherical Delaunay triangulation per tile, and writes
binary files:

```bash
npm run pipeline -- --lang=en
npm run pipeline -- --lang=en --limit=10000        # quick local test
npm run pipeline -- --lang=en --bounds=49.44,50.19,5.73,6.53
```

Output: `data/tiles/{lang}/` containing `index.json` and per-tile `.bin` files.
See [`docs/binary-format.md`](docs/binary-format.md) for the serialization
format and [`docs/tiling.md`](docs/tiling.md) for the tiling strategy.

### Automated refresh

A GitHub Actions workflow ([`pipeline.yml`](.github/workflows/pipeline.yml))
runs monthly to re-extract and rebuild tiles for all supported languages (en,
sv, ja). Tile archives are published to a `data-latest` GitHub Release.
Deployment ([`deploy.yml`](.github/workflows/deploy.yml)) downloads these
archives and deploys the app to GitHub Pages on every push to main.

## Architecture

```
src/
├── geometry/    Spherical math, convex hull, Delaunay, point location, serialization
├── pipeline/    Offline extraction and build (runs via tsx, not Vite)
├── app/         PWA frontend (Vite root)
├── lang.ts      Supported language definitions
└── tiles.ts     Tile grid constants and ID computation
```

- **`geometry/`** — Coordinate conversion, great-circle distance, incremental 3D
  convex hull, spherical Delaunay triangulation, triangle walks, and binary
  serialization. Shared by both the pipeline and the app.
- **`pipeline/`** — Downloads and parses Wikipedia SQL dumps, joins coordinates
  with article titles, and builds tiled binary triangulation files.
- **`app/`** — Installable PWA that requests the user's location, loads tiles on
  demand (cached in IndexedDB), performs nearest-neighbor queries, and displays
  nearby Wikipedia articles with descriptions fetched from the Wikipedia REST
  API.

## Tech stack

- **TypeScript** (strict mode, ES2022) — zero runtime dependencies
- **Vite** — dev server and production builds
- **Vitest** — test runner
- **Workbox** (via vite-plugin-pwa) — service worker for offline support
- **GitHub Actions** — CI, monthly data refresh, GitHub Pages deployment

## Supported languages

| Language      | Articles |
| ------------- | -------- |
| English (en)  | ~1.2M    |
| Swedish (sv)  | ~250K    |
| Japanese (ja) | ~180K    |

Counts are approximate and update monthly via the automated pipeline.

## Browser support

Requires a modern browser with IndexedDB, Service Workers, and the Geolocation API. Tested on recent versions of Chrome, Firefox, Safari, and Edge. No IE11 support.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — End-to-end system design
- [`docs/nearest-neighbor.md`](docs/nearest-neighbor.md) — Spherical nearest-neighbor theory
- [`docs/binary-format.md`](docs/binary-format.md) — Binary tile serialization format
- [`docs/tiling.md`](docs/tiling.md) — Geographic tiling strategy
- [`docs/data-extraction.md`](docs/data-extraction.md) — Wikipedia dump extraction pipeline

## License

[ISC](LICENSE)

This project includes vendored code from
[robust-predicates](https://github.com/mourner/robust-predicates) by Vladimir
Agafonkin (based on Jonathan Shewchuk's exact arithmetic predicates), released
into the public domain under the [Unlicense](https://unlicense.org). See
[`src/geometry/vendor/robust-predicates/LICENSE`](src/geometry/vendor/robust-predicates/LICENSE)
for details.
