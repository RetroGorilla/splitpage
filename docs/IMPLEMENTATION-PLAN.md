# Splitpage 4.0 — implementation plan

**Objective:** Make ordinary changes local, understandable and independently testable. Give each document operation, feature and platform resource an explicit owner. Preserve the app's current behavior and distribution model.

**Scope decision:** Plugins, a plugin SDK, a plugin host and an isolated extension runtime are out of scope. Internal action and format registries remain because they simplify application development.

**Authority:** This is the plan for 4.0. It supersedes the September 2026 architecture plan and the interim roadmap; their compatible product invariants are preserved, and this document controls sequencing, scope and acceptance. It lives on `4.1-development` and is amended there by PR when a decision changes.

**Source baseline:** Version 3.1.0, `main` at `80500f6ef6b8f32b68a22c95210dcb962a989fc3`. Recheck the implementation branch before editing. This is a plan, not a claim that the refactor is implemented.

## 0. Decisions

| Decision | Outcome |
| --- | --- |
| Release | 4.0, from `4.0-development` (created from `main`); `main` merged in at least weekly |
| Plugins, SDK, extension runtime | Out of scope |
| Language for new folders | TypeScript, strict, erasable syntax only (section 3) |
| Comments | None in authored code, tests, CSS, HTML, scripts or workflow/configuration files; rationale lives in `docs/` (section 2) |
| CI | Fast gates on hosted runners for PRs and the development branch; the full browser regression and the Electron smoke run locally at every milestone gate; the Windows x64 packaged check and the external review run at the gates of milestones 3 and 4, at milestone 6's gate for the external review, at the gate of any milestone that switches the build entry or changes packaging inputs for the packaged check, and at the 4.0 release gate; the Linux full run and the native ARM64 packaged checks run at the 4.0 release gate only (section 4; Adam, 2026-10-07) |
| Lane models | Sonnet by default; Opus for the areas listed in section 2; every review is Opus (Adam, 2026-10-07) |
| Milestones 4–7 | Re-scoped and approved by Adam, 2026-10-07: milestone 5 in full with the registry, milestone 6 with the bounded CSS split, milestone 7 narrowed to explicit wiring and the named legacy initializer shim (sections 1, 5, 7 and 8); the approved page is [milestones-4-7-rescope.md](architecture/milestones-4-7-rescope.md) |
| ARM64 | A Windows ARM64 device is available; native ARM64 runtime checks run on it at the 4.0 release gate and the release row stands as written |
| Invariants | Ledger in `docs/architecture/invariants.md`; `HANDOFF.md` section 5 stays in step with it (milestone 0) |

## 1. Outcome and release boundaries

A successful refactor makes a feature's rules, commands, view and tests discoverable without understanding historical initialization order or manually recalling dirty/render/save side effects.

| Change | Expected implementation footprint |
| --- | --- |
| Add an application action | One focused handler and one registration; menus, buttons and shortcuts consume the same action definition |
| Add an exporter | One codec/provider and one registration; export UI consumes its declared options/content support |
| Change a document rule | Its core policy/operation and focused tests; application transactions apply it consistently |
| Change a feature view | Its feature folder and view tests; no concrete storage/network/native imports |
| Change a storage implementation | Its adapter and contract tests; application rules stay unchanged |

Focused tests shorten feedback time. Shared contract and critical integration tests remain mandatory; the goal is not to eliminate regression testing.

**4.0 scope:** Milestones 0–7 below: verification tools, core extraction, session/commands, saving/recovery, formats, feature ownership, and (milestone 7) the explicit wiring of migrated owners with the named legacy initializer shim. The composition root as build entry, unused `S` fields and any remaining bridges are 4.x work (section 8; Adam, 2026-10-07). Unmodified server and desktop internals may remain legacy behind narrow adapters.

**4.x follow-up:** The frontend bootstrap items and server and desktop service extraction in section 8. Their existing functional, security and packaging checks remain release requirements even when their internal refactors are deferred. Describe remaining legacy debt honestly; do not declare the entire repository fully refactored at 4.0.

No UI framework replacement, editor-engine replacement, persisted document schema migration, collaboration algorithm replacement or new user feature is included. Keep 3.1 file/HTTP/IPC compatibility. Distinguish intentional distribution-version changes from file-format changes.

## 2. Working agreement

### Branches and small changes

1. Read applicable repository instructions, `docs/help.md`, `HANDOFF.md` section 5, build/packaging scripts and tests for the area being changed. Resolve stale prose against executable source and fixtures.
2. Use the existing `4.0-development` branch, or create it from current `main` if absent. Preserve unrelated working changes; use a clean worktree where necessary.
3. Keep PRs focused on one ownership boundary. Separate a demonstrated behavioral repair from a broad extraction. Keep the application runnable after each PR.
4. No 3.1.x release is planned before 4.0, so `3.1.x-development` takes no more bug fixes, and nothing is forward-merged from it. A bug that also exists on 3.1.x is fixed on `4.1-development` instead, as [review.md](architecture/review.md#2-where-bugs-get-fixed) describes. A bug in code that a pending step is moving is fixed after that move lands, in the module that now owns it, with its regression test; do not restore deleted implementations or maintain two competing paths. The closed 3.1.x fix branches (`fix/274-overlay-commands`, `fix/276-save-during-load`, `fix/278-290-ids-and-nested-links`, `fix/280-282-anchor-tags-and-cue-retitle`, `fix/281-283-md-null-href-and-person-merge`, `test/293-history-toast-race`) are the reference for those ports and their fail-first tests. Every defect that milestone 2 pinned or deferred has a disposition in [pinned-defects.md](architecture/pinned-defects.md), and each one that will be fixed has an issue.
5. Open enhancement issues wait for 4.x. A feature that touches editor, saving, formats or feature views is built once on the new structure. The integration owner decides per issue and says so on the issue.
6. Continue through milestones after their gates pass, with item 8 as the one planned pause. Do not pause for routine naming, file placement or reversible implementation decisions. Record substantive behavior/compatibility uncertainties before dependent changes.
7. Do not deploy to the live service, overwrite user data, publish releases or merge into `main` as an incidental verification step.
8. Before milestone 4 starts, the integration owner writes a one-page re-scope of milestones 4–7 for Adam's approval (Adam, 2026-10-07). For each milestone it answers one question: does the milestone make the next ordinary change easier to make and verify in isolation? Milestones 4 and 6 stay. Formats (milestone 5) and bootstrap/teardown (milestone 7) are candidates to stay legacy behind a narrow adapter, as section 1 already allows for server and desktop internals. The re-scope names what section 7's release checklist loses for each part that stays legacy, keeps the resource-release contract of section 6 (milestone 4's transition API depends on it), and keeps the captured export projection that milestone 4's save paths need. No milestone 4 work starts before the milestone 3 gate. Done: Adam approved the re-scope on 2026-10-07 ([milestones-4-7-rescope.md](architecture/milestones-4-7-rescope.md)); milestone 5 stays in full and milestone 7 is narrowed, as section 5 states.

### Lane models and characterisation

Adam decided these on 2026-10-07.

- **Models.** A lane runs on Sonnet by default. A PR runs on Opus when it touches state ingress or serialization, durable storage (drafts, history, recovery), the preload/IPC boundary, close/quit code, the merge algorithms, or the editing hot path and the undo adapter. Characterisation suites, fuzz harnesses, tooling and docs PRs are Sonnet. Every review is Opus, one independent review per PR as [review.md](architecture/review.md#4-review) says. Each milestone doc marks its PRs by this rule.
- **Characterisation.** A characterisation-only PR (tests and suites, no source change, like milestone 3's 3.0 and 3.11) is for a hot path or a multi-file move. A small move carries its own characterisation tests: they go in the PR's first commit, and the PR body states the base commit they passed on, so the reviewer can see they pin the code before the move.
- **As-built docs.** The as-built description of a new owner (for milestone 3, the session, the effect scheduler and the command shape) is written as its own docs PR as soon as the owner's first commands have landed, not at the milestone's close. The closing docs PR then revises it, and adds the metrics, ledger rows and pinned-defect rows.

### Ownership of shared work

Independent features can be developed separately once their application interfaces are defined. One integration owner controls shared schemas, session/command interfaces, action/format registration, bootstrap, package manifests/lockfiles, CI and baseline changes. Feature work contributes registrations through that owner rather than racing to edit central files.

Do not split a foundational interface across multiple simultaneous implementations. Finish the first working vertical slice before multiplying feature migrations. Each PR names its owned files and dependencies. Parallelism is optional; correctness of the merged result is the gate.

### No comments in authored code

Add no inline, block, documentation, TODO/FIXME or lint/type suppression comments to authored code, tests, CSS, HTML, scripts or workflow/configuration files. Write contracts and rationale in `docs/architecture/`, `docs/decisions/`, types, names and tests.

A parser-aware check must distinguish actual comments from URLs, regexes and strings. Preserve interpreter directives and exact required build-template markers through file-specific configuration. Move the two `build.mjs` lint suppressions, and the other inline `eslint-disable` directives across the repository (sixteen at the baseline), into narrowly scoped configuration as their files are touched; milestone 0 handles `build.mjs`. Do not introduce broad exclusions for whole workflow files or new folders. Existing unmigrated comments have an exact, frozen baseline; no new comments are allowed, and migrated areas have none. Preserve attribution in LICENSE/NOTICE and third-party metadata; generated/vendor content is outside the authored-source check.

### Engineering constraints

- Preserve the vanilla DOM UI, normalized run model, sanitized persisted HTML, identity/fork rules, three-way merge policies and existing undo implementation initially.
- One application owner controls live document mutation. Views receive selectors/read models and named operations, never a writable document reference.
- Inject external time, identity generation, storage, transport and scheduling where behavior depends on them. Avoid a global service locator or general-purpose event bus.
- Reads, render, statistics, preview and export do not repair or mutate documents. Reconciliation belongs to ingestion or an explicit transaction.
- Expected operational failures produce typed outcomes. Unexpected failures reach a reporting boundary. Preserve deliberate optional fallbacks; do not silence failures indiscriminately.
- Add no runtime dependency without a concrete purpose and distribution impact. New folders appear when real work needs them; do not prebuild a generic framework.

## 3. Architecture and migration boundaries

| Location | Owner/responsibility | Permitted dependencies |
| --- | --- | --- |
| `src/core/document/` | Document/field policies, normalized data, scene rules and IDs | Environment-independent core policies |
| `src/core/text/` | Runs, marks, offset selections, projections, steps and inversion | Core definitions |
| `src/core/merge/` | Existing merge algorithms and conflict results | Core document/text policies |
| `src/core/production/` | Tag/b-roll derivation and reconciliation plans | Core document/text policies |
| `src/application/` | Sessions, transactions, actions, save/recovery coordination and effect scheduling | Core and declared port interfaces |
| `src/contracts/` | Validated external DTOs and boundary outcomes | Focused validation and plain types |
| `src/adapters/` | HTML decoding, formats, storage, files, HTTP, clipboard and native integration | Port interfaces, contracts and platform APIs |
| `src/features/<feature>/` | Controller, view, bindings, local state, styles and tests | Public application interfaces and presentation utilities |
| `src/bootstrap/` | Explicit construction, registration and resource teardown | Implementations needed to compose the app |
| `src/legacy/` | Temporary, named adapters over unmigrated code | Only explicitly allowed legacy/application interfaces |
| `shared/` | Policies genuinely shared with server/desktop | Environment-independent definitions |
| `tests/` | Application, adapter, browser, architecture and compatibility tests | Testable public interfaces and fixtures |

Views use application interfaces; application uses core and declared ports; adapters implement ports; bootstrap constructs them. Core cannot import browser/DOM/storage/network/native APIs, application modules, legacy modules or UI. Application cannot import concrete adapters/features. Feature-to-feature orchestration goes through application interfaces or explicit bootstrap composition.

Legacy adapters may supply implementations of application ports. They cannot create a reverse dependency from core/application into numbered legacy modules. A remaining legacy composition shim can consume a new service during transition, with its exact exception documented. Cycles involving migrated code are prohibited even if their path passes through legacy modules.

Track existing violations by source, target and rule, not only counts. New prohibited edges fail; resolved exceptions are removed. Track runtime import cycles separately from type-only references, but apply layer rules to both. Resolve static imports, re-exports, known CommonJS requires and literal dynamic imports. Document unresolved dynamic loading instead of silently excluding it.

Report global-state access across all production source paths, including migrated folders. Direct `S.state` writers are a limited metric, not proof that nested/aliased writes are absent. Migrated features cannot import `S`, expose a writable live state, or call legacy mutation helpers through an untracked facade.

### TypeScript and test execution

New extracted source uses strict TypeScript with erasable-only syntax. Leave untouched JavaScript alone. Pin compatible TypeScript/parser tooling in the lockfile; extend lint and comment/dependency parsers to `.ts` files.

Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. For directly executed Node tests, use a consistent Node-compatible module/import-extension configuration. Use explicit type imports and `.ts` source extensions where native execution requires them; do not depend on `tsconfig` path aliases working at runtime. Separate core/application environment declarations from DOM/native adapter declarations.

Keep `tsc --noEmit` as its own gate. Native Node type stripping executes supported syntax but does not type-check or interpret `tsconfig.json`. Validate on the repository's supported Node 22 and 24 versions, honoring `.nvmrc` and package engine constraints; do not silently lower supported versions.

Update test discovery explicitly. The existing `npm test` only selects `src/test/*.test.mjs`; it must also execute new core/application/feature/adapter tests. Print discovered/executed files and fail unexpectedly empty groups. Keep existing scripts or compatibility wrappers working. Ship bundled/emitted JavaScript; do not assume packaged Electron/server runtimes can execute source TypeScript directly.

## 4. Verification baseline and CI policy

The reviewed snapshot has 77 frontend modules, a 63-module runtime import cycle, 57 `_state` importers and nine modules directly assigning `S.state`. It contains 63 frontend unit-test files and 161 browser-suite text files. Recompute these on the implementation branch; the numbers diagnose debt and are not success criteria by themselves.

Previous source checks passed build/lint, all 63 frontend test files, available desktop module/payload checks, 618 server checks and 23 updater tests. The Windows speech grace check was skipped. Full browser suites, real Electron smoke, Docker images and installed Windows targets were not executed in that review. Start implementation with a clean baseline; do not present prior results as validation of new changes.

### CI policy

Every check is a local script first (`package.json` scripts and `tools/`); CI jobs call those scripts and nothing else, so a run on a workstation and a run on a hosted runner are the same check.

**Hosted, on every PR targeting `main` or `4.1-development` and every push to `4.1-development`:** the fast gates. Lint, types, the comment/layer/dependency gates, every discovered unit/application/adapter/tool test, the build, and the selected browser smoke/CSP/persistence suites already in `ci.yml`. Linux runners only. A documentation-only PR completes the required check through a cheap gate rather than staying pending behind path filters. Workflow path filters include new folders and every actual build input.

**Local, at milestone and release gates:** the full browser regression on Windows (`run-tests.ps1`) at every gate, and on Linux (`tools/run-suites.mjs`) at the 4.0 release gate only (Adam, 2026-10-01: Linux support waits for the 4.0 release; hosted CI still runs on Linux), real Electron smoke (the dev target) at every gate, the Windows x64 packaged check on the maintainer's x64 device, and the native Windows ARM64 packaged check on the ARM64 device at the 4.0 release gate only (Adam, 2026-10-01: Windows on ARM can run the x64 build under emulation until then). Milestones 3 and 4 keep the full gate: the runs above, the x64 packaged check and the external review of [review.md section 8](architecture/review.md#8-milestone-gates). From milestone 5 on, a milestone gate is the full Windows run and the Electron dev smoke; the x64 packaged check and the external review move to the 4.0 release gate, with two exceptions: milestone 6 keeps the external review, and a milestone that switches the build entry or changes packaging inputs keeps the x64 packaged check (Adam, 2026-10-07). Run impacted tests and suites locally during feature PRs, chosen by the change table in `docs/architecture/testing.md`; the hosted fast gates still run every discovered test and never narrow to the test files a change touched. A milestone is declared complete, and a release cut, only with the recorded output of those runs (`summary.txt`, the smoke log, the platform check logs) attached to the closing PR. A scheduled hosted full run is optional and does not replace the local gate.

The workstation is never registered as a self-hosted runner for automatically triggered PR workflows. Local gate runs are started by hand.

### Minimum test evidence

| Area | Evidence required |
| --- | --- |
| Core | DOM-free rules, field completeness, migrations, merge conflicts, text/anchor operations and legacy-media preservation |
| Application | Real controllers with controlled external ports, no-op/permission behavior, undo grouping, ordered effects and asynchronous completion guards |
| Adapters | Real IndexedDB/filesystem/HTTP behavior and applicable shared contract tests; fakes model ports, not duplicated application rules |
| Browser | Actual typing/IME, selection, shortcuts, clipboard, drag/drop, dialogs, review modes, focus, responsive views and save/recovery flows |
| Native/security | Real Electron main/preload execution, sender/origin validation, tabs, resource shutdown and supported speech/native behavior |
| Compatibility | 3.1 fixtures and client/server combinations; deterministic project/export fixtures; existing IPC shapes/capabilities |
| Distribution | Standalone app, worker/CSP/offline behavior, portable package, both Docker recipes and Windows x64/ARM64 payload/runtime checks |

Do not weaken assertions, rewrite golden bytes, suppress genuine failures or expand exceptions to get a green check. Replace brittle source-text checks only after equivalent executable behavior/security checks exist. Use controlled completions/fake clocks for application races and real input for browser composition/selection.

## 5. Milestones for 4.0

Each milestone usually contains several PRs. Finish its gate before expanding migration scope. Add tests immediately before moving any newly touched untested behavior, even if it was not identified in the initial audit.

### 0 — Make verification trustworthy

**Work:**

1. Promote `.claude/handoff/direction-b/run-all-suites.mjs` to `tools/run-suites.mjs`, retaining a compatibility wrapper and full-filename suite discovery. Numeric suite prefixes are not unique.
2. Repair its result contract. The existing wrapper can print a failed suite and still exit 0; zero matching suites currently reports `ALL PASS`. Fail on suite failure, timeout, spawn error, missing/invalid result, unexpected empty discovery or invalid lane/port configuration. Use the current Node executable, capture bounded logs and clean up owned processes. Never kill unrelated browser/app processes.
3. Test the real orchestrator with controlled child commands: pass, fail, missing result, zero tests, timeout and launch error. Assert parent exit status and reports, not just printed text.
4. Add `tools/dep-report.mjs`, `tools/dep-baseline.json`, layer checks and the parser-aware no-comment gate. Keep informational metrics separate from the exception baseline. Tests must prove a new forbidden edge fails even when total counts do not increase.
5. Add TypeScript-aware lint/type/test discovery and documented local verification scripts. Add a failing-then-passing discovery probe so an omitted `.ts` test cannot go unnoticed.
6. Configure the CI policy of section 4 and retain existing smoke/Docker/release jobs. Commit locked tooling dependencies; run a clean install on Node 22 and 24.
7. Audit the current 62 `HANDOFF.md` invariants into `docs/architecture/invariants.md`: ID, behavior, test coverage, owner, target milestone, keep/absorb/practice classification, replacement mechanism and acceptance test. Keep behavior tests for absorbed rules; documentation getting shorter is not a quality metric. When a later milestone absorbs a rule into code, its `HANDOFF.md` entry is replaced by a one-line pointer to the ledger in the same PR, so the two never disagree.
8. Record representative typing, row edit, bulk operation and export performance on short/long fixtures, with machine/browser/font conditions, as one script run once. Preserve bounded/coalesced per-keystroke work; investigate material regression rather than optimizing from file size. This item does not gate the other milestone 0 work.

**Gate:** Deliberately failing/empty tooling runs fail locally and in CI; all old/new test locations are discovered; prohibited imports/comments are rejected; baseline constraints and platform skips are recorded. Capture a full Linux/Windows browser baseline or explicit platform blockers before moving behavior.

**Safe separate work:** Test orchestration and invariant documentation after shared script/config ownership is assigned. Foundational dependency/type/CI policy has one integration owner.

### 1 — Pin behavior and extract simple action wiring

**Source:** `21-events.js`, menus/command menu/shortcuts, `05r-read-time.js` and existing tests.

**Work:** Define a small typed action registry with stable IDs, labels, availability and handlers. Inject application-facing handlers; do not make the registry import every feature. Menus, buttons, command palette and shortcuts share the action definition. Feature modules register/unregister their own simple controls.

Add characterization coverage for scene length, selected editor operations, destination-specific save status, captured exports and the invariants the next slices touch. Preserve publish regressions and browser suites `249-save-as-hosted.txt`, `261-import-save-back-late-edit.txt`, `262-empty-scene-delete.txt`, collaboration suites 260–264, `265-browser-drafts.txt` and `266-header-collab-condense.txt`, using their full filenames.

Extract simple menu/button binding first. Keep complex before-input/composition/selection/clipboard/drag/root delegation in the legacy owner until a suitable application interface exists. Do not require `21-events.js` deletion in this milestone. Preserve event precedence and avoid duplicate listeners across legacy/new bindings.

**Gate:** The same action invokes the same permitted behavior from every surface; unsupported actions are unavailable; a representative feature mounts/disposes without duplicate handlers. Tests use the real registry and handlers. No new global-state or cross-feature import violations.

### 2 — Extract pure policies and document/text/merge operations

**Source:** `02-state.js`, `03-sync.js`, `04-richtext.js`, `04c-doc-model.js`, tag/b-roll policies and existing shared policies.

**Work:** Move field policies, markers, statuses and ID rules downward. Extract `STATE_FIELDS` without callbacks into UI modules, `migrateRows`, existing merge algorithms and normalized run operations. Keep field completeness in one policy source. Extract pure production/timing/comment read models and reconciliation plans.

Move inert HTML decode/encode and sanitization to `src/adapters/richtext/`. Separate validation/reconciliation from blob ingestion; ingestion is an explicit effect. Preserve legacy embedded pictures/video cards and existing content/identity rules. Keep sanitized HTML as persisted content; do not change schemas or recreate the editor engine.

**Gate:** Core runs in Node without DOM/platform globals and has no runtime cycles or upward imports. HTML adapter tests use a real parser. Existing migrations, project Markdown/.splitpage round trips, merge fixtures, Unicode, atomic tags, comments/anchors and legacy-media preservation pass. A new field policy does not require duplicating merge/schema field lists.

### 3 — Deliver one session/command vertical slice

**First slice:** Scene length, followed by scene status. Migrate text and bulk commands only after this proves the boundary.

**Work:** Introduce `DocumentSession` owning document, session epoch, edit generation, merge/destination context and undo integration. Opening/replacing creates a new epoch even for the same document ID. Keep credentials/platform handles and view-local state outside serialized content.

A command checks current capability, applies one atomic transaction, reconciles dependent anchors/records, advances generation once for an actual change, records according to existing undo grouping, and publishes a precise change set. No-op/rejected commands do not dirty, schedule saving or add undo entries. Distinguish user edits, server updates and recovery adoption so effects do not loop.

Views consume selectors/change sets. An application effect scheduler coalesces autosave, draft capture, history and expensive derivations; views do not manually fan out save/refresh calls. Preserve input ordering and current debounce/product behavior until measured tests justify a change.

Retain current diff/inversion machinery behind an undo adapter. Explicitly preserve typing groups, IME/composition, selection restoration and separate comment/reply draft undo; not every keystroke should become an independent user-visible undo step.

**Gate:** Scene-length/status behavior matches the baseline; accepted operations have one generation transition and correct undo/effects; views never mutate live state. Failure, no-op, review/read-only restrictions and undo/redo are exercised through real interfaces. No migrated view imports `S` or concrete adapters.

The milestone 2 external review ([gate record](architecture/milestone-2-gate.md#external-review)) asked for acceptance criteria for the next two items. Both belong here, because `DocumentSession` is the first owner of the live document and the first to hand out read models.

**Validated documents.** Today `migrateRows` and `migrateDocument` return `MigratedDocument`, which is `Record<string, unknown>`. Core's other document entry points take structural shapes (`MergeDoc`, `StepState`, `AnchorState`, `TagState`, `BrollState`), so a raw JSON object type-checks wherever a migrated document is assumed. #304 is that gap at run time: `mergeStates` throws on an unmigrated `theirs`.

- Core exports one validated document type, branded with a type-only `unique symbol`. Only `src/core/migrate.ts` produces it: `migrateDocument`, and `migrateRows`, which `mergeStates` ends with. The brand changes no bytes and costs nothing at run time.
- `DocumentSession` holds only that type. Every way a document enters the session, including milestone 4's transition API and an adopted merge result, either migrates raw input or receives the type. The session migrates `theirs` before it merges.
- These accept only the type: `mergeStates`, `mergeStateFields`, `syncCommentAnchors`, `deriveProductionIndex`, `planRegistryHealing`, `planQuickAdd`, `brollEntries`, `planBrollAnchors`, the session's undo adapter over `applySteps`, and the session's selectors. Functions over one cell or one value keep their narrow types.
- **Tests:**
  - A tools test compiles fixtures with the TypeScript compiler API. It expects a type error when an object literal or a `JSON.parse` result is passed to each listed function. (A `@ts-expect-error` line would be a comment, which the comment gate refuses.)
  - Lint or the dependency gate refuses a type assertion to the brand outside `src/core/migrate.ts`, with a fail-first case.
  - A seeded fuzz over raw inputs, #304's table among them, goes through the session's entry points. Each one ends in a valid document or a typed failure, never an exception from a merge or a production plan.
  - The migrate golden and the fixed-point test of a migrated document pass unchanged.

**Cached results.** Today caches hand out their own objects:

- `contentMemo` and the production readers return the cached value itself.
- The rich-text adapter's cell reader returns its cached `Run[]`. Core's `CellDecoder` type says `readonly`; the adapter's `CellReader` type does not.
- `currentProductionIndex()` returns the cached index, which `productionIndexFresh` also updates in place.
- `productionEntries()` copies the list, but not its entries.

A caller that writes into one of these values changes every later read of the same input. #303 is the same gap in a merge: merged comments share reply objects with `mine` and `theirs`, and `migrateRows` then writes into them.

- A cache owns what it stores and hands it out shared and frozen. A caller that needs to change a value copies it first. Return types are `readonly` all the way down, so a write from TypeScript is a type error. Any exception, for example a hot path where freezing costs measurable time, is named in `docs/architecture/` with its reason and a test that no caller writes into it.
- Only the index's owner updates the index. After a heal, its two views agree (#326).
- A merge writes into none of its inputs, and its result shares no mutable object with them. `migrateRows` keeps writing in place, but only into the document it was given to migrate.
- **Tests:**
  - A write into a value returned by each cache throws a `TypeError`. Every module runs in strict mode.
  - The full browser regression passes with freezing on, which shows that no legacy caller writes into a cached value. Milestone 3 builds the switch, a test-mode setting with a fixed name: the environment variable `SPLITPAGE_FREEZE_CACHES=1`, read by the test harness and passed to the page as a test-only flag (the same effect as a query flag). With it on, every cache deep-freezes what it hands out. With it off, which is every production build, nothing changes. The switch does not exist yet; the milestone adds it, and the regression's run with it on is part of the milestone's gate.
  - A test deep-freezes `base`, `mine` and `theirs`, then runs every merge golden case and a seeded differential corpus through `mergeStates` without a throw. It also walks `merged` and finds no object that is reachable from an input.
  - #303 is fixed before this, in the post-milestone-2 queue, and its three pinned tests change on purpose.

**Undo key order (#323).** `applySteps` compares rows as JSON text, so an inverse step that restores a removed row field puts it last, and the inverse `deleteRow` of that row is refused. Milestone 3's undo adapter makes `applySteps` a path that undo depends on, so it is fixed here.

- `applySteps` and its inverse compare rows independently of key order: two rows with the same fields and values match, whatever order the keys are in.
- After a restore that puts a removed field back last, the inverse `deleteRow` is accepted.
- **Tests:** a fail-first test of that case. The pinning test in `tests/core/text/steps.test.ts` ("today the inverse of an insertRow is refused once a field removed from that row has been put back, last") flips on purpose, and its name changes with it.

The blob registry's part is under milestone 4.

### 4 — Centralize save completion, session transitions and recovery

**Source:** `_home.js`, `02b-doc-id.js`, `13-hosted.js`, `13b-collaborate.js`, `14-export.js`, `18-local-files.js`, `20g-drafts.js`, `03d-drafts-idb.js` and Drive/native save paths.

**Work:** Use per-destination confirmed generations and baselines. Capture document snapshot and operation context before serialization, blob transfer or any other await: session epoch/document ID, destination identity/generation, edit generation, connection instance, authority/scope generation and server revision.

Serialize/coalesce writes per destination. The transport instance owns all requests for an operation, including blob transfer and the subsequent write. Completion acknowledges only the accepted snapshot. It may update live state only if ownership still matches; an already-landed obsolete write is reported without adopting it into another session.

Route open/new/restore/publish adoption through one transition API. Preserve identity/fork rules. Hosted Save As remains a separate copy and cannot acknowledge server edits or change its merge ancestor. Import writeback acknowledges only its own destination/bytes. Failure/cancellation never silently retargets Save.

Move collaboration workflows behind application interfaces; retain modal stale-completion checks. Model owner versus scoped document editor/reviewer authority explicitly and preserve server enforcement.

Split recovery capture scheduling, store adapters, writer ownership and restore/adoption policy. Keep the existing injected IndexedDB draft store. Preserve browser hosted-edit scope, limits, credential-free keys/records, review exclusion and desktop recovery behavior. Define live-tab takeover with/without Web Locks. Permission loss preserves recoverable edits as an unsaved local copy and never authorizes a server write. Discard only the acknowledged draft generation owned by that writer.

**Capture contract (Adam, 2026-10-07).** Save ownership cannot be established while a serializer the save paths call reads the live document, the current connection or mutable assets after an `await`. This milestone defines the captured document, the frozen `ExportDocument` of milestone 5, including the production, comment and b-roll read models that core already derives, so that a writer needs no legacy helper. The four serializers the save paths call, `buildSplitpageFile` and `buildMarkdownProject` (`20d-formats.js`), `standaloneHtmlFor` (`02b-doc-id.js`) and `toMarkdownDoc` (`14-export.js`), and `exportFacts` (`14b-export-kit.js`), which `toMarkdownDoc` reads the live document through even when handed one, take it. Accepting a document argument is not enough: a serializer run with the live document mutated after capture must produce the captured bytes, and a test asserts it.

**Document-replacement lifecycle test.** A document or tab replacement leaves no session-level handler, timer, observer, subscription or object URL behind (section 6). The test calls the session owner's own dispose, advances the fake clock, lets every pending operation settle, and asserts that nothing from the old document touched the replacement. It does not rely on the app-test helper's own clearing of tracked timers and channels (`src/test/_app-boot.mjs`), which is test housekeeping and would mask missing production cleanup. It separates document-owned resources, which must go, from app-lifetime subscriptions, which must survive a switch, and names each of the latter.

**From the milestone 3 external review (Codex, 2026-10-08; [gate record](architecture/milestone-3-gate.md#external-review)).**
- Operation identity covers every document-scoped continuation, not only saves: a delayed media paste or drop, a gallery picture, thumbnails and recovery capture the session epoch and document id before their await and refuse to complete in another epoch (#478).
- Effects are observational. The dirty effect's `personColors` write moves inside the transaction and into the change set (#479); after this, no effect writes document content.
- A command whose transaction committed but whose undo recording, effect pass or publication threw is a distinct, reported outcome, not `failed`; it is never rolled back.
- The owners this milestone adds (the save coordinator, the transition API, the store adapters) are constructed by an explicit function that takes its ports. None is a module-evaluation singleton with permissive or no-op defaults, so milestone 7's wiring step only moves that call into `src/bootstrap/`.
- #463 (atomic render) keeps section 6's render invariant. A detached draw contains preparation failures but does not stop synchronous focus events during the commit, so the commit phase is guarded and focus is restored within its own surface. #477 fixes today's path first, as a bug fix.

**Gate:** Controlled race matrix passes for document switch, same-ID reopen, changed destination/connection during serialization/upload, edits during writes, out-of-order completions, cancelled dialogs, permission revocation, 409 retries and write failure. Assert actual stored bytes, live document, dirty state, baseline and destination. Browser/desktop recovery tests cover multi-tab ownership, quota/unavailable/corrupt storage, offline images, restart and revoked links. Existing five repaired defects stay fixed. The document-replacement lifecycle test and the capture-contract test above pass.

The blob registry (`02c-blobs.js`) moves into a store adapter here, so two criteria from the milestone 2 external review belong to this milestone:

**Blob ownership.** Records already go out as copies: `recordFor` and `intern` return a fresh record. `bytesForSync`, however, returns the registry's own `Uint8Array`, which cannot be frozen. The store adapter hands out bytes the caller owns: a copy, or an immutable `Blob`. A test writes into the bytes it was given, then reads the same sha again, and gets the original bytes with a matching hash.

**Image-heavy load and merge (#320).**
- Before the registry moves, `tools/perf-record.mjs` gains an image-heavy case, timed in the browser. It opens a document with ten fresh 1 MiB pictures in comment bodies (the review's probe), and it merges two sides that each add such pictures.
- The same script runs against builds of `d18adde` (where milestone 2 started) and `c4d5944` (milestone 2's final tree). Both runs use one machine, browser and font setup, and both results go in `performance-record.md` with their conditions. The case runs again under the same conditions on milestone 4's closing tree.
- The threshold: a median slowdown of more than 10% against `d18adde` on the image-heavy case, on the same machine and browser, means the double hash and copy gets removed in this milestone. A slowdown of 10% or less is recorded and explained. To remove it, hand the decoded record to the store without the second hash and copy, keeping byte ownership, hash validation, first-seen order and persistence when a pass throws.

### 5 — Make formats consume captured data and one registry

**Status (2026-10-14):** code complete, gate passed on `dcfb92d`; external review (Sol, Codex CLI) found 0 blockers and its four findings were fixed in #586 (`6993fcf`) ([gate record](architecture/milestone-5-gate.md)). PRs: #576 (`3e37ede`), #577 (`1f096dd`), #579 (`74f6ecd`), #581 (`ab9e301`), #582 (`dcfb92d`), #586 (`6993fcf`, review fixes); tooling #578, CI #580. The Linux full run and native ARM64 stay with the 4.0 release gate. Node 24 (#583) lands right after.

**Source:** `14b-export-kit.js`, `15-docx.js`, `16-csv.js`, `16b-xlsx.js`, `17-pdf.js`, `20d-formats.js`, import readers and export menus/dialogs.

**Work:** Milestone 4 defines the frozen `ExportDocument` projection from the originating session and options; the writers here take it. Capture relevant timing/date/selection data and image availability; asynchronous asset resolution uses the captured context. Writers never read `S.state`, live UI controls or whichever connection happens to be current.

Use a format registry declaring stable ID, label, supported operations/content, options, accepted input and outcome. Make dialogs/menus consume it. Keep per-format content limits/warnings and existing codec/layout implementations unless a demonstrated defect justifies replacing them. Do not introduce a universal layout framework.

Keep import decoding/sanitization separate from transaction adoption and writeback ownership. Exporting bytes alone does not acknowledge a project/server save; the save coordinator determines that meaning.

**Order (Adam, 2026-10-07: the registry stays).** The capture contract itself and the serializers the save paths call land in milestone 4; this milestone extends them to the remaining exporters, in four steps:

1. The remaining writers take the captured document (Opus, because it reaches the save path). `buildDocx`, `buildCsv`, the XLSX builders, `buildPdf` and the narration, breakdown, b-roll and packing-list builders take milestone 4's `ExportDocument` as their argument, and every `S.state` read in `15-docx.js`, `16-csv.js`, `16b-xlsx.js`, `17-pdf.js` and `14b-export-kit.js` goes. Rendering a captured document leaves live content unchanged. Three requirements come from the external review of this plan (Codex, 2026-10-14; see [Review of this plan](architecture/milestones-4-7-rescope.md#external-review-of-milestone-5-2026-10-14)):
   - *One capture, whole path.* The document and the resolved export options are captured once, before the first await, and passed through every writer and subordinate projection, including plain-text export, PDF image preparation and the narration, breakdown and b-roll tables. A writer neither recaptures the session nor takes an omitted option from a stored preference or panel state. Today `buildFileData` captures and then calls the writers without it, and the PDF branch reads live rows after its await.
   - *Operation-owned assets.* An export request fixes its image references and originating asset source before awaiting, and resolves them once into an operation-owned asset map, including missing-image outcomes; serializers consume that map. Transport credentials and handles stay outside the serializable `ExportDocument`, and existing omission and failure behaviour is preserved. Controlled cases hold local blob retrieval and PDF decoding, then change the document, the connection and the image references, and assert the captured content, the image association, that requests went to the original source and that the replacement state is unchanged.
   - *Captured dates.* Visible dates, document metadata and ZIP entry timestamps derive from the captured date under a documented day convention, and INV-60's test of two captures at different times on the same day runs for every registered format, with one capture serialized after midnight still using its captured date. `zipWrite` and the DOCX and XLSX metadata read the clock today, and `xlsx-export.test.mjs` pins bytes that differ across a two-second boundary; that test changes as an explained correction, not a silent golden regeneration.
2. The byte helpers `zipWrite`, `zipRead`, `strBytes`, `latin1Bytes`, `concatBytes`, `xmlEscape` and `htmlToRuns` move out of `14-export.js` into `src/adapters/formats/`. The writers leaving the import cycle is an acceptance result to verify, not a promise. Measured on `9dd5079`, the writers also import `05-render.js`, `07-production-tags.js`, `08-production-panels.js`, `08d-broll-panel.js` and `10-comments.js` for production, comment and b-roll facts (`16-csv` imports 08 and 10; `16b-xlsx` 08 and 08d; `17-pdf` 05, 07, 08d, 10 and 15; `14b-export-kit` 07, 08, 08c, 08d and 10). Those edges go only when the captured document carries the read models those helpers compute, which is why milestone 4's `ExportDocument` includes them. The PR records `--metrics` before and after; the four writers out of the cycle is the target, and a writer that stays in it is named with the edge that keeps it there. The byte helpers are not the whole cut: capture is separated from the reusable export projections, the remaining writer dependencies on legacy presentation helpers, preferences and asset access become explicit inputs or permitted adapters, `htmlToPlainText` and `tagPrintColor` (imported from `14-export.js` by `14b-export-kit.js`, DOCX, XLSX and PDF) are in the dependency inventory, and the PR records each writer's remaining cycle path, not only the aggregate. Small PRs, in this order: capture and projection changes, mechanical helper moves, registry integration.
3. Import (Opus, because it reaches the save path). Decoding stays in `11-import.js`, `15-docx.js` and `16-csv.js`, and decoding and sanitization stay separate from persistence. Whole-document file and new-document adoption keeps milestone 4's transition API. Appending or replacing rows in the current document (the one write in `11-import.js`) is an edit, not an adoption: it becomes a session command that preserves identity, destination, baseline and characterized undo behaviour, with the imported-row stamps, scans and dependent reconciliation inside the mutation boundary. Routing it through `open()` would adopt a replacement and confirm a baseline. Before the change, append, replace and import-as-new are characterized, and asynchronous modal decoding is bound to its initiating modal and session so a result cannot populate a reopened import.
4. The format registry. Each format declares its stable ID, label, supported operations and content, options, accepted input and outcome; `buildFileData`'s dispatch table becomes the registry lookup; the export dialog (`18c-export-dialog.js`), the menu items and the command palette are drawn from the declaration. Per-format limits and warnings move into it. The gate's test exporter is a throwaway one in the test suite. The registry keeps existing action IDs, persisted Export Again values, defaults, filenames and availability reasons, and distinguishes variants that share an extension: project Markdown, presentation Markdown and imported-file writeback are not interchangeable. Action routing, menu entries and palette entries derive from registration, and the dialog's preview, summary and execution use the same option interpretation, so the dialog no longer finds and clicks a menu button to export.

**Ownership boundary for steps 3 and 4.** Providers build bytes and report format diagnostics; they do not acknowledge saves, adopt documents, retarget destinations or schedule autosave. Registry integration keeps the existing save and writeback entry points and their result distinctions. Acceptance cases: save and writeback requests keep their destination queues, ownership checks and obsolete-result reporting; an ordinary export leaves confirmed generations, baseline, identity and dirty state unchanged; hosted Save As stays a copy and neither acknowledges server edits nor replaces its merge ancestor; shared decoding has no adoption or save effects, so recovery keeps its no-save behaviour and its two documented exceptions ([saving.md](architecture/saving.md) section 7).

**Gate:** Adding a small test exporter requires one provider and registration, with no edits to event routing or save coordination, and the exporter appears and runs through the dialog, the menu, the command palette and Export Again without a hand-added routing branch or menu button. Deterministic byte fixtures, Unicode/images/styles/comments/b-roll, project round trips and the human Markdown half remain stable. Verify representative output through independent readers/viewers, with representative DOCX, XLSX and PDF outputs and the project round trips recorded. Rendering/exporting a captured document leaves live content unchanged. On the closing tree: the full Windows run (both browser runs) and the dev smoke; the milestone 4 race matrix with `SPLITPAGE_M4_GATE=1` and no case demoted; capture-after-mutation coverage for every migrated writer and variant, with the held asset and decode cases of step 1; stored-byte assertions for import writeback while preparation is held; registry-driven export acknowledgment checks; and INV-60's different-times test. No unconditional external review and no x64 packaged check: each PR keeps its independent review, the release review covers the milestone, and packaged verification returns if packaging inputs, runtime loading or the build entry change.

### 6 — Finish feature ownership and editing migration

**Source:** Remaining editor/clipboard/rows/selection/find/tag/b-roll/comment/writer paths, `05-render.js`, `21-events.js`, panels, settings/gallery/prompter views, CSS and page shell.

**Work:** Migrate one feature at a time through the proven commands/selectors/ports. Each feature owns bindings, local state, styles and mount/dispose. Move remaining document writes into application transactions. Keep presenter/voice/native resources in adapters while their view uses narrow application interfaces.

Remove render-time tag repair and document work; ingestion/transactions enforce invariants. Use precise changed inputs for cached derivations. Add overlay/focus ownership preserving panel closure/restoration, stacking, Escape/Tab, Writer/Present behavior and pending composers.

Split CSS as bounded below, with deterministic aggregation. Preserve template ordering, sanitization and CSP. Do not introduce cascade layers or virtualization without equivalence/performance evidence. Preserve caret/selection and composition instead of rebuilding editable DOM indiscriminately.

Finish complex event handling only when the receiving owner exists, preserving priority among tag controls, modifier clicks, selection completion and drag types. Delete `21-events.js` when its real responsibilities have moved and tests pass, not by relocating it into another catch-all module.

**Undo and redo (Adam, 2026-10-07).** Replay today writes `S.state` directly through `applyStepsLive` and reaches the session only afterwards, as `afterUndoApplied`'s `markDirty` ([session.md](architecture/session.md)). Acceptance: an undo or redo replay passes through the application's document-mutation boundary as a transaction kind of its own, preserving today's grouping, coalescing, `forget` and `foldIntoEdit`, draft undo (INV-55) and the owner re-pointing from #402. The undo algorithm, the diffing and the inversion stay.

Commit contract (external review of this plan, 2026-10-14). Replay, row stamps and dependent reconciliation execute inside the mutation boundary. An accepted replay advances the generation once, publishes once and records no new ordinary undo entry. An empty or refused replay has no document edit effects. A failure before the commit leaves the document and the history consistent; a failure after it is reported as committed and does not roll the document back. Today's `commit` in `document-session.ts` records an undo entry and publishes `"edit"` unconditionally, so calling the ordinary command commit for a replay would record the replay again, and wrapping `applyStepsLive` alone would leave the stamps outside the boundary. The change set covers owner re-pointing and cleanup, including lists the original entry did not carry. Every replay route reaches the same transaction API: the keyboard shortcuts, `historyUndo` and `historyRedo`, the toast Undo, and the Writer's close and reopen. Comment and reply draft undo stays local under INV-55. `foldIntoEdit` (thumbnail amendments from `05v-video.js`) is its own task after the replay PR: it keeps its history association and ownership guard and adds no user-visible undo step. The step list, the acceptance table and the tests are in [milestone-6.md](architecture/milestone-6.md).

**Order (from the milestone 3 external review, 2026-10-08, and the external review of this plan, 2026-10-14).** Small, runnable slices, never one editor-migration PR. The editing infrastructure comes first, then the remaining writes, then one feature at a time, then the deletion of `21-events.js`. The full step list, with each step's prerequisites, invariants, tests and model, is in [milestone-6.md](architecture/milestone-6.md):

1. Selection and composition. The selection model (#464, whose acceptance points are on the issue: epoch, scene and field, direction and affinity, atoms, mapping through edits, split and join, undo and incoming changes, and the vanished scene; focus separate from selection; a composition lifetime tied to its cell and session). Opus.
2. Undo. The replay transaction above, then `foldIntoEdit` as a focused follow-up. Opus.
3. Editor commands and media. The remaining direct writes in `05b-cell-edit.js` (which still writes and stamps directly), `06-rows.js` (row mutation), `05-render.js` and `06-rows.js` (the media-cell typed HTML variant, which INV-10 retires), `05c-clipboard.js` and `19-writer.js` (already on commands; the scene clipboard and the video amendments in `05v-video.js` are dependent paths). Then the repair-on-read replacement and the rest of `applyMerge`. Opus.
4. Per-feature moves, each with its bindings, state and styles: tags and b-roll, comments, find, panels, settings, gallery and prompter views. Sonnet where the move is well specified.
5. Startup extraction and the deletion of `21-events.js`. Opus.

Review-mode work stays out of M6 under Adam's standing rule: the reviewer comment-anchor command (#466) is deferred, existing capability checks and working comment and draft behaviour are preserved during extraction, and permissions are not broadened. The already-approved overlay fixes #308 and #350 land after core writing work, each as a focused owner-local repair with fail-first evidence. Comprehensive startup wiring stays in milestone 7. Save-completion consolidation, the remaining recovery extraction, the build-entry switch and unused-`S` cleanup stay in 4.x.

**The `21-events.js` ledger.** Deletion is contingent on a ledger in milestone-6.md with one row per listener, delegated action branch, initialization responsibility and owned resource, each with its receiving owner, event target and phase, precedence, lifetime and disposer, regression evidence and removal PR. Every row is accounted for, the old registrations are removed, and remount evidence shows exactly one handler. Startup is extracted before deletion: initial document loading, stash and draft recovery ordering, identity and history setup, desktop initialization, service-worker registration and unload handling. Relocating `init()` wholesale would recreate the catch-all, and M7's comprehensive wiring stays M7 work.

**Render-time repair (#325).** The replacement lands before any repair call goes: entry and adoption, the affected editor and production commands, import scans, incoming merges, and undo and redo each maintain the records their edit needs, in the same transaction as the originating edit. Only then do the repair calls in the b-roll badge (`08c-broll.js`) and save preparation (`14-export.js`) go, which makes save preparation read-only. Acceptance: repeated render, selector and export reads leave content, generation and history unchanged. M5's import-scan boundary is kept.

**The rest of `applyMerge`.** A named step: characterize its options and callers first, then move orchestration behind typed application ports and the presentation into its owning feature, keeping synchronous callers' contract unless their conversion is explicitly included. This is not another merge-algorithm rewrite, and it does not turn M5's append and replace imports into whole-document adoption. The options table is in milestone-6.md and covers `mergeOnly`, `unchanged`, `report: false`, `alreadySaved`, `noAutoSave`, `newBase`, undo snapshots and `awaitUndoPoint`, with capture and check behaviour kept across snapshot persistence ([saving.md](architecture/saving.md) section 8).

**Ownership across the moved routes.** Save, overwrite, retry and writeback bindings continue through the existing coordinator and destination queues. Feature owners do not write directly or acknowledge exports. Restore keeps its transaction kind and autosave suppression, and only the two exceptions in [saving.md](architecture/saving.md) section 7 remain. An export request keeps one capture before asynchronous preparation. Focused evidence runs through the moved UI routes: overlapping manual and automatic saves, import writeback, ordinary exports and recovery merges.

**Cleanup, bridges and CSS.**
- Each feature's dispose test exercises production cleanup under the rule of milestone 4's lifecycle test: call the feature's own dispose, advance the fake clock, settle pending work, assert nothing reached the replacement, never rely on the app-test helper's housekeeping, and name the app-lifetime subscriptions that legitimately survive. For each migrated asynchronous owner the cases are: dispose and reopen while work is held, same-ID document replacement, stale completion after remount, and a normal completion as the control. The session, the target and any composer or modal lifetime are captured before the asynchronous work begins. The paint and blur suppression and the failed-render restrictions from M4 move with the editing code into the receiving owners; a repaint cannot commit stale DOM, and a legitimately pending typed value keeps its characterized behaviour.
- A bridge or duplicate implementation goes in the PR that migrates its last consumer. There is no standalone bridge-retirement milestone in 4.0, but a bridge with no importer left is removed, not kept.
- The CSS split is a firm deliverable, bounded to the part that pays for UI work: the inline colour literals finished as tokens in one PR (spacing stays as px); `build.mjs` concatenating a declared list of files in a fixed order, added with the first feature that takes its styles; and per-feature files for migrated features only, each feature's rules moving into its folder when the feature does, with the rules of features that stay legacy staying in `app.css`. Sorting the remaining rules into base, layout and components, and spacing tokens, are 4.x (section 8). Every CSS move keeps the visual comparison under documented font and runtime conditions, responsive views, focus states and reduced motion, because cascade order can change what the user sees even when every declaration is identical. The criteria are executable, not descriptive (external review of this plan, 2026-10-14): a declared, case-correct ordered file list with explicit separators, missing-input and duplicate-input checks, and preserved cascade order and media-query placement; tests that read the same aggregate as the build, including `palette.test.mjs`, `plain-tags.test.mjs` and `render-guard-app.test.mjs`, which read `app.css` directly today; before and after captures of the affected views in light and dark themes, the relevant narrow and wide layouts, focus states and reduced motion, with font loading or fallback, browser or Electron version, viewport and scale recorded; and verification of the generated inline CSS, the CSP, the worker stamp and the standalone HTML output on Linux CI as well as the existing Windows checks. Token conversion is its own PR, separate from the first aggregation or feature move. There is no build-entry switch and no external runtime stylesheet.

**Gate:** Migrated features contain no global state access, concrete platform services or direct live-document mutation. Remount/dispose tests find no duplicate handlers, owned timers, observers, subscriptions or object-URL leaks. Real-browser typing/IME/cut-paste/split-join/anchors/undo, focus, responsive/reduced-motion and representative visual checks pass. Independent feature changes do not require edits to unrelated feature internals. On the closing tree, run the existing race matrix with `SPLITPAGE_M4_GATE=1`, with no previously passing case demoted or weakened; retain M5's capture, asset, writeback and registry evidence and INV-60. Add the replay, moved-handler and production-dispose evidence specified above. The Windows full runs (both browser runs), the Electron dev smoke and the external review are required as before. New checks use a portable Node entry point and environment setup, and the Linux hosted discovery, type and build gates stay. The packaged check applies only if packaging or runtime inputs change.

**Safe separate work:** Different feature folders after public interfaces are stable. Shared action registration, application policies, CSS tokens/ordering and overlay rules stay with the integration owner.

### 7 — Wire frontend owners explicitly and verify 4.0

**Work (narrowed, Adam, 2026-10-07):** One explicit wiring step in `src/bootstrap/` constructs the session, the bridge, the commands and the registries with their dependencies passed in, and `_entry.js` calls it, as it already calls `startActions`. A dependency-direction test alone cannot show independence from startup order, and the bridge shows why: `src/legacy/session-bridge.ts` creates the session at module evaluation with `dirty`, `draft` and `save` effects that do nothing, a capability that allows every edit and an editor named "Anonymous", until each legacy module calls `provideSessionEffects` or `provideRefreshRunner` as a side effect of being loaded. A module loaded in the wrong order, or not at all, leaves a session that accepts edits and fans out nothing. Tests cover startup (every owner is wired before anything mounts), a failed partial startup (a missing or throwing dependency reports and refuses to mount, rather than running half-wired with defaults) and cleanup (the wiring step's teardown releases what it built).

`_entry.js` is the named, documented legacy initializer shim, with an owner per remaining module in `dependencies.md`. New features never depend on numbered load order, and a test shows that nothing under `src/application`, `src/features` or `src/bootstrap` imports the shim or registers into it. Preserve `PAGE_SHELL` capture before document DOM mutation, initial seed/identity ordering and build-time CSP hashes: `PAGE_SHELL`, the `sw.js` stamp and the CSP hashes stay as they are, since nothing moves them. The build entry does not switch and no `S` field is removed in 4.0; a bridge goes in the PR that migrates its last consumer (milestone 6), with no standalone retirement campaign.

Keep generated `index.html` untracked, inlined/self-contained output, authoritative `VERSION`, the tracked worker stamp and supported offline/upgrade behavior. Scope cache cleanup to app-owned caches. Update both Docker recipes, portable staging, desktop staging/protocol allowlists, verification scripts and CI artifacts whenever runtime paths change. Test packages without a nearby checkout; some consumers still list individual server/shared files.

**Gate:** Completed frontend areas have enforced acyclic dependencies, strict types, no authored comments and one document-mutation boundary. The wiring step's startup, failed partial startup and cleanup tests pass, and so does the test that nothing migrated imports or registers into the shim. The resource-release test for document/tab replacement is part of milestone 4's gate for the session and milestone 6's for each feature. Remaining legacy exceptions are exact and visible. The Windows run and the dev smoke pass; the x64 packaged check is required only if the build entry changes, which this milestone avoids. Pass section 7's release matrix before declaring 4.0 ready.

The two PRs, their file lists and tests, the gate evidence and the release-checklist inputs are in [milestone-7.md](architecture/milestone-7.md).

## 6. Required ownership/race invariants

These are architectural contracts, not optional tests or comments to add to source:

- Document identity, session epoch, local edit generation, destination generation and server revision have different meanings.
- Every accepted user transaction includes its dependent anchor/record reconciliation; no-op and rejected operations produce no edit side effects.
- A view or selector never changes document content; document snapshots passed outside the owner cannot be written back by reference.
- Rendering creates no edit: whatever focus or blur events it causes, it cannot commit a cell's DOM to the document, roll back an accepted update, or let stale DOM overwrite the current document (#477, #463).
- Credentials, invitation fragments, native handles and unrelated documents never enter project exports or recovery metadata.
- The baseline is exactly what that destination confirmed. Copies, imported-file writeback, hosted saves and draft capture acknowledge different things.
- Async results carry their originating context. Transport cannot change mid-operation through a mutable global lookup. Cancellation does not prove a write failed to land.
- Recovery preserves source work through failed adoption, writer conflict or revoked access. Restoration does not silently save a user file.
- Host/application capability checks cannot broaden document-link permissions; server restrictions remain authoritative.
- Closing/replacing an owner releases its resources. Failed cleanup cannot leave privileged native children or active callbacks operating on a replacement session.
- Format/schema/merge compatibility, deterministic exports and legacy media are preserved by existing and newly identified fixtures.

## 7. Release evidence and PR reporting

### 4.0 release checklist

- Fast gates pass on the final branch: lint, types, comments, layers/dependencies, all discovered unit/application/adapter/tool tests, build and selected critical browser tests.
- Every existing browser suite is discovered by full filename and passes on Linux and Windows where supported. Genuine platform-only checks run on their supported platform; remaining skips are named and cannot be counted as passed. An unresolved missing release check blocks the release-readiness claim.
- Real Electron smoke runs; Windows packaged x64/ARM64 payload/install/runtime checks and native checks are reported with actual execution evidence from the x64 and ARM64 devices. Building an ARM64 artifact on x64 alone is not an ARM64 runtime check.
- Both Docker paths and the portable distribution start with fresh data and representative existing data, without importing unshipped source. Persistent sign-ins/links, permissions, offline app behavior and worker upgrade remain correct.
- Test 4.0 client against the unchanged 3.1 server, and supported 3.1/4.0 project exchanges. If backend code changed, add old-client/new-server coverage. Keep existing IPC shapes and native capability checks.
- No migrated frontend feature accesses global `S` or mutates live state. Forbidden edge sets shrink and contain no new violations; completed areas contain no cycles, including cycles through bridges. An increase in legitimate imports/module count is not automatically a defect.
- The release names the legacy initializer shim, the count of numbered modules it still starts, and the bridge files that remain, with their owners, so the remaining legacy is described rather than declared gone.
- The external review at the release gate covers milestones 5 and 7 together with milestone 6's own.
- Source/format fixtures stay stable; performance/visual comparisons use documented runtime/font conditions. Any material change is explained and verified.
- Architecture ownership map, invariant ledger, testing instructions and remaining legacy work accurately describe the delivered source.

### Every PR records

Provide the concrete behavior preserved/fixed, ownership before/after, removed coupling and bridge changes, tests actually executed, failures/skips, compatibility/packaging/security effects and updated invariant rows. Include a short old-module → new-owner mapping. No bare “all tests pass” when platform checks were omitted.

Keep expected operational failures and missing execution environments visible. Continue unaffected work when a platform is unavailable, but do not bypass dependent milestone/release gates or claim those checks passed. Avoid repeat full test runs without new changes or unresolved concerns; use focused verification during PR work and full runs at the defined gates.

## 8. Follow-up refactors for 4.x

The 4.1 plan for the places where 4.0 fell short of this plan (the legacy layer's size, the import loop, the wiring files that replaced `21-events.js`, and the third `S.state` assigner) is [legacy-reduction.md](architecture/legacy-reduction.md). It also deletes `S` (Adam, 2026-10-16), which replaces item 3 below.

### Frontend bootstrap

In this order (Adam, 2026-10-07):

1. The composition root as build entry, replacing `src/js/_entry.js`, as the first 4.x milestone, with the packaged check and an external review of its own.
2. Any bridge still standing after milestone 6, with the legacy modules that keep it. `src/legacy/production-index-bridge.ts` exposes the application production index to `07`, `08`, `08c` and `08d`; retire it when their last numbered consumer becomes a feature.
3. Unused `S` fields.
4. CSS: sorting the remaining rules into base, layout and components (done: `src/styles/base.css`, `layout.css`, `components.css`, and `overrides*.css` for rules that must follow specific feature styles), then spacing tokens (done).

### Save completion and recovery

From the external review of milestone 5's plan (Codex, 2026-10-14). Neither is a prerequisite of milestone 5 or 6.

- **One owner for save completion.** Consolidate completion decisions and projection updates behind one application owner, preserving destination-specific acknowledgment and hosted restore behaviour. Today `confirmWrite` in `14-export.js` and the coordinator acknowledge the same save in separate steps ([saving.md](architecture/saving.md) section 8). The work crosses file saves, hosted saves, publication and adoption, so it is its own 4.x piece; a concrete regression can bring a focused fix forward.
- **Remaining recovery extraction.** Move the remaining orchestration and restore decisions out of `20g-drafts.js`, reusing milestone 4's capture scheduler, draft writer, restore policy and store adapters. It does not recreate those owners.

### Server services

Extract `createServer(dependencies, config)` from process startup. Separate validated configuration, HTTP decoding, authorization by operation/document scope, document/comment services, grant/secret repository, blob budgets/reference rules, presence and durable filesystem storage.

Define and test memory/disk/restart consistency for mint/renew/revoke/delete under injected persistence failure. Preserve malformed-input responses, compare-and-set writes, per-document serialization, owner rotation, link revocation/restart behavior, tombstones and private permissions. Keep the documented public owner-key/capability-link deployment boundary and intentional LAN profiles explicit.

Update both Docker recipes, `deploy.sh`, portable/desktop staging and CI payload assertions in the same PR as module extraction. Backups include documents, blobs and link/owner-secret data. Code rollback preserves newer revocations; data restore has an explicit revocation/rotation procedure. Test configuration and deploy/rollback behavior against isolated fixtures, never the live server.

### Desktop services

Extract tabs/session registry and file service first, then IPC composition, hosting/process lifecycle, voice, Drive/credentials, protocol policies and updates. Keep narrow injected interfaces, opaque file IDs, sender validation, sandboxing, context isolation, separate tab-strip origin and restricted native capabilities.

Replace unconditional `desktop/.npmrc` ARM64 installation assumptions with runner-aware settings. Retain a single IPC contract source and verify any emitted CommonJS/preload code and runtime resources. Real Electron security/lifecycle and installed-target checks remain the gate; source-text tests alone do not establish behavior.

## 9. Starting instruction

Use the following as the starting instruction for a session on `4.0-development`, with this file attached:

> Implement `docs/IMPLEMENTATION-PLAN.md` on `4.0-development` in small, reviewable increments. Plugins and SDK work are out of scope. Add no authored code comments or inline suppressions, in workflow and configuration files included. Read section 0 for the decisions already made and do not reopen them. Continue milestone 0 from where the branch is: check which of its eight items have landed, then complete the rest in order: layer/exception baselines, strict TypeScript, lint and test discovery, the section 4 CI policy, the invariant ledger, the performance record. Preserve existing fixes, user data, file/wire/IPC compatibility and distribution behavior. Do not redistribute complex editor events before the command/session boundary exists. Deliver verified tooling and baseline evidence as focused PRs, then proceed in the stated milestone order. Report actual checks, skips, removed coupling and remaining blockers. Do not deploy or publish as part of this work.

The first deliverable is working verification and an accurate baseline, not an empty folder scaffold or a renamed `21-events.js`.

## 10. Reference constraints

These documents support tooling/security constraints; actual implementation gates still run on the repository's declared runtime/platform versions:

- [Node.js native TypeScript execution](https://nodejs.org/api/typescript.html): erasable syntax, explicit type imports/extensions, separate type checking and no runtime interpretation of `tsconfig.json`.
- [TypeScript `erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html): compiler enforcement of the selected syntax subset.
- [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use): privilege and isolation considerations for self-hosted workflow execution.
