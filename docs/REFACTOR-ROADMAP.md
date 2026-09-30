# Splitpage refactor roadmap (draft)

Replaces the milestone list in the September 2026 architecture plan. The
target architecture from that plan stands (pure core → application → views,
adapters at the edges, plugins through a versioned contract). This file
changes the order, the size of each step, and who does the work.

The refactor ships as **4.0**. The branch is `4.0-development`, following
the `3.1-development` convention; `main` (3.1.x fixes) is merged into it at
least weekly so it never drifts far. PRs into it are small and per
milestone lane. A 3.1.x bug fix that touches code already moved is ported
into the new home when merged forward.

How the work happens: one maintainer, AI agents in parallel worktrees.

## What 4.0 contains

| In 4.0 | Milestones |
| --- | --- |
| Tooling, wiring, core, session/commands, export registry | 0–4 |
| Plugin preview (trusted authors), marked experimental in Help | 5 |
| Save coordinator | 6 |

Milestones 7–10 land in 4.x point releases as the areas they cover next
need changing. SDK v1 (milestone 11) is 4.x or 5.0, decided once real
plugins exist.

A major version does not license format, wire or IPC changes. 3.1 files,
servers and desktop builds must interoperate with 4.0. Plugin package and
settings storage are new and versioned from the start.

Release gate for 4.0: every 3.1 browser suite green on Linux and Windows,
unit/desktop/server tests green, real Electron smoke, both Docker paths,
x64 and ARM64 installers, dependency baseline not above its milestone-0
value in any count, no comments in authored code.

Each milestone says what is better if the project stops right after it.

## Rules that hold throughout

- No comments in authored code (`src/`, `server/`, `desktop/`, `shared/`,
  `tools/`, tests). Exceptions, listed in the checker's config: shebangs,
  the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}`, the one
  `eslint-disable` in `build.mjs` until it is replaced by config, and YAML
  workflow files (their comments are operating notes; leave them).
- `HANDOFF.md` §5 is the invariants list. Do not start a second one.
  Contract notes for a moved module go into `docs/DOCUMENT-MODEL.md` or a
  new `docs/architecture/<area>.md`, one page per area.
- New folders (`src/core`, `src/application`, `src/adapters`,
  `src/features`, `src/extensions`, `packages/`) are TypeScript with only
  erasable syntax (no enums, no parameter properties), so `node --test`
  runs their tests directly on Node 22.18+ and 24 without a build step;
  `tsc --noEmit` with `strict` and `noUncheckedIndexedAccess` checks them.
  esbuild already bundles `.ts`. Legacy `src/js` stays JavaScript until a
  slice moves it.
- New folders have zero import cycles and no DOM or platform imports in
  `core`. Legacy `src/js` keeps a counted baseline (63-module cycle, 57
  `_state` importers, 9 direct `S.state` writers) that may shrink and may
  not grow. Zero cycles across all of `src/js` is not a goal.
- No format, wire, or IPC schema changes. Existing regressions
  (`publish-in-flight`, suites 249, 261, 262, 260–266) stay green.
- A PR states: the coupling it removed, the owner of the state it moved,
  the tests that prove behaviour is unchanged, and what was not run.

## Milestones

### 0. Baseline and tooling — 2 lanes, 3–4 PRs

- Promote the Linux browser-suite runner
  (`.claude/handoff/direction-b/run-all-suites.mjs`) to `tools/run-suites.mjs`
  with the driver; document it in `SKILL.md` and `CONTRIBUTING.md`. Suite
  lookup by full filename (numeric prefixes repeat).
- `tools/dep-report.mjs`: import graph, cycle size, `_state` importers,
  direct document writers. Writes `tools/dep-baseline.json`; CI-free check
  script fails when a number grows.
- `tools/no-comments.mjs`: parser-based (acorn is already under esbuild's
  tree; if not, add it as a devDependency), config-driven exceptions above.
- `tsconfig.json` scoped to the new folders; `npm run typecheck`.
- Audit `HANDOFF.md` §5: a table marking each invariant tested (which
  test) or untested. Untested ones that milestones 2–4 touch get a test in
  milestone 1.
- Clean locked install and `test:all` on Node 22 and 24, recorded.

Stop here: repeatable full browser runs off Windows, a number that says
whether coupling got worse.

### 1. Pin behaviour, and take the wiring out of `21-events.js` — 3–4 lanes

- Tests only for what milestones 2–4 move: scene length, cell edit, save
  status per destination, export of a captured document. Fake clocks, no
  sleeps. No new product behaviour.
- Action registry (`src/application/actions.ts`): typed action ids, label,
  availability, handler. Menus, buttons, command menu and shortcuts read it.
- Each feature registers its own DOM listeners and actions from its own
  module. Lanes split by feature; `21-events.js` shrinks per PR and is
  deleted at the end.

Stop here: the most-edited file in the repo (76 commits last month) is
gone, parallel agents stop colliding in it, and the tests that guard the
next three milestones exist.

### 2. Pure core — 2 lanes

- `src/core/document`: field policies (`STATE_FIELDS` without UI
  callbacks), markers, status and id rules, `migrateRows`.
- `src/core/text`: run operations from `04c-doc-model.js` without the
  sanitizer import; projections, steps, split/join.
- `src/core/merge`: `mergeStates` and conflict results from `03-sync.js`,
  without history UI or preferences.
- `src/adapters/richtext`: `fromHtml`/`toHtml`, sanitizer, legacy media
  cards. Blob interning becomes an explicit step callers opt into.
- Legacy modules import from core; core imports nothing from `src/js`.

Stop here: document rules and merge run in Node with no DOM, and no
import from them leads back into the UI.

### 3. Session and commands — 1 lane, then 2

- `DocumentSession`: document, epoch, edit generation, undo. Opening or
  replacing a document is a new epoch even with the same document id.
- Command dispatcher: capability check, one transaction, one generation
  bump, one undo entry, one published change set. Existing `diffStates`
  undo sits behind it unchanged.
- First command: `setSceneLength`. Views subscribe to change sets; autosave,
  stats, production and b-roll refresh observe commits instead of being
  called from the handler.
- Then: scene status, `editCell`, insert/delete scenes, rename tag.

Stop here: a plugin can invoke real document commands and the app has one
place where document edits happen for the migrated commands.

### 4. Export snapshot and format registry — 2 lanes

- `ExportDocument` built from one captured session snapshot; writers
  (`15-docx`, `16-csv`, `16b-xlsx`, `17-pdf`, `20d-formats`) take it and
  never read `S.state` or a connection.
- `src/application/formats.ts`: registry of exporters with id, label,
  options, supported content; `18c-export-dialog` and the file menu read
  it instead of branching.
- Existing deterministic-bytes fixtures unchanged.

Stop here: adding an export format is one module plus one registration.

### 5. Plugin preview, trusted — 2 lanes, gated by a spike

Decision needed first: who plugins must be protected from. This milestone
assumes plugins are written by the maintainer and people they trust:
isolated for stability (a hung plugin cannot hang the editor), not against
a hostile author. A hostile-author sandbox is a later, separate decision.

- Spike (1 PR, throwaway): where plugin code runs in each mode — hosted,
  hosted offline, `file://`, desktop. Facts to work from: `worker-src
  'self'` rules out blob workers; a worker fetched as its own file
  (`plugin-host.js` beside `sw.js`) has its own CSP, so it can load plugin
  source; `file://` cannot start workers in Chromium, so that mode likely
  gets "plugins unavailable". Report per mode: works / degraded / no.
- `packages/plugin-api`: manifest schema, DTOs for document projection,
  command invocation, diagnostics, exporter result; API version.
- `src/extensions/host`: registries for commands, checks, exporters; grants
  by plugin id and version; activation scoped to app, subscriptions scoped
  to session epoch; results carrying epoch and generation, rejected when
  stale; deadlines and termination.
- `src/adapters/plugins`: worker runtime, local package install from a
  file, enable/disable/remove, per-plugin settings in IndexedDB / desktop
  app data.
- Two built-in providers rewritten against the contract: one exporter, one
  document check. Two example packages using only the SDK.

Stop here: a plugin adds a command, a check or an exporter without a
rebuild, on the modes the spike said yes to.

### 6. Persistence completion — 2 lanes

- Save coordinator: per-destination confirmed generation; operation
  context (epoch, destination, generation, connection) captured before the
  first `await`; completion applies only when it still matches.
- Route open, restore, new and publish-adopt through one session
  transition. Move collaboration actions from `13b-collaborate.js` behind
  an application interface; modal keeps its stale-check guards.
- Split `20g-drafts.js` into capture scheduling, store adapters
  (`03d-drafts-idb.js` stays), ownership policy, restore workflow.
- Race matrix from the plan's §5: same-id reopen, connection switch
  mid-upload, edits during serialization, out-of-order completions, revoked
  link recovery.

Stop here: every save path shares one ownership check instead of five
local ones.

### 7. Views, render purity, remaining edits — 3–4 lanes

- `render()` stops repairing the tag registry and scheduling b-roll work;
  reconciliation is an explicit command step.
- Mount/dispose per feature; overlay manager for modals and focus.
- Remaining editing paths (`05b-cell-edit`, clipboard, rows, find/replace,
  tags, b-roll, comments, writer) move to commands.
- CSS split by tokens/base/layout/components/features with a fixed
  aggregation order; no cascade layers until screenshots match.

Stop here: views cannot mutate the document; disposing a tab leaks nothing.

### 8. Server factory — 1–2 lanes

- `createServer(deps, config)` out of `server/server.js`; entry point
  listens. Routes, authorization by operation and document scope, link
  grant repository, document repository, blob service as modules.
- Commit-or-rollback contract for mint/replace/revoke when disk fails,
  with injected failures.
- Both Dockerfiles, `deploy.sh`, `package.mjs`, `desktop/stage.mjs` and
  CI artifact paths updated in the same PRs.

### 9. Desktop composition — 2 lanes

- Tabs/session service and file service out of `desktop/main.js` first,
  then IPC registration, hosting, voice, Drive, updates.
- Real Electron smoke stays the gate. `desktop/.npmrc` `arch=arm64` becomes
  runner-aware.

### 10. Retire bridges

- Remove `_entry.js` ordering, compatibility adapters, `S` where nothing
  reads it, source-text tests replaced by behavioural ones.
- Dependency baseline reaches zero for completed areas.

### 11. SDK v1

- Reference, package guide, support matrix, scaffold, validator. A plugin
  built against the preview SDK runs on the v1 host. Only after milestone
  5's runtime has been used for real plugins.

## Decisions needed before milestone 0

1. Plugin trust model: trusted authors (milestone 5 as written) or
   untrusted (adds a sandbox spike: QuickJS-in-WASM vs a sandboxed
   cross-origin iframe; adds weeks).
2. TypeScript for new folders (recommended above) or JavaScript with JSDoc
   checked by `tsc --checkJs`.
3. CI spend: keep main-only CI and rely on local/agent runs, or pay for
   per-PR checks and required status checks on the private repo.
4. Confirm the 4.0 contents table above: is the plugin preview required for
   4.0, or is 4.0 the refactor alone with plugins in 4.1?
