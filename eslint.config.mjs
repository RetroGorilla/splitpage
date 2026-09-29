import js from "@eslint/js";
import globals from "globals";

const issueRules = {
  "no-redeclare": "error",
  "no-undef": "error",
  // Unused catch bindings are punctuation; src/js uses var style.
  "no-unused-vars": ["error", { caughtErrors: "none" }],
  "prefer-const": "error",
  "no-empty": ["error", { allowEmptyCatch: true }]
};

export default [
  {
    ignores: [
      "node_modules/",
      "**/node_modules/",
      "dist/",
      ".update/",
      ".cache/",
      "desktop/.stage/",
      "index.html",
      ".claude/"
    ]
  },

  js.configs.recommended,

  {
    languageOptions: { ecmaVersion: "latest" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: issueRules
  },

  {
    files: ["src/js/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.browser
    }
  },

  {
    files: ["src/test/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    }
  },

  {
    // Loaded by browser, Electron and node; no globals allowed.
    files: ["shared/**/*.js"],
    languageOptions: {
      sourceType: "commonjs"
    }
  },

  {
    files: ["server/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  },

  {
    files: ["desktop/**/*.js"],
    ignores: ["desktop/tabstrip/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser }
    }
  },

  {
    files: ["desktop/tabstrip/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser
    }
  },

  {
    // ES5 on purpose.
    files: ["sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.serviceworker
    }
  },

  {
    files: ["*.mjs", "tools/**/*.mjs", "desktop/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node
    }
  }
];
