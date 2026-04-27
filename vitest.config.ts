import { defineConfig } from "vitest/config";

export default defineConfig({
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
