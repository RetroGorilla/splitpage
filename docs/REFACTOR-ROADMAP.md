# Splitpage 4.0 refactor roadmap (draft)

Goal: code that is easy to change in one place without re-testing or
rewriting the sections that depend on it, and that several agents can work
on at once without touching the same files. No plugin system, no SDK.

Replaces the milestone list in the September 2026 architecture plan. The
target layering from that plan stands: pure core → application → feature
views, adapters at the edges. The plugin host, SDK packages and isolated
runtime are dropped. The two registries that would have served plugins
(actions, export formats) stay because they serve the goal directly: adding
a menu action or an export format becomes one module plus one registration.

## Release and branch

Ships as **4.0** from `4.0-development`, following the `3.1-development`
convention. `main` (3.1.x fixes) is merged in at least weekly. PRs are
small, one lane each. A 3.1.x fix touching code already moved is ported
into its new home when merged forward.

A major version does not license format, wire or IPC changes. 3.1 files,
servers and desktop builds interoperate with 4.0.

Release gate: every 3.1 browser suite green on Linux and Windows,
unit/desktop/server tests green, real Electron smoke, both Docker paths,
x64 and ARM64 installers, dependency counts not above their milestone-0
values, no comments in authored code.

## What "easy to work with" means, measurably

- **One owner per concern.** A document edit happens in one place
  (`src/application`). A feature's DOM, listeners, local state and styles
  live in `src/features/<feature>/`. Storage, network and native calls live
  in `src/adapters/`. Nothing else touches them.
- **Disjoint lanes.** Two features changed in parallel touch disjoint files
  apart from one registration line each. Checked by hand at review; the
  dependency report makes it visible.
- **Change without re-testing neighbours.** A feature's tests run without
  booting the whole app: core tests need no DOM, application tests use
  fakes for storage/network, feature tests mount one feature.
- **No hidden order.** Boot is one composition file with named steps, not
  70 `__init()` calls in filename order.

## Rules that hold throughout

- No comments in authored code (`src/`, `server/`, `desktop/`, `shared/`,
  `tools/`, tests). Exceptions, listed in the checker's config: shebangs,
  the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}`, the one
  `eslint-disable` in `build.mjs` until replaced by config, YAML workflow
  files.
- `HANDOFF.md` §5 stays the invariants list. Contract notes for a moved
  area go in `docs/architecture/<area>.md`, one short page per area.
- New folders (`src/core`, `src/application`, `src/adapters`,
  `src/features`, `src/bootstrap`) are TypeScript with erasable-only syntax
  (no enums, no parameter properties), so `node --test` runs their tests
  directly on Node 22.18+ and 24; `tsc --noEmit` with `strict` and
  `noUncheckedIndexedAccess` checks them; esbuild already bundles `.ts`.
  Legacy `src/js` stays JavaScript until a slice moves it.
- New folders: zero import cycles; `core` imports no DOM, storage or
  network. Legacy `src/js` keeps counted baselines (63-module cycle, 57
  `_state` importers, 9 direct `S.state` writers) that may shrink and may
  not grow. Zero cycles across all legacy code is not a goal.
- A read, render, preview or export never changes the document.
- Existing regressions (`publish-in-flight`, suites 249, 261, 262,
  260–266) stay green through every milestone.
- A PR states: the coupling removed, the new owner of any moved state,
  the tests proving behaviour unchanged, and what was not run.

## Milestones

### 0. Baseline and tooling — 2 lanes

- Promote `.claude/handoff/direction-b/run-all-suites.mjs` to
  `tools/run-suites.mjs`; document in `SKILL.md` and `CONTRIBUTING.md`.
  Suites found by full filename (numeric prefixes repeat).
- `tools/dep-report.mjs`: import graph, cycle size, `_state` importers,
  direct document writers, files-per-feature. Writes `tools/dep-baseline.json`;
  `npm run check:deps` fails when a count grows.
- `tools/no-comments.mjs`, parser-based, config-driven exceptions.
- `tsconfig.json` scoped to new folders; `npm run typecheck`.
- Audit `HANDOFF.md` §5: each invariant marked tested (which test) or
  untested. Untested ones that milestones 1–5 touch get tests in 1.
- Clean locked install and `test:all` on Node 22 and 24, recorded.

Stop here: full browser runs off Windows; a number that says whether
coupling got worse.

### 1. Pin behaviour; take the wiring out of `21-events.js` — 3–4 lanes

- Tests for what milestones 2–5 move: scene length, cell edit, save status
  per destination, export of a captured document. Fake clocks, no sleeps.
- `src/application/actions.ts`: typed action ids, label, availability,
  handler. Menus, buttons, command menu and shortcuts read it.
- Each feature registers its own listeners and actions from its own
  module. Lanes split by feature; `21-events.js` shrinks per PR, deleted at
  the end.

Stop here: the most-edited file (76 commits last month) is gone; agents
stop colliding in it.

### 2. Pure core — 2 lanes

- `src/core/document`: field policies (`STATE_FIELDS` without UI
  callbacks), markers, status and id rules, `migrateRows`.
- `src/core/text`: run operations from `04c-doc-model.js` without the
  sanitizer import; projections, steps, split/join.
- `src/core/merge`: `mergeStates` and conflicts from `03-sync.js`, without
  history UI or preferences.
- `src/adapters/richtext`: `fromHtml`/`toHtml`, sanitizer, legacy media
  cards. Blob interning is an explicit step callers opt into.

Stop here: document rules and merge run in Node with no DOM; nothing in
them leads back to the UI.

### 3. Session and commands — 1 lane, then 2

- `DocumentSession`: document, epoch, edit generation, undo. Opening or
  replacing a document is a new epoch even with the same document id.
- Command dispatcher: capability check, one transaction, one generation
  bump, one undo entry, one published change set. Existing `diffStates`
  undo sits behind it unchanged.
- First: `setSceneLength`. Views subscribe to change sets; autosave, stats,
  production and b-roll refresh observe commits instead of being called
  from the handler. Then scene status, `editCell`, insert/delete scenes,
  rename tag.

Stop here: migrated edits happen in one place; a new command is one
function plus subscribers.

### 4. Export snapshot and format registry — 2 lanes

- `ExportDocument` built from one captured snapshot; writers (`15-docx`,
  `16-csv`, `16b-xlsx`, `17-pdf`, `20d-formats`) take it and never read
  `S.state` or a connection.
- `src/application/formats.ts`: exporters by id, label, options, supported
  content; the export dialog and file menu read it.
- Deterministic-bytes fixtures unchanged.

Stop here: a new export format is one module plus one registration.

### 5. Save coordinator — 2 lanes

- Per-destination confirmed generation; operation context (epoch,
  destination, generation, connection) captured before the first `await`;
  completion applies only when it still matches.
- Open, restore, new and publish-adopt through one session transition.
  Collaboration actions from `13b-collaborate.js` behind an application
  interface; the modal keeps its stale-check guards.
- `20g-drafts.js` split into capture scheduling, store adapters
  (`03d-drafts-idb.js` stays), ownership policy, restore workflow.
- Race matrix: same-id reopen, connection switch mid-upload, edits during
  serialization, out-of-order completions, revoked-link recovery.

Stop here: every save path shares one ownership check instead of five.

### 6. Features own their views; remaining edits become commands — 3–4 lanes

- `render()` stops repairing the tag registry and scheduling b-roll work;
  reconciliation is an explicit command step.
- `src/features/<feature>/` with mount/dispose per feature; overlay
  manager for modals and focus.
- Remaining editing paths (`05b-cell-edit`, clipboard, rows, find/replace,
  tags, b-roll, comments, writer) move to commands. Lanes by feature.
- CSS split by tokens/base/layout/components/feature, fixed aggregation
  order; no cascade layers until screenshots match.

Stop here: views cannot mutate the document; each feature is one folder.

### 7. Server factory — 1–2 lanes

- `createServer(deps, config)` out of `server/server.js`; the entry point
  listens. Routes, authorization by operation and document scope, link
  grant repository, document repository, blob service as modules.
- Commit-or-rollback contract for mint/replace/revoke on disk failure.
- Both Dockerfiles, `deploy.sh`, `package.mjs`, `desktop/stage.mjs` and CI
  artifact paths updated in the same PRs.

### 8. Desktop composition — 2 lanes

- Tabs/session service and file service out of `desktop/main.js` first,
  then IPC registration, hosting, voice, Drive, updates.
- Real Electron smoke stays the gate. `desktop/.npmrc` `arch=arm64`
  becomes runner-aware.

### 9. Bootstrap and retire bridges

- `src/bootstrap/`: one composition file with named steps and teardown
  replaces `_entry.js` ordering.
- Remove compatibility adapters, `S` where nothing reads it, source-text
  tests replaced by behavioural ones.
- Dependency baseline reaches zero in completed areas.

Milestones 0–6 are 4.0. 7–9 land in 4.x as those areas next need changing,
unless 4.0 has slack.

## Decisions needed before milestone 0

1. TypeScript for new folders (recommended) or JavaScript with JSDoc types
   checked by `tsc --checkJs`.
2. CI: keep main-only, or pay for per-PR checks on the private repo.
