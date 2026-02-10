import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

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
