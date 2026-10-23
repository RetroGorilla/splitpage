import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts", "**/*.mts", "**/*.cts"];

const commentFree = [
  "src/core/**",
  "src/application/**",
  "src/contracts/**",
  "src/adapters/**",
  "src/features/**",
  "src/bootstrap/**",
  "src/legacy/**",
  "tests/**"
];

const issueRules = {
  "no-redeclare": "error",
  "no-undef": "error",
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
    files: ["src/js/**/*.js", "src/adapters/storage/02c-blobs.js", "src/adapters/storage/02d-gallery.js", "src/adapters/storage/03c-history-idb.js", "src/features/rows/row-motion.js", "src/features/notices/busy.js", "src/features/editing/cell-reach.js", "src/adapters/desktop/voice-relay.js", "src/features/script-zoom/script-zoom.js", "src/features/rows/read-time.js", "src/features/help/help.js", "src/features/gallery/annotate.js", "src/features/rundown/rundown.js", "src/features/editing/draft-edit.js"],
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
  },

  {
    files: ["build.mjs"],
    rules: { "no-control-regex": "off" }
  },

  {
    files: [
      "src/core/document/gallery.ts",
      "src/core/document/media.ts",
      "src/core/document/person-colors.ts",
      "src/core/document/text-policy.ts"
    ],
    rules: { "no-control-regex": "off" }
  },

  {
    files: ["src/core/text/runs.ts", "src/js/09-find-replace.js"],
    rules: { "no-control-regex": "off" }
  },

  ...tseslint.configs.strict.map((config) => ({ ...config, files: typescriptFiles })),

  {
    files: typescriptFiles,
    languageOptions: { sourceType: "module" },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error"
    }
  },

  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.core.json", "./tsconfig.web.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unnecessary-type-parameters": "error",
      "@typescript-eslint/method-signature-style": ["error", "property"]
    }
  },

  {
    files: ["types/*.d.ts"],
    rules: { "@typescript-eslint/method-signature-style": "off" }
  },

  {
    files: commentFree,
    linterOptions: { noInlineConfig: true }
  }
];
