/* ESLint, flat config (issue #68).
 *
 * WHY: nothing linted this repo until now. #59 was a `saveInFlight` declared
 * twice in what was then one enormous IIFE — `no-redeclare` catches that for
 * free. #66 turned src/js into 41 ES modules, which is what makes the rest of
 * it worth having: inside a module an undefined name and an unused binding
 * are both statically decidable, and before the conversion they were not.
 *
 * The four rules the issue names — no-redeclare, no-undef, no-unused-vars,
 * prefer-const — sit on top of eslint's `recommended` set. The first three
 * are already in `recommended`; they are listed again below so that the file
 * says out loud what this repo is committing to, and so that dropping
 * `recommended` some day would not quietly drop them.
 *
 * THE FILE MIX IS THE ENTIRE DIFFICULTY. This repo is four languages-by-
 * configuration in one tree, and a single blanket block would mis-lint most
 * of it:
 *
 *   src/js/*.js           ES modules, browser globals   (#66)
 *   src/test/*.mjs        ES modules, node globals      (#67)
 *   shared/*.js           CommonJS, NO globals          (shared/package.json
 *                         says "type": "commonjs"; #76)
 *   server/server.js      CommonJS, node globals        (server/package.json
 *                         says "type": "commonjs"; the root says "module")
 *   desktop/*.js          CommonJS, node + Electron     (no "type" field, so
 *                         node's default, commonjs)
 *   desktop/tabstrip/     classic browser script, no module wrapper at all
 *   sw.js                 classic service-worker script, ES5 on purpose
 *   *.mjs at the root,    ES modules, node globals
 *   tools/*.mjs
 *
 * Flat config does NOT read `package.json`'s `type` field — its default is
 * `sourceType: "module"` for .js and .mjs and `"commonjs"` only for .cjs — so
 * every CommonJS file here has to say so explicitly or `require`, `module`
 * and `exports` all become no-undef errors.
 */
import js from "@eslint/js";
import globals from "globals";

/* The four rules the issue asks for, applied everywhere below, plus the two
 * options that decide how `recommended` reads this codebase's one pervasive
 * idiom: best-effort work wrapped in try/catch, where the failure is an
 * expected outcome and there is nothing to say about it.
 *
 *   try { localStorage.setItem(k, v); } catch (e) {}
 *
 * There are 107 of those empty catch blocks and 238 unused catch bindings in
 * the tree. Both settings below are the rules' own documented options, not a
 * disable: every other kind of empty block is still an error, and every other
 * kind of unused binding — a variable, an import, a function, a parameter
 * after the last used one — is still an error, which is the part of
 * no-unused-vars issue #68 actually asks for ("unused exports and undefined
 * names become detectable").
 *
 * WHY THESE ARE SETTINGS AND NOT 345 FIXES. An unused catch binding cannot be
 * a defect; it is punctuation. The two ways to make eslint stop saying so are
 * to rewrite every one of those catches — `catch (e) {}` becomes `catch {}`,
 * ES2019 — or to say here that this repo does not consider them findings.
 * Rewriting them would put ES2019 syntax into 202 places in src/js, which is
 * deliberately written in `var`/`function` style throughout, and that is a
 * house-style decision that does not belong inside "add a linter". desktop/
 * has already made the same call in its own dialect: drafts.js spells the
 * binding `catch (_)` precisely to say "deliberately ignored".
 *
 * If src/js is ever modernised, delete these two lines and the rules start
 * asking for `catch {}` everywhere on their own.
 *
 * no-unused-vars keeps `args: "after-used"` (the default): an unused
 * parameter that precedes a used one cannot be removed without changing the
 * call signature, so it is not reported.
 */
const issueRules = {
  "no-redeclare": "error",
  "no-undef": "error",
  "no-unused-vars": ["error", { caughtErrors: "none" }],
  "prefer-const": "error",
  "no-empty": ["error", { allowEmptyCatch: true }]
};

export default [
  {
    /* Generated or vendored output. index.html is written by build.mjs and is
       never a source file (eslint would not pick up .html anyway, but saying
       so here keeps the list honest). dist/, .update/ and .cache/ are build
       and release artefacts, all three already gitignored.

       .claude/ is the run-splitpage-app skill's own driver and test scripts.
       It is tooling for running the app, not the app, and issue #68 scopes
       this to src/js, server/, desktop/, build.mjs and update.mjs — so it is
       out of scope here rather than deliberately exempt. */
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

  /* Defaults for everything that follows: modern syntax, and the four rules.
     Each block below then supplies the globals and the module system. */
  {
    languageOptions: { ecmaVersion: "latest" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: issueRules
  },

  /* ---- src/js: the app, ES modules in a browser (#66) ---- */
  {
    files: ["src/js/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.browser
    }
  },

  /* ---- src/test: node --test suites over the same modules (#67) ---- */
  {
    files: ["src/test/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      /* jsdom is installed into globalThis by src/test/_dom.mjs, so a suite
         legitimately names `document` and `window` as bare globals. */
      globals: { ...globals.node, ...globals.browser }
    }
  },

  /* ---- shared/: CommonJS, and no globals at all (#76) ----
     One copy of the policy three different module systems have to load: the
     browser bundle (esbuild follows an ES module's import straight into
     these files), desktop/main.js (a CommonJS require at startup) and
     node --test. CommonJS is the only format all three read without a build
     step or an await, and shared/package.json says "type": "commonjs" so
     node agrees — the same arrangement server/ has.

     The globals are deliberately NOT node's and NOT the browser's: nothing
     here may touch a document, a window, a filesystem or a process, because
     it runs in all three. Only `module` and `exports` are named, which is
     what sourceType "commonjs" already gives — so this block supplies no
     globals object at all and no-undef then reports any DOM or node name as
     the error it would be. */
  {
    files: ["shared/**/*.js"],
    languageOptions: {
      sourceType: "commonjs"
    }
  },

  /* ---- server/: CommonJS, node only ---- */
  {
    files: ["server/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  },

  /* ---- desktop/*.js: CommonJS — Electron main and the two preloads ----
     The preloads run in a renderer's isolated world: they have node's
     `require` AND the page's `window`/`location`, so both sets apply. */
  {
    files: ["desktop/**/*.js"],
    ignores: ["desktop/tabstrip/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser }
    }
  },

  /* ---- desktop/tabstrip/: a classic browser script ----
     Loaded from splitpage://tabstrip with a plain <script> tag — no module
     wrapper, no bundler — so its top-level `var`s and `function`s are the
     file's interface to its own HTML. sourceType "script" is what makes that
     legal rather than a parse-level oddity.

     Its house rule is var/function, and this config does not fight that:
     `prefer-const` only ever reports `let`, never `var` (and `no-var` is not
     enabled anywhere in this repo), so the rule set is a no-op on its
     declarations while still catching an undefined name or a dead binding. */
  {
    files: ["desktop/tabstrip/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser
    }
  },

  /* ---- sw.js: the service worker ----
     SCOPED, NOT EXCLUDED. The worker is deliberately ES5 (var/function) and
     #79 says in as many words that it is not being modernised — but excluding
     it would throw away exactly the checks it most needs. It is the one file
     that is neither bundled nor unit-tested, it runs in a context where a
     typo in `caches` or `clients` is a silent install failure, and no-undef
     over the service-worker globals is the only thing in the repo that would
     catch that.

     So: service-worker globals, sourceType "script" (it is not a module),
     and the style rules left exactly as they are for every other file —
     because `prefer-const` reports only `let` and this file has none, and
     `no-var` is not enabled. Nothing here can rewrite its ES5. If `no-var`
     is ever added repo-wide, sw.js needs an override at that point. */
  {
    files: ["sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.serviceworker
    }
  },

  /* ---- build, launcher, packaging and test tooling: ES modules on node ---- */
  {
    files: ["*.mjs", "tools/**/*.mjs", "desktop/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node
    }
  }
];
