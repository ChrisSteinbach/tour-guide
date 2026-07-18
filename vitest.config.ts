import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Live-source mapping for the workspace package; the published entry
      // points at dist/ (lib/spherical-delaunay/package.json "exports").
      "spherical-delaunay": fileURLToPath(
        new URL("./lib/spherical-delaunay/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts", "lib/**/src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "lib/**/*.test.ts",
        "src/app/vite-env.d.ts",
        "lib/**/src/vendor/**",
      ],
    },
  },
});
