import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream";
import { resolve } from "node:path";

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
      },
    }),
  ],
});
