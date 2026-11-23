// @ts-check
import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Use @actions/core logging in the action itself.
      "no-console": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    // Test helpers and scripts are plain JS run directly by Node.
    files: ["**/*.mjs", "eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-console": "off" },
  },
  {
    files: ["test/**"],
    rules: { "no-console": "off" },
  },
  prettier,
)
