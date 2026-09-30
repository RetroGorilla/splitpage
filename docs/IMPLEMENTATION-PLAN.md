# Splitpage 4.0 — implementation plan

**Objective:** Make ordinary changes local, understandable and independently testable. Give each document operation, feature and platform resource an explicit owner. Preserve the app's current behavior and distribution model.

**Scope decision:** Plugins, a plugin SDK, a plugin host and an isolated extension runtime are out of scope. Internal action and format registries remain because they simplify application development.

**Authority:** This is the plan for 4.0. It supersedes the September 2026 architecture plan and the interim roadmap; their compatible product invariants are preserved, and this document controls sequencing, scope and acceptance. It lives on `4.0-development` and is amended there by PR when a decision changes.

**Source baseline:** Version 3.1.0, `main` at `80500f6ef6b8f32b68a22c95210dcb962a989fc3`. Recheck the implementation branch before editing. This is a plan, not a claim that the refactor is implemented.

## 0. Decisions

| Decision | Outcome |
| --- | --- |
| Release | 4.0, from `4.0-development` (created from `main`); `main` merged in at least weekly |
| Plugins, SDK, extension runtime | Out of scope |
| Language for new folders | TypeScript, strict, erasable syntax only (section 3) |
| Comments | None in authored code; workflow and configuration files may carry a comment that records a constraint, never narration (section 2) |
| CI | Fast gates on hosted runners for PRs and the development branch; the full browser regression, Electron smoke and Windows x64/ARM64 checks run locally at milestone and release gates (section 4) |
| ARM64 | A Windows ARM64 device is available; runtime checks run on it and the release row stands as written |
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

**4.0 scope:** Milestones 0–7 below: verification tools, core extraction, session/commands, saving/recovery, formats, feature ownership, and explicit frontend bootstrap/teardown. Unmodified server and desktop internals may remain legacy behind narrow adapters.

**4.x follow-up:** Server and desktop service extraction in section 8. Their existing functional, security and packaging checks remain release requirements even when their internal refactors are deferred. Describe remaining legacy debt honestly; do not declare the entire repository fully refactored at 4.0.

No UI framework replacement, editor-engine replacement, persisted document schema migration, collaboration algorithm replacement or new user feature is included. Keep 3.1 file/HTTP/IPC compatibility. Distinguish intentional distribution-version changes from file-format changes.

## 2. Working agreement

### Branches and small changes

1. Read applicable repository instructions, `docs/help.md`, `HANDOFF.md` section 5, build/packaging scripts and tests for the area being changed. Resolve stale prose against executable source and fixtures.
2. Use the existing `4.0-development` branch, or create it from current `main` if absent. Preserve unrelated working changes; use a clean worktree where necessary.
3. Keep PRs focused on one ownership boundary. Separate a demonstrated behavioral repair from a broad extraction. Keep the application runnable after each PR.
4. Merge current 3.1.x fixes forward at least weekly and immediately when relevant to the next slice. Port fixes into the new owner; do not restore deleted implementations or maintain two competing paths. Run impacted checks after every forward merge.
5. Continue through milestones after their gates pass. Do not pause for routine naming, file placement or reversible implementation decisions. Record substantive behavior/compatibility uncertainties before dependent changes.
6. Do not deploy to the live service, overwrite user data, publish releases or merge into `main` as an incidental verification step.

### Ownership of shared work

Independent features can be developed separately once their application interfaces are defined. One integration owner controls shared schemas, session/command interfaces, action/format registration, bootstrap, package manifests/lockfiles, CI and baseline changes. Feature work contributes registrations through that owner rather than racing to edit central files.

Do not split a foundational interface across multiple simultaneous implementations. Finish the first working vertical slice before multiplying feature migrations. Each PR names its owned files and dependencies. Parallelism is optional; correctness of the merged result is the gate.

### No comments in authored code

Add no inline, block, documentation, TODO/FIXME or lint/type suppression comments to authored code, tests, CSS, HTML or scripts. Write contracts and rationale in `docs/architecture/`, `docs/decisions/`, types, names and tests.

Workflow and configuration files (`.github/workflows/*.yml`, `eslint.config.mjs`, `tsconfig*.json`, `docker-compose.yml`, `Dockerfile*`) are the one exception. A comment there is allowed only where it records a constraint a reader cannot recover from the file itself or from the docs: why a flag exists, what breaks without it, which external behavior forced it. A comment that restates what the next line does, or explains something already documented, is removed in review. When in doubt, put it in `docs/` and leave the file bare.

A parser-aware check must distinguish actual comments from URLs, regexes and strings. Preserve interpreter directives and exact required build-template markers through file-specific configuration. Move the two `build.mjs` lint suppressions, and the other inline `eslint-disable` directives across the repository (sixteen at the baseline), into narrowly scoped configuration as their files are touched; milestone 0 handles `build.mjs`. Do not introduce broad exclusions for new folders. Existing unmigrated comments have an exact, frozen baseline; no new comments are allowed, and migrated areas have none. Preserve attribution in LICENSE/NOTICE and third-party metadata; generated/vendor content is outside the authored-source check.

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

**Hosted, on every PR targeting `main` or `4.0-development` and every push to `4.0-development`:** the fast gates. Lint, types, the comment/layer/dependency gates, every discovered unit/application/adapter/tool test, the build, and the selected browser smoke/CSP/persistence suites already in `ci.yml`. Linux runners only. A documentation-only PR completes the required check through a cheap gate rather than staying pending behind path filters. Workflow path filters include new folders and every actual build input.

**Local, at milestone and release gates:** the full browser regression on Linux (`tools/run-suites.mjs`) and on Windows (`run-tests.ps1`), real Electron smoke, and the Windows x64 and ARM64 packaged checks on the maintainer's x64 and ARM64 devices. Run impacted suites locally during feature PRs. A milestone is declared complete, and a release cut, only with the recorded output of those runs (`summary.txt`, the smoke log, the platform check logs) attached to the closing PR. A scheduled hosted full run is optional and does not replace the local gate.

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

### 4 — Centralize save completion, session transitions and recovery

**Source:** `_home.js`, `02b-doc-id.js`, `13-hosted.js`, `13b-collaborate.js`, `14-export.js`, `18-local-files.js`, `20g-drafts.js`, `03d-drafts-idb.js` and Drive/native save paths.

**Work:** Use per-destination confirmed generations and baselines. Capture document snapshot and operation context before serialization, blob transfer or any other await: session epoch/document ID, destination identity/generation, edit generation, connection instance, authority/scope generation and server revision.

Serialize/coalesce writes per destination. The transport instance owns all requests for an operation, including blob transfer and the subsequent write. Completion acknowledges only the accepted snapshot. It may update live state only if ownership still matches; an already-landed obsolete write is reported without adopting it into another session.

Route open/new/restore/publish adoption through one transition API. Preserve identity/fork rules. Hosted Save As remains a separate copy and cannot acknowledge server edits or change its merge ancestor. Import writeback acknowledges only its own destination/bytes. Failure/cancellation never silently retargets Save.

Move collaboration workflows behind application interfaces; retain modal stale-completion checks. Model owner versus scoped document editor/reviewer authority explicitly and preserve server enforcement.

Split recovery capture scheduling, store adapters, writer ownership and restore/adoption policy. Keep the existing injected IndexedDB draft store. Preserve browser hosted-edit scope, limits, credential-free keys/records, review exclusion and desktop recovery behavior. Define live-tab takeover with/without Web Locks. Permission loss preserves recoverable edits as an unsaved local copy and never authorizes a server write. Discard only the acknowledged draft generation owned by that writer.

**Gate:** Controlled race matrix passes for document switch, same-ID reopen, changed destination/connection during serialization/upload, edits during writes, out-of-order completions, cancelled dialogs, permission revocation, 409 retries and write failure. Assert actual stored bytes, live document, dirty state, baseline and destination. Browser/desktop recovery tests cover multi-tab ownership, quota/unavailable/corrupt storage, offline images, restart and revoked links. Existing five repaired defects stay fixed.

### 5 — Make formats consume captured data and one registry

**Source:** `14b-export-kit.js`, `15-docx.js`, `16-csv.js`, `16b-xlsx.js`, `17-pdf.js`, `20d-formats.js`, import readers and export menus/dialogs.

**Work:** Build one frozen `ExportDocument` projection from the originating session and options. Capture relevant timing/date/selection data and image availability; asynchronous asset resolution uses the captured context. Writers never read `S.state`, live UI controls or whichever connection happens to be current.

Use a format registry declaring stable ID, label, supported operations/content, options, accepted input and outcome. Make dialogs/menus consume it. Keep per-format content limits/warnings and existing codec/layout implementations unless a demonstrated defect justifies replacing them. Do not introduce a universal layout framework.

Keep import decoding/sanitization separate from transaction adoption and writeback ownership. Exporting bytes alone does not acknowledge a project/server save; the save coordinator determines that meaning.

**Gate:** Adding a small test exporter requires one provider and registration, with no edits to event routing or save coordination. Deterministic byte fixtures, Unicode/images/styles/comments/b-roll, project round trips and the human Markdown half remain stable. Verify representative output through independent readers/viewers. Rendering/exporting a captured document leaves live content unchanged.

### 6 — Finish feature ownership and editing migration

**Source:** Remaining editor/clipboard/rows/selection/find/tag/b-roll/comment/writer paths, `05-render.js`, `21-events.js`, panels, settings/gallery/prompter views, CSS and page shell.

**Work:** Migrate one feature at a time through the proven commands/selectors/ports. Each feature owns bindings, local state, styles and mount/dispose. Move remaining document writes into application transactions. Keep presenter/voice/native resources in adapters while their view uses narrow application interfaces.

Remove render-time tag repair and document work; ingestion/transactions enforce invariants. Use precise changed inputs for cached derivations. Add overlay/focus ownership preserving panel closure/restoration, stacking, Escape/Tab, Writer/Present behavior and pending composers.

Split CSS into tokens/base/layout/components/features with deterministic aggregation. Preserve template ordering, sanitization and CSP. Do not introduce cascade layers or virtualization without equivalence/performance evidence. Preserve caret/selection and composition instead of rebuilding editable DOM indiscriminately.

Finish complex event handling only when the receiving owner exists, preserving priority among tag controls, modifier clicks, selection completion and drag types. Delete `21-events.js` when its real responsibilities have moved and tests pass, not by relocating it into another catch-all module.

**Gate:** Migrated features contain no global state access, concrete platform services or direct live-document mutation. Remount/dispose tests find no duplicate handlers, owned timers, observers, subscriptions or object-URL leaks. Real-browser typing/IME/cut-paste/split-join/anchors/undo, focus, responsive/reduced-motion and representative visual checks pass. Independent feature changes do not require edits to unrelated feature internals.

**Safe separate work:** Different feature folders after public interfaces are stable. Shared action registration, application policies, CSS tokens/ordering and overlay rules stay with the integration owner.

### 7 — Complete frontend bootstrap, retire bridges and verify 4.0

**Work:** Build an explicit composition root with named construction, registration and cleanup. Wire ports/services before mounting consumers. Preserve `PAGE_SHELL` capture before document DOM mutation, initial seed/identity ordering and build-time CSP hashes.

Switch the build entry from `src/js/_entry.js` to the new root when ready. Remove replaced adapters, duplicate implementations and unused `S` fields. Any necessary untouched-legacy initializer list lives in a named, documented shim with its remaining owners; new features never depend on numbered load order. Migrated application/feature code cannot depend on that shim.

Keep generated `index.html` untracked, inlined/self-contained output, authoritative `VERSION`, the tracked worker stamp and supported offline/upgrade behavior. Scope cache cleanup to app-owned caches. Update both Docker recipes, portable staging, desktop staging/protocol allowlists, verification scripts and CI artifacts whenever runtime paths change. Test packages without a nearby checkout; some consumers still list individual server/shared files.

**Gate:** Completed frontend areas have enforced acyclic dependencies, strict types, no authored comments and one document-mutation boundary. Named startup dependencies and teardown are tested for both app lifetime and document/tab replacement. Remaining legacy exceptions are exact and visible. Pass section 7's release matrix before declaring 4.0 ready.

## 6. Required ownership/race invariants

These are architectural contracts, not optional tests or comments to add to source:

- Document identity, session epoch, local edit generation, destination generation and server revision have different meanings.
- Every accepted user transaction includes its dependent anchor/record reconciliation; no-op and rejected operations produce no edit side effects.
- A view or selector never changes document content; document snapshots passed outside the owner cannot be written back by reference.
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
- Source/format fixtures stay stable; performance/visual comparisons use documented runtime/font conditions. Any material change is explained and verified.
- Architecture ownership map, invariant ledger, testing instructions and remaining legacy work accurately describe the delivered source.

### Every PR records

Provide the concrete behavior preserved/fixed, ownership before/after, removed coupling and bridge changes, tests actually executed, failures/skips, compatibility/packaging/security effects and updated invariant rows. Include a short old-module → new-owner mapping. No bare “all tests pass” when platform checks were omitted.

Keep expected operational failures and missing execution environments visible. Continue unaffected work when a platform is unavailable, but do not bypass dependent milestone/release gates or claim those checks passed. Avoid repeat full test runs without new changes or unresolved concerns; use focused verification during PR work and full runs at the defined gates.

## 8. Follow-up refactors for 4.x

### Server services

Extract `createServer(dependencies, config)` from process startup. Separate validated configuration, HTTP decoding, authorization by operation/document scope, document/comment services, grant/secret repository, blob budgets/reference rules, presence and durable filesystem storage.

Define and test memory/disk/restart consistency for mint/renew/revoke/delete under injected persistence failure. Preserve malformed-input responses, compare-and-set writes, per-document serialization, owner rotation, link revocation/restart behavior, tombstones and private permissions. Keep the documented public owner-key/capability-link deployment boundary and intentional LAN profiles explicit.

Update both Docker recipes, `deploy.sh`, portable/desktop staging and CI payload assertions in the same PR as module extraction. Backups include documents, blobs and link/owner-secret data. Code rollback preserves newer revocations; data restore has an explicit revocation/rotation procedure. Test configuration and deploy/rollback behavior against isolated fixtures, never the live server.

### Desktop services

Extract tabs/session registry and file service first, then IPC composition, hosting/process lifecycle, voice, Drive/credentials, protocol policies and updates. Keep narrow injected interfaces, opaque file IDs, sender validation, sandboxing, context isolation, separate tab-strip origin and restricted native capabilities.

Replace unconditional `desktop/.npmrc` ARM64 installation assumptions with runner-aware settings. Retain a single IPC contract source and verify any emitted CommonJS/preload code and runtime resources. Real Electron security/lifecycle and installed-target checks remain the gate; source-text tests alone do not establish behavior.

## 9. Starting instruction

Use the following as the starting instruction for a session on `4.0-development`, with this file attached:

> Implement `docs/IMPLEMENTATION-PLAN.md` on `4.0-development` in small, reviewable increments. Plugins and SDK work are out of scope. Add no authored code comments or inline suppressions; a workflow or configuration file may carry a comment only where section 2 allows it. Read section 0 for the decisions already made and do not reopen them. Continue milestone 0 from where the branch is: check which of its eight items have landed, then complete the rest in order: layer/exception baselines, strict TypeScript, lint and test discovery, the section 4 CI policy, the invariant ledger, the performance record. Preserve existing fixes, user data, file/wire/IPC compatibility and distribution behavior. Do not redistribute complex editor events before the command/session boundary exists. Deliver verified tooling and baseline evidence as focused PRs, then proceed in the stated milestone order. Report actual checks, skips, removed coupling and remaining blockers. Do not deploy or publish as part of this work.

The first deliverable is working verification and an accurate baseline, not an empty folder scaffold or a renamed `21-events.js`.

## 10. Reference constraints

These documents support tooling/security constraints; actual implementation gates still run on the repository's declared runtime/platform versions:

- [Node.js native TypeScript execution](https://nodejs.org/api/typescript.html): erasable syntax, explicit type imports/extensions, separate type checking and no runtime interpretation of `tsconfig.json`.
- [TypeScript `erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html): compiler enforcement of the selected syntax subset.
- [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use): privilege and isolation considerations for self-hosted workflow execution.
