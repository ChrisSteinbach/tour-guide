import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream";
import { resolve } from "node:path";

/** Compute MD5 revision hash for a file in data/, or null if it doesn't exist. */
function dataRevision(filename: string): string | null {
  const path = resolve("data", filename);
  if (!existsSync(path)) return null;
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/**
 * Serve data/triangulation.bin with gzip compression.
 * Falls back to data/triangulation.json for backwards compatibility.
 */
function serveData(): Plugin {
  return {
    name: "serve-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/triangulation.bin") {
          try {
            const filePath = resolve("data/triangulation.bin");
            statSync(filePath); // ensure file exists
            const acceptGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
            res.setHeader("Content-Type", "application/octet-stream");
            if (acceptGzip) {
              res.setHeader("Content-Encoding", "gzip");
              pipeline(createReadStream(filePath), createGzip(), res, () => {});
            } else {
              const stat = statSync(filePath);
              res.setHeader("Content-Length", stat.size);
              createReadStream(filePath).pipe(res);
            }
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
        name: "Tour Guide",
        short_name: "Tour Guide",
        description: "Wikipedia-powered tour guide for nearby attractions",
        theme_color: "#1a73e8",
        background_color: "#f5f5f5",
        display: "standalone",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg}"],
        additionalManifestEntries: dataRevision("triangulation.bin")
          ? [{ url: "triangulation.bin", revision: dataRevision("triangulation.bin")! }]
          : [],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/en\.wikipedia\.org\/api\/rest_v1\//,
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
