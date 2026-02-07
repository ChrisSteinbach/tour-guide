import { defineConfig } from "vite";

export default defineConfig({
  root: "src/app",
  build: {
    outDir: "../../dist/app",
    emptyOutDir: true,
  },
});
