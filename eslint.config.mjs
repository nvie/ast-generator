import tseslint from "typescript-eslint";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsParser from "@typescript-eslint/parser";
import eslint from "@eslint/js";

export default tseslint.config(
  { ignores: ["dist/*", "coverage/*", "node_modules/*"] },

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    files: ["src/*.ts", "src/**/*.ts"],

    plugins: {
      "simple-import-sort": simpleImportSort,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",

      // Each project's individual/local tsconfig.json defines the behavior
      // of the parser
      parserOptions: {
        project: ["./tsconfig.json"],
      },
    },

    // Rules that are enabled for _all_ packages by default
    rules: {
      "@typescript-eslint/no-explicit-any": "error",

      // -------------------------------
      // Not interested in these checks:
      // -------------------------------
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off", // Because we have a custom no-restricted-syntax rule for this
      "no-constant-condition": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",

      // -----------------------------
      // Enable auto-fixes for imports
      // -----------------------------
      "@typescript-eslint/consistent-type-imports": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",

      // ------------------------
      // Customized default rules
      // ------------------------
      eqeqeq: ["error", "always"],
      quotes: ["error", "double", "avoid-escape"],
      "object-shorthand": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        // Unused variables are fine if they start with an underscore
        { args: "all", argsIgnorePattern: "^_.*", varsIgnorePattern: "^_.*" },
      ],

      // --------------------------------------------------------------
      // "The Code is the To-Do List"
      // https://www.executeprogram.com/blog/the-code-is-the-to-do-list
      // --------------------------------------------------------------
      "no-warning-comments": [
        "error",
        { terms: ["xxx"], location: "anywhere" },
      ],
    },
  },
);
