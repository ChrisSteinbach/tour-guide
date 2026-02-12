import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serve data/triangulation.json directly, bypassing Vite's JSON module
 * transform which is extremely slow for large data files.
 */
function serveData(): Plugin {
  return {
    name: "serve-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/triangulation.json") return next();
        try {
          const filePath = resolve("data/triangulation.json");
          const stat = statSync(filePath);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Length", stat.size);
          res.setHeader("Cache-Control", "max-age=3600");
          createReadStream(filePath).pipe(res);
        } catch {
          next();
        }
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
        runtimeCaching: [
          {
            urlPattern: /\/triangulation\.json$/,
            handler: "CacheFirst",
            options: {
              cacheName: "triangulation-data",
            },
          },
        ],
      },
    }),
  ],
});
