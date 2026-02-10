import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  root: "src/app",
  build: {
    outDir: "../../dist/app",
    emptyOutDir: true,
  },
  plugins: [basicSsl()],
});
