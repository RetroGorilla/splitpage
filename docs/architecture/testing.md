# Local verification

Every check is a script first; CI calls the same scripts. `npm run verify`
runs the fast gates in the order CI does.

| Command | What it runs |
| --- | --- |
| `npm run lint` | eslint over every source tree, `.ts` included; any warning fails |
| `npm run typecheck` | `tsc` rules for each `tsconfig.*.json`; fails on a `.ts` file no config covers |
| `npm run check:deps` | Layer, platform and cycle rules ([dependencies.md](dependencies.md)) |
| `npm run check:comments` | The no-comment gate ([dependencies.md](dependencies.md#comment-gate)) |
| `node build.mjs` | Builds `index.html` and stamps `sw.js` |
| `npm test` | Unit tests: `src/test/`, TypeScript tests beside source, `tests/` |
| `npm run test:desktop` | `desktop/test/*.test.mjs` |
| `npm run test:tools` | `tools/test-*.mjs` (server, updater, suite runner, gates, discovery) |
| `npm run test:all` | All three sets |
| `npm run verify` | lint, typecheck, check:deps, check:comments, build, test:all |

Browser suites and the desktop smoke run by hand at milestone and release
gates: `node tools/run-suites.mjs <out-dir> [regex]` on Linux/macOS,
`run-tests.ps1` on Windows, `node desktop/test/smoke.mjs` for Electron.

`node tools/perf-record.mjs [report.md]` drives the built app in headless
Chromium and records typing, new-scene, bulk delete/undo and export timings on
the seed and the long demo, with the machine, browser and font it ran under.
[performance-record.md](performance-record.md) is the 4.0 starting point;
compare a later run only under the same conditions.

## Test discovery

`tools/run-tests.mjs` finds tests by path, prints every file it found, runs
them, and prints how many ran in each group.

| Group | Files | Runner | Must be non-empty |
| --- | --- | --- | --- |
| `frontend` | `src/test/*.test.mjs` | `node --test` | always |
| `source` | `*.test.{ts,mts,cts,js,mjs,cjs}` under `src/`, outside `src/test/` | `node --test` | once any migrated folder holds TypeScript source |
| `tests` | `tests/**/*.test.*` | `node --test` | once `tests/` holds TypeScript |
| `desktop` | `desktop/test/*.test.mjs` | `node <file>`, one at a time | always |
| `tools` | `tools/test-*.mjs` | `node <file>`, one at a time | always |

A file named like a test that no group runs (`src/test/x.test.ts`,
`server/x.test.mjs`) fails the run, as does a file two groups claim.
`node tools/run-tests.mjs --list [unit|desktop|tools|all]` prints discovery
without running anything.

`--only <path-or-substring>` narrows a run to the discovered files whose path
contains it (repeatable; `\` and `/` alike): `npm test -- --only
src/test/formats`, `npm run test:all -- --only tools/test-comment-gate`.
Discovery and its orphan, overlap and empty-group checks still run over
everything, the selected files are listed, and the run says it is not the
full gate. A filter that matches nothing exits 2. It is for local feedback
only; CI always runs `npm run test:all` unfiltered.

`tools/test-run-tests.mjs` links the repository's `node_modules` into a
temporary repository to type-check it. On Windows the link is a directory
junction, which needs neither administrator rights nor Developer Mode; if the
link still cannot be made, the typecheck cases print `SKIP` with the reason
and the summary counts them as skipped, not passed.

## TypeScript

Node runs `.ts` files directly by stripping types; it does not read
`tsconfig.json` and does not type-check. `npm run typecheck` is the type gate.

| Config | Covers | Environment |
| --- | --- | --- |
| `tsconfig.core.json` | `src/core`, `src/application`, `src/contracts` | ES2023 only: no DOM, no Node |
| `tsconfig.web.json` | `src/adapters`, `src/features`, `src/bootstrap`, `src/legacy` | ES2023 and DOM |
| `tsconfig.test.json` | `src/**/*.test.ts`, `tests/` | ES2023, DOM and Node |

All three extend `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`,
`erasableSyntaxOnly`, `verbatimModuleSyntax`, NodeNext modules and no emit.
Import with the `.ts` extension and `import type` for types; path aliases are
not used because Node would not resolve them.

eslint applies `typescript-eslint`'s strict rules to `.ts` files and
refuses inline `eslint-disable` directives in the migrated folders and
`tests/`.

TypeScript is pinned at 6.0.3, not 7. TypeScript 7's npm package exposes its
compiler API only under `typescript/unstable/*`, which `tools/source-scan.mjs`,
`tools/dep-report.mjs` and `tools/typecheck.mjs` call, and typescript-eslint
8.71 supports TypeScript below 6.1. Move to 7 when both have changed.

Supported Node versions are 22 (from 22.22.2) and 24 (from 24.15.0), per
`package.json`'s `engines`; `.nvmrc` pins the one used locally and in CI.

## CI

`.github/workflows/ci.yml` runs on every pull request to `main` or
`4.0-development` and every push to either branch. Its jobs call the scripts
above and nothing else.

| Job | Runs |
| --- | --- |
| `changes` | `tools/ci-changes.mjs`: does the diff touch anything but prose? |
| `checks` | Node from `.nvmrc`: lint, typecheck, check:deps, check:comments, build, the `sw.js` stamp, test:all, tab strip width, browser suites 01 and 52 through `tools/run-suites.mjs`; uploads the built app |
| `node-24` | A clean `npm ci` and `npm run verify` on Node 24 |
| `gate` | Passes when `checks` and `node-24` passed, or when the change was prose only and both were skipped |
| `desktop-smoke` | Electron dev-target smoke, on pushes to `main` only |

`gate` is the one check to mark required in branch protection: a
prose-only pull request completes it without waiting on the others. Prose
means Markdown other than `docs/help.md` (the build renders it into the app),
`.claude/handoff/`, issue templates, `CODEOWNERS` and `LICENSE`.

`.github/workflows/docker.yml` builds and starts both Docker images when a
Docker build input changes; its path filters list every file the Dockerfile
copies. `.github/workflows/release.yml` builds the Windows installers from a
tag.

The full browser regression, the Windows runs and the packaged x64/ARM64
checks are local milestone and release gates (plan section 4). The
maintainer's machines are never registered as runners for pull-request
workflows.
