# Local verification

Every check is a script first; CI calls the same scripts. `npm run verify`
runs the fast gates in the order CI does.

| Command | What it runs |
| --- | --- |
| `npm run lint` | eslint over every source tree, `.ts` included; any warning fails |
| `npm run typecheck` | `tsc` rules for each `tsconfig.*.json`; fails on a `.ts` file no config covers, and on a cast to the validated document brand ([below](#the-validated-document-brand)) |
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
| Closing a milestone, cutting a release | The recorded full gates of plan section 4: every suite through `run-tests.ps1` on Windows, and through `tools/run-suites.mjs` on Linux for the 4.0 release, the Electron smoke, the Windows x64 packaged check, and the native ARM64 packaged check for the 4.0 release; `summary.txt` and the logs attached to the closing pull request |

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

Every `run-tests.ps1` run ends by writing `digest.txt` beside the suite logs
and printing its path as the last line. Read the digest before any log: it has
the overall result, then for each failing suite the failing checks with 5 lines
of context and the exception text, the retries, and the de-duplicated warnings.
A suite that ran 0 checks counts as a failure. A section is cut at about 60
lines with a pointer to the full log, so a green run is a few lines and a red
run stays small. The logic is `tools/failure-digest.mjs`, tested by
`tools/test-failure-digest.mjs`.

## Golden fixtures

Characterisation tests named `src/test/<name>-golden.test.mjs` compare
today's behaviour with JSON fixtures committed under
`src/test/fixtures/golden/`. A test never writes its fixture: a mismatch is a
behaviour change to explain, not a file to refresh. When a change is meant to
alter pinned behaviour, regenerate on purpose and review the fixture diff in
the pull request:

```
node src/test/golden-helpers.mjs --update richtext
node src/test/golden-helpers.mjs --update richtext,migrate
node src/test/golden-helpers.mjs --update all
```

The command runs the named golden tests with `GOLDEN_UPDATE` set to those
names, and a golden test writes its fixture only when that variable names it
(or `all`). `tools/run-tests.mjs`, and with it `npm test` and
`npm run verify`, exits 2 while `GOLDEN_UPDATE` is set at all, so a variable
left in a shell cannot rewrite every fixture and pass; the helper starts
`node --test` itself and is not affected.

Goldens are regenerated only on `4.0-development`, in a commit of their own
that changes nothing else, and never inside a lane that moves code: such a
lane keeps every golden passing unchanged.

Fixtures are compared as JSON text, so key order counts. Values that differ
from run to run are masked in one of two ways.

- `richtext` and `migrate` (`createIdMasker`) do not fix the clock or the
  random source. An id minted by `makeId` appears as
  `{minted:<prefix>:<n>}`, numbered per prefix by first appearance (a reused
  id keeps its number), and a random docId as `{minted:docId}`. Only a value
  in the exact minting format is masked: the prefix, at most seven random
  base-36 digits, and an eight-digit base-36 time stamp that falls within the
  run. A separate test in each file collects every id the outputs add (those
  the input did not carry, as written or as `safeId` cleans them), requires
  each to have that format and to be masked, and requires every masked value
  to be one of them.
- `merge` and `production` (`maskTokens`) run with the clock fixed at
  `FIXED_ISO` and `Math.random` seeded, and replace tokens that are new in the
  output (conflict-card ids, minted b-roll shot ids, a minted docId) with
  `<label-n>`, numbered by where each first appears in the serialised output.
  The format check is loose: `^c[0-9a-z]+$`, `^bs[0-9a-z]+$` (production
  first finds shot ids with `bs[0-9a-z]{6,}`) and `^d[0-9a-f]{32}$`, with no
  upper length and no time stamp. Because the numbering
  follows position in the output rather than the order of minting, which id
  was minted first is not observable.

| Golden | Pins |
| --- | --- |
| `richtext` | `sanitizeHtml`, `fromHtml` and its media, `toHtml(fromHtml(x))`, `htmlToMarkdown`, `storedHtmlFromDom` and video-card HTML over a corpus; asserts INV-10 and that `toHtml` output is already in stored form |
| `migrate` | `migrateRows`/`migrateDocument` JSON, the registry's records, the shas queued for persistence (through `setBackend`), idempotence and docIds, including a file saved before the tag registry; the file runs in its own process, so the registry starts empty |
| `normalisers` | One table per normaliser that moves to core (`normalisers-<table>.json`), every case at a limit, one past it and one short of it: people names, the `migrateRows` field limits, `plainText`'s control characters, `plainName`, `safeId`, `safeHref`, `safeImageSrc`, the image size attributes, `DIRECTION_MAX` and `importDirections`, `normalizePersonColors`, `withPageHead`, scene and target lengths, gallery limits and b-roll props. Long repetitive strings are stored as runs, long lists and maps as a count with their first and last entries |
| `merge` | `mergeStates` over 58 cases, one fixture each (`merge-<case>.json`), each storing its three inputs and the result: every `STATE_FIELDS` key changed by each side, rows, text and conflict cards, comments, tags, b-roll, people, colours, gallery, docIds. Built inputs must match the stored ones as exact text. Also every branch of the list mergers (`merge-list-mergers`), a field with no strategy throwing, and ids that are `Object.prototype` names (`merge-prototype-ids-*`: merged like any other id since #278). The clock is fixed at `FIXED_ISO` and `Math.random` is seeded; conflict-card ids are masked after their shape is checked |
| `production` | `productionEntries`, `brollEntries` read and repair, `healTagRegistry` writes and cue retitling, over the long demo (as shipped, registry emptied, shots dropped) and crafted documents; reads are asserted not to change the document. Also the tag and b-roll limits and status cycles (`production-limits`) and the Gear panel's quick add (`production-gear-quick-add`) |
| `undo` | Which `STATE_FIELDS` keys an edit records as an undo entry (`undo-state-fields`), so a list derived from field policies must equal today's `SKIP_DOC_KEYS` |

A fixture's name starts with its golden (`merge-…`, `production-…`,
`normalisers-…`), and `--update merge` rewrites only those. The merge,
production and normalisers updates write only fixtures whose text changed; a
fixture left without a case fails the fixture-set test, so remove it by hand.

`sha256-utf8.test.mjs` has no fixture: `node:crypto` is its oracle for
`sha256Hex`, lone surrogates and megabyte strings included. Since 2.1a the
function is core's (`src/core/document/ids.ts`), which always encodes UTF-8 by
hand into a `Uint8Array` because `TextEncoder` is a platform global core may
not use; the test checks the encoder's bytes against `TextEncoder`'s, the hash
with `TextEncoder` present and removed, and that `02b-doc-id.js` hands out the
core function.

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

`types/json.d.ts`, in all three configs, makes `JSON.parse` return `unknown`
instead of `any`, so a parsed value is checked or asserted before it reaches a
typed parameter.

### The validated document brand

`ValidatedDocument` (`src/core/document/validated.ts`) is the document shape
plus a type-only brand keyed by an unexported `unique symbol`. Only
`src/core/migrate.ts` produces it: `migrateRows` and `migrateDocument`, and
through them `mergeStates`. `mergeStates`, `mergeStateFields`,
`syncCommentAnchors`, `deriveProductionIndex`, `planRegistryHealing`,
`planQuickAdd`, `brollEntries` and `planBrollAnchors` take only that type. The
brand changes no bytes; `checkJs` is off, so it constrains `.ts` callers only.

A type carries the brand when the brand's property or its `unique symbol` key
is reachable from it, directly or through an alias, a union, an intersection,
an array, a property, a type argument, a constraint, a return type or an index
signature. A top-level `never` counts too, because `never` is assignable to
every type; a `never` nested inside another type does not. The typecheck
refuses, in every `.ts` file but `migrate.ts`:
- a type assertion to such a type, unless the value already has that type
  (this covers `as never`);
- a type predicate to such a type, unless it only narrows a parameter whose
  type already carries the brand (`(d): d is ValidatedDocument => d !== null`
  over `ValidatedDocument | null` passes);
- a call to a function declared outside the default library whose
  instantiated return type or predicate carries the brand when its declared
  one does not, and no argument or receiver supplies it: a generic helper
  that would launder a cast. `jsonCopy(doc)` passes, and library calls and
  every `new` are not checked, so empty containers (`new Map<string,
  ValidatedDocument>()`), `new Promise<ValidatedDocument>(…)` and a generic
  `new Store<ValidatedDocument>()` pass;
- a function signature with no body that returns such a type;
- a variable or class property of such a type that is ambient (`declare` or a
  declaration file) or definitely assigned (`!:`). This is a decision: a
  field that holds a document is typed `ValidatedDocument | null`, or is set
  in the constructor, not declared `doc!: ValidatedDocument`;
- an interface or type member of such a type in an ambient context, such as
  `declare global { interface JSON { … } }`. Ordinary port interfaces pass.
  Every `.ts` file here is a module, so an interface outside `declare global`
  is local and cannot augment a global.

The rule is `tools/brand-casts.mjs`, tested by `tools/test-brand-casts.mjs`.
It sits in the typecheck, not in eslint or the dependency gate, because only
the type checker sees through aliases and indirect forms. Two eslint rules
back it on `.ts` files: `@typescript-eslint/no-unnecessary-type-parameters`
refuses a helper such as `launder<T>(v: unknown): T` where it is written, and
`@typescript-eslint/method-signature-style: property` makes interface members
function properties, so they are checked contravariantly and an
implementation cannot narrow a parameter to the brand. `types/*.d.ts` is
exempt from the second, since `JSON.parse` there must merge with the
library's method.

What the rule does not refuse, each shown as a known gap in
`tools/test-brand-casts.mjs`:
- a generic class whose member casts to its own type parameter
  (`new Box<ValidatedDocument>().value`), since `new` is not checked;
- a `never` nested in a target (`raw as Promise<never>`, then awaited);
- a laundering call given any branded argument or receiver, which exempts it
  (`pick<ValidatedDocument>(doc, raw)`);
- a class method override that narrows its parameter to the brand
  (`override take(d: ValidatedDocument)`), called through the base type:
  method parameters stay bivariant in classes.

A value typed `any` is assignable to the brand without any cast, and `any`
still reaches authored code: `Object.create(null)`, `Reflect.get` on an
untyped receiver, `Array.isArray` narrowing an `unknown`, and any call into
legacy `.js`, whose functions are untyped because `checkJs` is off.
`@typescript-eslint/no-explicit-any` and the `JSON.parse` declaration close
the explicit sources only. eslint runs the type-aware
`@typescript-eslint/no-unsafe-argument` and `no-unsafe-return` on `.ts`
files, so an `any` passed to a guarded function or returned as one is
refused. An `any` assigned to a variable annotated with the brand still
passes: `no-unsafe-assignment` would refuse 31 existing assignments, mostly
`Object.create(null)` maps, and is not on.
`tools/test-validated-document.mjs` compiles a call to each guarded function
with an object literal, a `JSON.parse` result and one asserted to the
unbranded shape, under each of the three tsconfigs, and expects a type error
for each.

Tests get a branded document from `migrateRows` with fake ports.
`migratedThenSet` in `tests/core/migrate-ports.ts` migrates a copy of a fixture
and then sets the fixture's own fields back, the way the app edits a live
document, so a test of an unregistered tag or a malformed registry keeps its
input.

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

The full browser regression, the Windows runs and the packaged x64 check
are local milestone and release gates; the Linux full run and the packaged
ARM64 check are local gates at the 4.0 release only (plan section 4). The
maintainer's machines are never registered as runners for pull-request
workflows.
