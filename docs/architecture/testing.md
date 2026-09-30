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

Supported Node versions are 22 (from 22.22.2) and 24 (from 24.15.0), per
`package.json`'s `engines`; `.nvmrc` pins the one used locally and in CI.
