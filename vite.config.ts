import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serve data/triangulation-*.bin with gzip compression.
 * Falls back to data/triangulation.json for backwards compatibility.
 */
function serveData(): Plugin {
  return {
    name: "serve-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/(triangulation-\w+\.bin)$/);
        if (match) {
          try {
            const filePath = resolve(`data/${match[1]}`);
            const stat = statSync(filePath);
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Length", stat.size);
            res.setHeader("Last-Modified", stat.mtime.toUTCString());
            createReadStream(filePath).pipe(res);
          } catch {
            next();
          }
          return;
        }
        // Serve tile index: /tiles/{lang}/index.json
        const indexMatch = req.url?.match(/\/tiles\/(\w+)\/index\.json$/);
        if (indexMatch) {
          const filePath = resolve(`data/tiles/${indexMatch[1]}/index.json`);
          if (existsSync(filePath)) {
            const stat = statSync(filePath);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Length", stat.size);
            createReadStream(filePath).pipe(res);
          } else {
            res.writeHead(404);
            res.end();
          }
          return;
        }
        // Serve individual tile: /tiles/{lang}/{id}.bin
        const tileMatch = req.url?.match(/\/tiles\/(\w+)\/(\d{2}-\d{2})\.bin$/);
        if (tileMatch) {
          try {
            const filePath = resolve(
              `data/tiles/${tileMatch[1]}/${tileMatch[2]}.bin`,
            );
            const stat = statSync(filePath);
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Length", stat.size);
            createReadStream(filePath).pipe(res);
          } catch {
            next();
          }
          return;
        }
        if (req.url === "/triangulation.json") {
          try {
            const filePath = resolve("data/triangulation.json");
            const stat = statSync(filePath);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Length", stat.size);
            createReadStream(filePath).pipe(res);
          } catch {
            next();
          }
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
        name: "WikiRadar",
        short_name: "WikiRadar",
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
