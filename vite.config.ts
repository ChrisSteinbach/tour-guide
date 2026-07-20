import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { APP_NAME } from "./src/app/config";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const BINARY = "application/octet-stream";

/**
 * Request paths the dev server maps straight onto files under `data/`, so the
 * app sees the same URLs it will see on Pages without a build step. `path`
 * receives the pattern's capture groups.
 *
 * The digest route is listed before the plain tile route only for readability
 * — `\d{2}-\d{2}\.bin$` cannot match a `.digest.bin` filename — but keeping
 * the more specific pattern first means that stays true if either is loosened.
 */
const DATA_ROUTES: {
  pattern: RegExp;
  path: (m: RegExpMatchArray) => string;
  type: string;
}[] = [
  {
    pattern: /\/tiles\/(\w+)\/index\.json$/,
    path: (m) => `data/tiles/${m[1]}/index.json`,
    type: "application/json",
  },
  {
    pattern: /\/tiles\/(\w+)\/farfield\.bin$/,
    path: (m) => `data/tiles/${m[1]}/farfield.bin`,
    type: BINARY,
  },
  {
    pattern: /\/tiles\/(\w+)\/(\d{2}-\d{2})\.digest\.bin$/,
    path: (m) => `data/tiles/${m[1]}/${m[2]}.digest.bin`,
    type: BINARY,
  },
  {
    pattern: /\/tiles\/(\w+)\/(\d{2}-\d{2})\.bin$/,
    path: (m) => `data/tiles/${m[1]}/${m[2]}.bin`,
    type: BINARY,
  },
];

/**
 * Serve tile data from the data/ directory during development.
 *
 * A missing file answers 404 rather than falling through to Vite's SPA
 * fallback. The fallback would return index.html with a 200, which every one
 * of these callers would accept as a successful fetch and then fail to decode;
 * the loaders all treat 404 as a permanent, non-retryable miss, which is what
 * a tile that was never generated actually is.
 */
function serveData(): Plugin {
  return {
    name: "serve-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        for (const route of DATA_ROUTES) {
          const match = req.url?.match(route.pattern);
          if (!match) continue;

          const filePath = resolve(route.path(match));
          if (!existsSync(filePath)) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.setHeader("Content-Type", route.type);
          res.setHeader("Content-Length", statSync(filePath).size);
          createReadStream(filePath).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: "src/app",
  base: "/",
  server: {
    host: "0.0.0.0",
  },
  build: {
    outDir: "../../dist/app",
    emptyOutDir: true,
  },
  plugins: [
    serveData(),
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: "Discover Wikipedia articles about places near you",
        theme_color: "#1a73e8",
        background_color: "#f5f5f5",
        display: "standalone",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg}"],
        runtimeCaching: [
          {
            // Data files (.bin tiles, index.json) are managed by the app's
            // own IDB cache. Exclude from SW caching so fetches always
            // reach the network.
            urlPattern: /\.(bin|json)$/,
            handler: "NetworkOnly",
          },
          {
            // OSM tile cache for the map picker
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
            handler: "CacheFirst",
            options: {
              cacheName: "osm-tiles",
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
            },
          },
          {
            // Wikipedia REST API cache — serves stale while revalidating in
            // background. Update docs/architecture.md if changing these values.
            urlPattern: /^https:\/\/\w+\.wikipedia\.org\/api\/rest_v1\//,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "wikipedia-api",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
              },
            },
          },
        ],
      },
    }),
  ],
});
