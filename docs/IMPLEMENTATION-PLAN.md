# Splitpage 4.0 — implementation plan

**Objective:** Make ordinary changes local, understandable and independently testable. Give each document operation, feature and platform resource an explicit owner. Preserve the app's current behavior and distribution model.

**Scope decision:** Plugins, a plugin SDK, a plugin host and an isolated extension runtime are out of scope. Internal action and format registries remain because they simplify application development.

**Authority:** This is the plan for 4.0. It supersedes the September 2026 architecture plan and the interim roadmap; their compatible product invariants are preserved, and this document controls sequencing, scope and acceptance. It lives on `4.1-development` and is amended there by PR when a decision changes.

**Source baseline:** Version 3.1.0, `main` at `80500f6ef6b8f32b68a22c95210dcb962a989fc3`. Recheck the implementation branch before editing. This is a plan, not a claim that the refactor is implemented.

## 0. Decisions

| Decision | Outcome |
| --- | --- |
| Release | 4.1, from `4.1-development` (which carries on from `4.0-development`); `main` merged in at least weekly |
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

**4.x follow-up:** The frontend bootstrap items and server and desktop service extraction in section 8. Their existing functional, security and packaging checks remain release requirements even when their internal refactors are deferred. Describe remaining legacy debt honestly; do not declare the entire repository fully refactored at 4.0.

No UI framework replacement, editor-engine replacement, persisted document schema migration, collaboration algorithm replacement or new user feature is included. Keep 3.1 file/HTTP/IPC compatibility. Distinguish intentional distribution-version changes from file-format changes.

## 2. Working agreement

### Branches and small changes

1. Read applicable repository instructions, `docs/help.md`, `docs/HANDOFF.md` section 5, build/packaging scripts and tests for the area being changed. Resolve stale prose against executable source and fixtures.
2. Use the existing `4.1-development` branch, or create it from current `main` if absent. Preserve unrelated working changes; use a clean worktree where necessary.
3. Keep PRs focused on one ownership boundary. Separate a demonstrated behavioral repair from a broad extraction. Keep the application runnable after each PR.
4. No 3.1.x release is planned before 4.0, so `3.1.x-development` takes no more bug fixes, and nothing is forward-merged from it. A bug that also exists on 3.1.x is fixed on `4.1-development` instead, as [review.md](architecture/review.md#2-where-bugs-get-fixed) describes. A bug in code that a pending step is moving is fixed after that move lands, in the module that now owns it, with its regression test; do not restore deleted implementations or maintain two competing paths. The closed 3.1.x fix branches (`fix/274-overlay-commands`, `fix/276-save-during-load`, `fix/278-290-ids-and-nested-links`, `fix/280-282-anchor-tags-and-cue-retitle`, `fix/281-283-md-null-href-and-person-merge`, `test/293-history-toast-race`) are the reference for those ports and their fail-first tests. Every defect that milestone 2 pinned or deferred has a disposition in [pinned-defects.md](architecture/pinned-defects.md), and each one that will be fixed has an issue.
5. Open enhancement issues wait for 4.x. A feature that touches editor, saving, formats or feature views is built once on the new structure. The integration owner decides per issue and says so on the issue.
6. Continue through milestones after their gates pass, with item 8 as the one planned pause. Do not pause for routine naming, file placement or reversible implementation decisions. Record substantive behavior/compatibility uncertainties before dependent changes.
7. Do not deploy to the live service, overwrite user data, publish releases or merge into `main` as an incidental verification step.
8. Before milestone 4 starts, the integration owner writes a one-page re-scope of milestones 4–7 for Adam's approval (Adam, 2026-10-07). For each milestone it answers one question: does the milestone make the next ordinary change easier to make and verify in isolation? Milestones 4 and 6 stay. Formats (milestone 5) and bootstrap/teardown (milestone 7) are candidates to stay legacy behind a narrow adapter, as section 1 already allows for server and desktop internals. The re-scope names what section 7's release checklist loses for each part that stays legacy, keeps the resource-release contract of section 6 (milestone 4's transition API depends on it), and keeps the captured export projection that milestone 4's save paths need. No milestone 4 work starts before the milestone 3 gate. Done: Adam approved the re-scope on 2026-10-07 ([milestones-4-7-rescope.md](https://github.com/RetroGorilla/splitpage/blob/d84f28bd/docs/architecture/milestones-4-7-rescope.md)); milestone 5 stays in full and milestone 7 is narrowed, as section 5 states.

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
| Distribution | Standalone app, worker/CSP/offline behavior, portable package and Windows x64/ARM64 payload/runtime checks |

Do not weaken assertions, rewrite golden bytes, suppress genuine failures or expand exceptions to get a green check. Replace brittle source-text checks only after equivalent executable behavior/security checks exist. Use controlled completions/fake clocks for application races and real input for browser composition/selection.

## 5. Milestones for 4.0

Milestones 0 to 7 are finished and 4.0 has shipped. Other documents that cite "milestone N" or "M*N*" mean these. The full milestone text, with each one's work list and gate, is in git history: `git show c73b1f8b:docs/IMPLEMENTATION-PLAN.md`.

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

The 4.1 legacy-reduction plan (the legacy layer, the import loop, the wiring files that replaced `21-events.js`, and deleting `S`, Adam 2026-10-16, which replaced item 3 below) is finished; its text is in git history (`git show c73b1f8b:docs/architecture/legacy-reduction.md`).

### Frontend bootstrap

In this order (Adam, 2026-10-07):

1. The composition root as build entry, replacing `src/js/_entry.js`, as the first 4.x milestone, with the packaged check and an external review of its own. Done: `src/bootstrap/main.ts` ([dependencies.md, The composition root](architecture/dependencies.md#the-composition-root)).
2. Any bridge still standing after milestone 6, with the legacy modules that keep it. Done: `src/js/` is deleted, and `src/legacy/` is gone; its last file, the action registry facade `app-actions.ts`, moved into the actions port (`src/bootstrap/wiring/ports/actions.ts`) in #906. The production index and export capture owners reach their callers through ports built by the wiring.
3. Unused `S` fields.
4. CSS: sorting the remaining rules into base, layout and components (done: `src/styles/base.css`, `layout.css`, `components.css`, and `overrides*.css` for rules that must follow specific feature styles), then spacing tokens (done).

### Save completion and recovery

From the external review of milestone 5's plan (Codex, 2026-10-14). Neither is a prerequisite of milestone 5 or 6.

- **One owner for save completion.** Consolidate completion decisions and projection updates behind one application owner, preserving destination-specific acknowledgment. Today the file writer's `confirmWrite`, whose steps are the save completion owner's (`application/save/save-completion.ts`), and the coordinator acknowledge the same save in separate steps ([saving.md](architecture/saving.md) section 8). The work crosses file saves, import writeback and adoption, so it is its own 4.x piece; a concrete regression can bring a focused fix forward.
- **Remaining recovery extraction.** Done: `20g-drafts.js` became `src/application/recovery/drafts.ts`, with the capture plan in `capture-schedule.ts` and the restore decisions in `draft-restore.ts` and `draft-resume.ts`. Server-draft restore and the browser draft store were removed with the server features (#905).

### Server services

Extract `createServer(dependencies, config)` from process startup. Separate validated configuration, HTTP decoding, authorization by operation/document scope, document/comment services, grant/secret repository, blob budgets/reference rules, presence and durable filesystem storage.

Define and test memory/disk/restart consistency for mint/renew/revoke/delete under injected persistence failure. Preserve malformed-input responses, compare-and-set writes, per-document serialization, owner rotation, link revocation/restart behavior, tombstones and private permissions. Keep the documented public owner-key/capability-link deployment boundary and intentional LAN profiles explicit.

Update portable/desktop staging and CI payload assertions in the same PR as module extraction. Backups include documents, blobs and link/owner-secret data. Code rollback preserves newer revocations; data restore has an explicit revocation/rotation procedure. Test configuration and deploy/rollback behavior against isolated fixtures, never the live server.

### Desktop services

Extract tabs/session registry and file service first, then IPC composition, hosting/process lifecycle, voice, Drive/credentials, protocol policies and updates. Started: the state store, file service, document claims, recents, tab registry, window appearance, restore notice, unsaved-changes dialog, update release choice, IPC registration (`ipc-setup.js`), the file channels (`ipc-files.js`), the shell channels (`ipc-shell.js`), the document and draft channels (`ipc-document.js`), the history and blob channels (`ipc-history-blob.js`) and the tab strip channels (`ipc-tabstrip.js`) are their own modules beside `desktop/main.js` ([desktop-build.md](architecture/desktop-build.md)); the other IPC handler groups, process lifecycle and voice wiring are still in `main.js`. Keep narrow injected interfaces, opaque file IDs, sender validation, sandboxing, context isolation, separate tab-strip origin and restricted native capabilities.

Replace unconditional `desktop/.npmrc` ARM64 installation assumptions with runner-aware settings. Retain a single IPC contract source and verify any emitted CommonJS/preload code and runtime resources. Real Electron security/lifecycle and installed-target checks remain the gate; source-text tests alone do not establish behavior.

## 9. Starting instruction

Use the following as the starting instruction for a session on `4.1-development`, with this file attached:

> Implement `docs/IMPLEMENTATION-PLAN.md` on `4.1-development` in small, reviewable increments. Plugins and SDK work are out of scope. Add no authored code comments or inline suppressions, in workflow and configuration files included. Read section 0 for the decisions already made and do not reopen them. Continue milestone 0 from where the branch is: check which of its eight items have landed, then complete the rest in order: layer/exception baselines, strict TypeScript, lint and test discovery, the section 4 CI policy, the invariant ledger, the performance record. Preserve existing fixes, user data, file/wire/IPC compatibility and distribution behavior. Do not redistribute complex editor events before the command/session boundary exists. Deliver verified tooling and baseline evidence as focused PRs, then proceed in the stated milestone order. Report actual checks, skips, removed coupling and remaining blockers. Do not deploy or publish as part of this work.

The first deliverable is working verification and an accurate baseline, not an empty folder scaffold or a renamed `21-events.js`.

## 10. Reference constraints

These documents support tooling/security constraints; actual implementation gates still run on the repository's declared runtime/platform versions:

- [Node.js native TypeScript execution](https://nodejs.org/api/typescript.html): erasable syntax, explicit type imports/extensions, separate type checking and no runtime interpretation of `tsconfig.json`.
- [TypeScript `erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html): compiler enforcement of the selected syntax subset.
- [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use): privilege and isolation considerations for self-hosted workflow execution.
