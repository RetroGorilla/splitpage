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
| `npm run test:tools` | `tools/test-*.mjs` (server, updater, suite runner, gates, discovery, CI change classes, the artifact's file list, each tool's entry check) |
| `npm run test:all` | All three sets |
| `npm run verify` | lint, typecheck, check:deps, check:comments, build, the `sw.js` stamp (`git diff --exit-code -- sw.js` after the build, as CI does), test:all |

The full browser regression and the desktop smoke run by hand at milestone
and release gates: `node tools/run-suites.mjs <out-dir> [regex]` on
Linux/macOS, `run-tests.ps1` on Windows, `node desktop/test/smoke.mjs` for
Electron. How to drive the browser suites is in
[the run-splitpage-app skill](../../.claude/skills/run-splitpage-app/SKILL.md).

## What to run for which change

While a pull request is being written, run the focused checks for what it
touches. CI then runs every fast gate on every pull request: lint, types, the
dependency and comment gates, the build, every discovered unit, desktop and
tool test, and the smoke, CSP and persistence browser suites. CI never
narrows to the test files a change touched; `--only` is a local tool.

| Change | Run while working |
| --- | --- |
| A pure rule in one feature or core policy | Its unit tests (`npm test -- --only <folder>`), `npm run typecheck`, `npm run lint`, `npm run check:deps`, `npm run check:comments` |
| A feature's controller, view or bindings | The feature's tests, and the browser suites for its real input, focus and selection |
| A public application contract (session, commands, actions, ports) | Its contract tests and the tests of every caller |
| Saving, recovery, permissions or session transitions | The race tests, and the persistence and permission suites for that path (for example `28-autosave.txt`, `19-save-conflict.txt`, `249-save-as-hosted.txt`, `265-browser-drafts.txt`, the collaboration suites `26[0-4]-collaborate-*.txt`) |
| Serialization, merge, undo or text operations | The fixtures and contract tests (`formats`, `merge-states`, `draft-edit` and their kin), and the editing and export suite families |
| Bootstrap, tooling, bundling or distribution | `npm run verify`, the broader integration suites, and the package or platform checks the change reaches (the Docker workflow, `node package.mjs`, `desktop/verify-dist.mjs`) |
| Closing a milestone, cutting a release | The recorded full gates of plan section 4: every suite through `tools/run-suites.mjs` on Linux and `run-tests.ps1` on Windows, the Electron smoke, the Windows x64 and ARM64 packaged checks; `summary.txt` and the logs attached to the closing pull request |

`npm run verify` before pushing is cheap and runs CI's fast gate apart from
the checks that need a browser: the tab strip width
(`node desktop/test/tabstrip-width.mjs`) and the browser suites. Its `sw.js`
check compares the stamped file with the one git has, so an edit to `sw.js`
you have not staged or committed fails it; `git add sw.js` settles that.

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
| `source` | `*.test.{ts,mts,cts,js,mjs,cjs}` under `src/`, outside `src/test/` | `node --test` | once a migrated area (below) holds TypeScript source and its `tests/` folder has no test |
| `tests` | `tests/**/*.test.*` | `node --test` | once `tests/` holds TypeScript |
| `desktop` | `desktop/test/*.test.mjs` | `node <file>`, one at a time | always |
| `tools` | `tools/test-*.mjs` | `node <file>`, one at a time | always |

A file named like a test that no group runs (`src/test/x.test.ts`,
`server/x.test.mjs`) fails the run, as does a file two groups claim.

Every migrated area that holds TypeScript source (declaration files aside)
needs at least one test, beside its source (anywhere inside the area) or in
its `tests/` folder; a unit run names each area that has none and fails. A
test in one area's folder does not cover another.

| Area | Its `tests/` folder |
| --- | --- |
| each `src/core/<folder>` | `tests/core/<folder>` |
| files directly in `src/core` | directly in `tests/core`, or directly in `src/core` |
| `src/application` | `tests/application` |
| `src/contracts` | `tests/contracts` |
| `src/adapters` | `tests/adapters` |
| each `src/features/<folder>` | `tests/features/<folder>` |
| files directly in `src/features` | directly in `tests/features`, or directly in `src/features` |
| `src/bootstrap` | `tests/bootstrap` |
| `src/legacy` | `tests/legacy` |

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
junction, which needs neither administrator rights nor Developer Mode. If the
link still cannot be made on a Windows workstation, the typecheck cases print
`SKIP` with the reason and the summary counts them as skipped, not passed.
Anywhere else, and on Windows when `CI` is set, a link that cannot be made
fails the run.

A tool runs its command only when it is the script Node was started with,
which `isMain` in `tools/main-module.mjs` decides by comparing the real paths
of both, so a checkout reached through a junction or symlink still runs the
gates instead of exiting 0 having done nothing. `update.mjs` makes the same
comparison itself, because it ships in the release zip without `tools/`.
`tools/test-main-module.mjs` starts every tool and the updater through such a
link, with the same skip rule.

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
| `checks` | Node from `.nvmrc`: lint, typecheck, check:deps, check:comments, build, the `sw.js` stamp, test:all, tab strip width, then through `tools/run-suites.mjs` the smoke and CSP suites (`01-core.txt`, `52-csp.txt`) and the persistence suite (`265-browser-drafts.txt`); uploads the built app |
| `node-24` | A clean `npm ci` and `npm run verify` on Node 24 |
| `gate` | Passes when `checks` and `node-24` passed, or when the change was prose only and both were skipped |
| `desktop-smoke` | Electron dev-target smoke, on pushes to `main` only |

The persistence suite costs little: on its first hosted run (PR #270,
`ubuntu-latest`, 30 September 2026) `265-browser-drafts.txt` passed 80 of 80
checks in 8.0 s, from the runner's start line to its `ALL PASS`; the step
running `01-core.txt` and `52-csp.txt` on two lanes took 7 s.

`gate` is the one check to mark required in branch protection: a
prose-only pull request completes it without waiting on the others. Prose
means Markdown other than `docs/help.md` (the build renders it into the app),
`.claude/handoff/`, `CODEOWNERS` and `LICENSE`. The issue templates' YAML is
not prose: the comment gate reads it, so a change to it runs the checks.
`tools/test-ci-changes.mjs` fails if any file the comment gate reads would be
classed as prose.

`.github/workflows/docker.yml` runs when a Docker build input changes; its
path filters list every file either Dockerfile copies. Job `image` builds the
root `Dockerfile` from the checkout and starts it the way `deploy.sh` does.
Job `prebuilt` runs `npm ci` and `node build.mjs`, copies the files of the
`splitpage-app` artifact into an empty folder (`tools/artifact-files.mjs`,
which reads the list from `ci.yml`), builds `Dockerfile.prebuilt`
there, starts it and checks `/api/health`'s version, `/` and `/sw.js` against
`VERSION` and its HEALTHCHECK. `.github/workflows/release.yml` builds the
Windows installers from a tag. [ci.md](ci.md) explains the settings in these
files that the files themselves cannot.

The full browser regression, the Windows runs and the packaged x64/ARM64
checks are local milestone and release gates (plan section 4). The
maintainer's machines are never registered as runners for pull-request
workflows.
