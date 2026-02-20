import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  { ignores: ["dist/", "data/", "node_modules/"] },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript type-checked rules
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-wide rules
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "warn",
      "no-param-reassign": "error",

      // TypeScript-specific
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },

  // Pipeline files are CLI tools — console is their UI
  {
    files: ["src/pipeline/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Test file overrides
  {
    files: ["**/*.test.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
