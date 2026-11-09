# Splitpage implementation record and standing rules

**Status:** The architecture milestones and legacy reduction are complete. Splitpage 0.4.1 shipped on 2026-11-02 as [v0.4.1](https://github.com/RetroGorilla/splitpage/releases/tag/v0.4.1). [ROADMAP.md](ROADMAP.md) links to current work. The numbered milestones and their original “4.0” and “4.1” names below are historical, not future release promises. Sections 2–4 and 6 retain the standing engineering rules; old milestone gates record the policy for that run.

**Objective:** Make ordinary changes local, understandable and independently testable. Give each document operation, feature and platform resource an explicit owner. Preserve the app's current behavior and distribution model.

**Scope decision:** Plugins, a plugin SDK, a plugin host and an isolated extension runtime are out of scope. Internal action and format registries remain because they simplify application development.

**Authority:** This records the completed refactor and its standing rules. Current work needs an open issue or a written owner decision. It lives on `main` and is amended there by PR when a decision changes.

**Historical source baseline:** `main` at `80500f6ef6b8f32b68a22c95210dcb962a989fc3`, then called 3.1.0. Published tags now use `v0.3.*` and `v0.4.*`. Check current `origin/main` before editing.

## 0. Decisions

| Decision | Outcome |
| --- | --- |
| Release | 0.4.3, released 2026-11-09 as `v0.4.3`. `main` is the only long-lived branch. |
| Plugins, SDK, extension runtime | Out of scope |
| Language for new folders | TypeScript, strict, erasable syntax only (section 3) |
| Comments | None in authored code, tests, CSS, HTML, scripts or workflow/configuration files, except short reason comments (section 2) |
| CI | Fast gates on hosted runners for PRs and the development branch; the full browser regression and the Electron smoke run locally at every milestone gate; the Windows x64 packaged check and the external review run at the gates of milestones 3 and 4, at milestone 6's gate for the external review, at the gate of any milestone that switches the build entry or changes packaging inputs for the packaged check, and at the 4.0 release gate; the Linux full run and the native ARM64 packaged checks run at the 4.0 release gate only (section 4; Adam, 2026-10-07) |
| Lane models | Sonnet by default; Opus for the areas listed in section 2; every review is Opus (Adam, 2026-10-07) |
| Milestones 4–7 | Re-scoped and approved by Adam, 2026-10-07: milestone 5 in full with the registry, milestone 6 with the bounded CSS split, milestone 7 narrowed to explicit wiring and the named legacy initializer shim (sections 1, 5, 7 and 8); the approved page is [milestones-4-7-rescope.md](https://github.com/RetroGorilla/splitpage/blob/d84f28bd/docs/architecture/milestones-4-7-rescope.md) |
| ARM64 | A Windows ARM64 device is available; native ARM64 runtime checks run on it at the 4.0 release gate and the release row stands as written |
| Invariants | Ledger in `docs/architecture/invariants.md`; `docs/HANDOFF.md` section 5 stays in step with it (milestone 0) |

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

**Follow-up status:** Section 8 records what landed or was removed. It is not a backlog. New work follows [ROADMAP.md](ROADMAP.md) and GitHub issues.

No UI framework replacement, editor-engine replacement, persisted document schema migration, collaboration algorithm replacement or new user feature is included. Keep 3.1 file/HTTP/IPC compatibility. Distinguish intentional distribution-version changes from file-format changes.

## 2. Working agreement

### Branches and small changes

1. Read applicable repository instructions, `docs/help.md`, `docs/HANDOFF.md` section 5, build/packaging scripts and tests for the area being changed. Resolve stale prose against executable source and fixtures.
2. Branch from the latest `main`. Preserve unrelated working changes; use a clean worktree where necessary.
3. Keep PRs focused on one ownership boundary. Separate a demonstrated behavioral repair from a broad extraction. Keep the application runnable after each PR.
4. Bug fixes go to `main`, the only long-lived branch, as [review.md](architecture/review.md#2-where-bugs-get-fixed) describes. A bug in code that a pending step is moving is fixed after that move lands, in the module that now owns it, with its regression test. Do not restore deleted implementations or maintain two competing paths. Historical defect dispositions are in [pinned-defects.md](architecture/pinned-defects.md); check each issue's current state before starting.
5. Enhancements follow the issue's owner decision. Build them on the current structure. Do not infer a release assignment from the old milestone names.
6. Do not pause for routine naming, file placement or reversible implementation decisions. Record substantive behavior/compatibility uncertainties before dependent changes. The milestone run is complete.
7. Do not deploy to the live service, overwrite user data, publish releases or merge into `main` as an incidental verification step.
8. The milestone 4–7 re-scope is done. Adam approved it on 2026-10-07 ([milestones-4-7-rescope.md](https://github.com/RetroGorilla/splitpage/blob/d84f28bd/docs/architecture/milestones-4-7-rescope.md)). It kept milestone 5 in full and narrowed milestone 7. It is not a pending approval.

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

One exception (Adam): a **reason comment** explains why, not what; review judges the explanation. It is up to two consecutive comment lines of at most 120 characters each. The first starts `// why: ...` in scripts, `# why: ...` in shell, PowerShell and YAML run blocks, or `/* why: ... */` in CSS. A second line is a plain continuation comment directly below. A `docs/<file>.md#<anchor>` link is optional; when present, the gate checks the heading or `<a id>` exists. Reason comments never enter the baseline. Narration, commented-out code, TODOs, banners and every other new comment still fail.

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
| `src/adapters/` | HTML decoding, formats, storage, files, HTTP, clipboard and native integration | Port interfaces, boundary types and platform APIs |
| `src/features/<feature>/` | Controller, view, bindings, local state, styles and tests | Public application interfaces and presentation utilities |
| `src/bootstrap/` | Explicit construction, registration and resource teardown | Implementations needed to compose the app |
| `src/legacy/` | Retired: the numbered files and every bridge are gone (the last, `app-actions.ts`, in #906). Do not add files here | Only explicitly allowed legacy/application interfaces |
| `shared/` | Policies genuinely shared with server/desktop | Environment-independent definitions |
| `tests/` | Application, adapter, browser, architecture and compatibility tests | Testable public interfaces and fixtures |

Views use application interfaces; application uses core and declared ports; adapters implement ports; bootstrap constructs them. Core cannot import browser/DOM/storage/network/native APIs, application modules, legacy modules or UI. Application cannot import concrete adapters/features. Feature-to-feature orchestration goes through application interfaces or explicit bootstrap composition.

Legacy adapters may supply implementations of application ports. They cannot create a reverse dependency from core/application into numbered legacy modules. A remaining legacy composition shim can consume a new service during transition, with its exact exception documented. Cycles involving migrated code are prohibited even if their path passes through legacy modules.

Track existing violations by source, target and rule, not only counts. New prohibited edges fail; resolved exceptions are removed. Track runtime import cycles separately from type-only references, but apply layer rules to both. Resolve static imports, re-exports, known CommonJS requires and literal dynamic imports. Document unresolved dynamic loading instead of silently excluding it.

Report global-state access across all production source paths, including migrated folders. Direct `S.state` writers are a limited metric, not proof that nested/aliased writes are absent. Migrated features cannot import `S`, expose a writable live state, or call legacy mutation helpers through an untracked facade.

### TypeScript and test execution

New extracted source uses strict TypeScript with erasable-only syntax. Leave untouched JavaScript alone. A JavaScript file under `src/features/`, `src/application/` or `src/adapters/` that is about to change substantially is converted to TypeScript first, in its own PR with no behaviour change (Adam, 2026-10-27). Pin compatible TypeScript/parser tooling in the lockfile; extend lint and comment/dependency parsers to `.ts` files.

Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. For directly executed Node tests, use a consistent Node-compatible module/import-extension configuration. Use explicit type imports and `.ts` source extensions where native execution requires them; do not depend on `tsconfig` path aliases working at runtime. Separate core/application environment declarations from DOM/native adapter declarations.

Keep `tsc --noEmit` as its own gate. Native Node type stripping executes supported syntax but does not type-check or interpret `tsconfig.json`. Validate on the repository's supported Node 22 and 24 versions, honoring `.nvmrc` and package engine constraints; do not silently lower supported versions.

Update test discovery explicitly. The existing `npm test` only selects `src/test/*.test.mjs`; it must also execute new core/application/feature/adapter tests. Print discovered/executed files and fail unexpectedly empty groups. Keep existing scripts or compatibility wrappers working. Ship bundled/emitted JavaScript; do not assume packaged Electron/server runtimes can execute source TypeScript directly.

## 4. Verification baseline and CI policy

The reviewed snapshot has 77 frontend modules, a 63-module runtime import cycle, 57 `_state` importers and nine modules directly assigning `S.state`. It contains 63 frontend unit-test files and 161 browser-suite text files. Recompute these on the implementation branch; the numbers diagnose debt and are not success criteria by themselves.

Previous source checks passed build/lint, all 63 frontend test files, available desktop module/payload checks, 618 server checks and 23 updater tests. The Windows speech grace check was skipped. Full browser suites, real Electron smoke, Docker images and installed Windows targets were not executed in that review. Start implementation with a clean baseline; do not present prior results as validation of new changes.

### CI policy

Every check is a local script first (`package.json` scripts and `tools/`); CI jobs call those scripts and nothing else, so a run on a workstation and a run on a hosted runner are the same check.

**Hosted, on every PR targeting `main` and every push to `main`:** classify changed paths, then run the fast gates for code changes. Lint, types, the comment/layer/dependency gates, every discovered unit/application/adapter/desktop/tool test, generated-file checks, the build, and the selected browser flow suites already in `ci.yml`. Linux runners only. Markdown-only prose completes the required check through a cheap gate; `docs/help.md` is an app build input and runs app checks. App/desktop-affecting changes also run the dev desktop smoke. A push to main can reuse a passed run of its exact tree. [testing.md](architecture/testing.md#ci) describes the current jobs; the milestone runs below are historical.

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
| Distribution | Standalone app, worker/CSP/offline behavior, portable package and Windows x64/ARM64 payload/runtime checks |

Do not weaken assertions, rewrite golden bytes, suppress genuine failures or expand exceptions to get a green check. Replace brittle source-text checks only after equivalent executable behavior/security checks exist. Use controlled completions/fake clocks for application races and real input for browser composition/selection.

## 5. Milestones for 4.0

Milestones 0 to 7 are finished and included in the published 0.4.1 release. Other documents that cite "milestone N" or "M*N*" mean these. The full milestone text, with each one's work list and gate, is in git history: `git show c73b1f8b:docs/IMPLEMENTATION-PLAN.md`.

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

This is the historical milestone checklist. The server and collaboration checks no longer apply: those features were removed in #905. The current release recipe is [RELEASING.md](RELEASING.md).

- Fast gates pass on the final branch: lint, types, comments, layers/dependencies, all discovered unit/application/adapter/tool tests, build and selected critical browser tests.
- Every existing browser suite is discovered by full filename and passes on Linux and Windows where supported. Genuine platform-only checks run on their supported platform; remaining skips are named and cannot be counted as passed. An unresolved missing release check blocks the release-readiness claim.
- Real Electron smoke runs; Windows packaged x64/ARM64 payload/install/runtime checks and native checks are reported with actual execution evidence from the x64 and ARM64 devices. Building an ARM64 artifact on x64 alone is not an ARM64 runtime check.
- The portable distribution starts without importing unshipped source. Offline app behavior, worker upgrade, project compatibility and native capability checks remain covered.
- No migrated frontend feature accesses global `S` or mutates live state. Forbidden edge sets shrink and contain no new violations; completed areas contain no cycles, including cycles through bridges. An increase in legitimate imports/module count is not automatically a defect.
- The legacy initializer shim and numbered frontend modules are gone; see section 8.
- The external review at the release gate covers milestones 5 and 7 together with milestone 6's own.
- Source/format fixtures stay stable; performance/visual comparisons use documented runtime/font conditions. Any material change is explained and verified.
- Architecture ownership map, invariant ledger, testing instructions and remaining legacy work accurately describe the delivered source.

### Every PR records

Provide the concrete behavior preserved/fixed, ownership before/after, removed coupling and bridge changes, tests actually executed, failures/skips, compatibility/packaging/security effects and updated invariant rows. Include a short old-module → new-owner mapping. No bare “all tests pass” when platform checks were omitted.

Keep expected operational failures and missing execution environments visible. Continue unaffected work when a platform is unavailable, but do not bypass dependent milestone/release gates or claim those checks passed. Avoid repeat full test runs without new changes or unresolved concerns; use focused verification during PR work and full runs at the defined gates.

## 8. Completed follow-up refactors

- **Frontend bootstrap and global state:** done. The build starts at `src/bootstrap/main.ts`. `src/js/`, `src/legacy/`, the bridges and global `S` are gone; the last legacy facade moved in #906. The completed legacy-reduction plan is in git history (`git show c73b1f8b:docs/architecture/legacy-reduction.md`).
- **CSS:** the base/layout/component split and spacing tokens are done. AQ-34 regrouped styles by purpose in #986.
- **Save completion:** AQ-38 merged in #1019. The coordinator makes the file-save completion decision and runs `application/save/save-completion.ts`. Deprecated import writeback retains its own timing; see [saving.md](architecture/saving.md).
- **Recovery:** the owner and capture/restore helpers live in `src/application/recovery/`. Server-draft restore and the browser draft store were removed in #905.
- **Server services:** the old API and collaboration extraction plan no longer applies. #905 removed those features. `server/` serves static files.
- **Desktop services:** IPC composition, lifecycle and voice extraction are done (AQ-35–AQ-37: #1002, #1005–#1010, #1013, #1016). The current module map is [desktop-build.md](architecture/desktop-build.md).
- **Electron architecture:** `desktop/electron-arch.mjs` selects the native runtime; the unconditional ARM64 installation pin is gone. See [RELEASING.md](RELEASING.md#tabs-build-2026-09-14-and-the-arm64-dev-pin).

Do not turn this record into a new extraction queue. Open work belongs in GitHub issues.

## 9. Starting instruction

Read `AGENTS.md`, [ROADMAP.md](ROADMAP.md), the assigned GitHub issue and its latest owner decisions. Check current `origin/main` before editing. Work in small PRs and report the checks actually run. Do not restart the completed milestones or the finished agent queue. Do not deploy or publish as part of ordinary implementation work.

## 10. Reference constraints

These documents support tooling/security constraints; actual implementation gates still run on the repository's declared runtime/platform versions:

- [Node.js native TypeScript execution](https://nodejs.org/api/typescript.html): erasable syntax, explicit type imports/extensions, separate type checking and no runtime interpretation of `tsconfig.json`.
- [TypeScript `erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html): compiler enforcement of the selected syntax subset.
- [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use): privilege and isolation considerations for self-hosted workflow execution.
