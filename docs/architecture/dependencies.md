# Dependency and comment gates

Two scripts hold the layer rules and the no-comment rule from
[the implementation plan](../IMPLEMENTATION-PLAN.md) (sections 2 and 3).
Both parse source with the TypeScript compiler, so strings, regular
expressions, template literals and URLs are never mistaken for imports or
comments.

| Command | What it checks | Baseline |
| --- | --- | --- |
| `npm run check:deps` (`tools/dep-report.mjs`) | Layer rules, platform imports and globals, unresolvable modules, computed dynamic loads, cycles through migrated folders | `tools/dep-baseline.json` |
| `npm run check:comments` (`tools/comment-gate.mjs`) | Comments in authored JS/TS, CSS, HTML, shell, PowerShell and batch files | `tools/comment-baseline.json` |

Both fail on anything new and on anything the baseline lists that has gone.
`--prune` removes gone entries and refuses to add new ones. `--init` writes a
baseline only when none exists. `node tools/dep-report.mjs --metrics` prints the
informational numbers, which are not a pass/fail condition.

## Layers

`tools/dep-report.mjs` assigns every file a layer from its path and checks each
resolved edge (static imports, re-exports, literal `require`, literal dynamic
`import()` and `import("…")` type references).

| Layer | Path | May import |
| --- | --- | --- |
| `core/document` | `src/core/document/` | itself, `shared` |
| `core/text` | `src/core/text/` | itself, `core/document`, `shared` |
| `core/merge` | `src/core/merge/` | itself, `core/document`, `core/text`, `shared` |
| `core/production` | `src/core/production/` | itself, `core/document`, `core/text`, `shared` |
| `core` | any other `src/core/` folder | any core layer, `shared` |
| `contracts` | `src/contracts/` | itself, `shared` |
| `application` | `src/application/` | itself, core, `contracts`, `shared` |
| `adapters` | `src/adapters/` | itself, core, `application`, `contracts`, `shared` |
| `features/<name>` | `src/features/<name>/` | itself, core, `application`, `contracts`, `shared` |
| `legacy` | `src/legacy/` | itself, core, `legacy-js`, `application`, `contracts`, `adapters`, `shared` |
| `bootstrap` | `src/bootstrap/` | anything |
| `shared` | `shared/` | itself |
| `tests` | `src/test/`, `tests/`, `*.test.*` | anything |
| `legacy-js`, `server`, `desktop` | `src/js/`, `server/`, `desktop/` | anything except tests |

Core, `contracts`, `application`, `shared` and feature layers may not import a
Node built-in or a package (`platform-import`). Core, `contracts`,
`application` and `shared` may not use browser, Node, timer or network globals
(`platform-global`); CommonJS `require`, `module` and `exports` are allowed in
CommonJS files.

A cycle containing any file in a migrated layer (`core`, `contracts`,
`application`, `adapters`, `features`, `bootstrap`, `legacy`) fails whether it
is a runtime cycle or only closes through `import type`, and whether or not it
passes through `src/js`. Such a cycle cannot be baselined.

## Recorded exceptions

The baseline is a list of `{ rule, source, target }`. An entry may carry a
`reason`; `--prune` keeps it.

- **`shared/video-embed.js` platform globals** (`URL`, `AbortController`,
  `setTimeout`, `clearTimeout`, `TextDecoder`). It fetches oEmbed data and
  thumbnails for the desktop shell. Moving the fetch behind an injected
  transport is 4.x desktop work (plan section 8).
- **`desktop/main.js` computed `require`** of `shared/doc-id-policy.js`,
  `history-policy.js`, `history-store.js` and `video-embed.js` through
  `SHARED_ROOT`. The packaged app and the checkout keep `shared/` in different
  places; the path is chosen at start-up.
- **`desktop/verify-dist-payload.mjs`** loads electron-builder's 7-Zip toolset
  through `require.resolve`, so the file is found in whichever copy of
  `app-builder-lib` is installed.
- **Test harnesses** (`desktop/test/verify-dist-payload.test.mjs`,
  `tools/test-run-suites.mjs`, `tools/test-update.mjs`) import the module under
  test by a computed file URL so the same file can be loaded from a temporary
  copy.

## Comment gate

Scanned: every tracked or untracked-but-not-ignored file of these kinds,
except `node_modules/`, `.claude/handoff/` and the generated `index.html`:

| Files | Parser | What counts as a comment |
| --- | --- | --- |
| `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `eslint.config.mjs` included | TypeScript (`tools/source-scan.mjs`) | `//` and `/* */` outside strings, templates and regexes |
| `.css`, `.html` (inline `<style>` and script too) | `tools/source-scan.mjs` | `/* */`, `<!-- -->` |
| `.sh`, `.ps1`, `.bat`, `.cmd` | `tools/source-scan.mjs` | `#` at a word start outside quotes and heredocs, `<# #>`, `rem`/`::` |
| `.yml`, `.yaml` | the `yaml` package's CST (`tools/config-comments.mjs`) | every YAML comment token; `#` in a quoted scalar, a URL or a block scalar's content is not one |
| `run:` of a step in `.github/workflows/*.yml` or an `action.yml` | the shell rules above, in the step's `shell:` (else `defaults.run.shell`, else `pwsh` on a Windows runner, else `bash`) | a `#` comment inside the script, whole-line or trailing; `$#`, `${#x}`, `'#'`, heredoc bodies and `<<<` here-strings are not; a `#!` line is, because the runner ignores it |
| `Dockerfile`, `Dockerfile.*`, `*.dockerfile` | `tools/config-comments.mjs` | whole-line `#` (inside a continuation too), a trailing shell comment in a shell-form `RUN`/`CMD`/`ENTRYPOINT`/`HEALTHCHECK CMD`, and comments in a `RUN` heredoc's script; a `COPY`/`ADD` heredoc is file content |
| `.json`, `.jsonc` (`tsconfig*.json` included) | TypeScript's scanner | `//` and `/* */` outside strings |

The baseline stores each file's comments as whitespace-normalised text, so a
comment may move but not change, be duplicated, or appear in a new file.
`src/core/`, `src/application/`, `src/contracts/`, `src/adapters/`,
`src/features/`, `src/bootstrap/`, `src/legacy/`, `tests/`, `.github/`, every
Dockerfile, `docker-compose.yml`, `eslint.config.mjs` and every JSON file can
never carry a baselined comment; all of them have none. The one YAML file
still on the baseline is `desktop/electron-builder.yml` (66 comment lines at
the time the gate learned YAML), which is desktop packaging and moves to docs
when that file is next changed.

Not comments: an interpreter directive (`#!`) on the first line of a script,
and the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}` in `src/page.html`,
which `build.mjs` replaces and which are allowed there exactly once each. A
Dockerfile parser directive (`# syntax=`, `# escape=`, `# check=` before
anything else in the file) is a comment unless `DIRECTIVES` in
`tools/comment-gate.mjs` lists that exact line for that file; none is listed
today. A file that does not parse (a broken YAML file) fails the gate.

Not scanned yet, because no parser covers them: `.gitignore`, `.dockerignore`,
`.npmrc`, `.env.example` and other dotfiles, and Markdown.

## Baseline at the start of 4.0

Measured on `4.0-development` after the forward merge of 30 September 2026:

| Measure | Value |
| --- | --- |
| Frontend modules (`src/`, excluding tests) | 77 |
| Largest frontend runtime import cycle | 63 modules (one cycle) |
| Production modules importing `S` | 57 |
| Modules assigning `S.state` | 9: `00-prelude`, `02b-doc-id`, `03-sync`, `13-hosted`, `18-local-files`, `18b-file-menu`, `20g-drafts`, `20j-newtab`, `21-events` |
| Modules writing any `S` field | 27 |
| Frontend unit-test files (`src/test/*.test.mjs`) | 63 |
| Browser suite files | 162 |
| Dependency exceptions | 14 |
| Baselined comments | 258 in 21 files, most in the PowerShell driver and `start.bat` |
| Inline `eslint-disable` directives | 16 (the two in `build.mjs` moved to `eslint.config.mjs`) |
