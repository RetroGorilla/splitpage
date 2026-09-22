# Splitpage 3.0 roadmap

Decided 2026-09-22 from the two architecture reviews in `docs/reviews/`
(review A: `2026-09-22-architecture-review-A.md`, review B:
`2026-09-22-architecture-review-B.md`). Every claim used here was re-checked
against `main` at e6ff0dc. This file replaces the plan-file pointer in
HANDOFF.md §7/§8 as the place where sequencing and pending decisions live.

Every item below is a GitHub issue, a sub-issue of the tracking issue
**#56 Splitpage 3.0**, labelled `3.0` plus `phase:1` to `phase:5`. Progress
is read from #56; this file holds the reasoning.

## Where the reviews agree

Both reviews reach the same diagnosis: the code is careful line by line, but
three early decisions are now generating most of the cost.

1. One 24k-line closure built by concatenating 39 fragments. Nothing pure can
   be imported, so the merge, migration, doc-id and eviction code is only
   testable by booting a browser through `window.__*` backdoors.
2. No CI, and the Node test driver exits 0 when a check fails
   (`.claude/skills/run-splitpage-app/driver.mjs:659` only sets exit 1 on a
   thrown error).
3. Hosted collaboration has no pull channel. Nobody polls the document rev;
   a second editor's changes arrive only as a 409 on save.

They also agree on: esbuild bundling as the way to get modules while keeping
the single-file `index.html`; rev returned in the presence heartbeat as the
cheapest pull channel; images out of state into content-addressed blobs;
one shared policy module for history eviction instead of the byte-for-byte
copy in `desktop/main.js`; pruning distribution surfaces; pushing back on
issue #8 (local speech model); deciding tabs-vs-windows before issue #11.

## Where they differ, and the call

| Topic | Review A | Review B | Decision |
|---|---|---|---|
| First move | CI first | Field registry, updater trust, CSP first | Both. All are small and none conflict. CI is useless until the driver exits nonzero, so that fix is day one. |
| Structured document model (rows of runs, not HTML strings) | Plan it, do it last | Not raised | Agree with A: last, and only after modules and tests exist. Not scheduled. |
| Desktop history store | Shared policy module | Shared module, SQLite backend | Shared module, JSON index plus blobs. SQLite is a native dependency in a project already bitten by packaging three times. |
| Service worker | Stamp the cache name | Delete it | Stamp the version from `build.mjs`, network-first for `index.html`, stop caching `?doc=` URLs and `update-status.json`. Deleting it loses offline for the hosted URL. |
| Review role | Comments-only endpoint | Restrict review token reads | Both. The endpoint replaces the whole-state diff; the read restriction closes a separate hole. |

## Confirmed bugs to fix now

These are not architecture. Each is a one-PR fix.

- `var saveInFlight` is declared in both `src/js/12-dirty-toast.js:14` and
  `src/js/14-export.js:481`. The closure hoists them into one binding, so
  the Save button indicator and the autosave mutex share state. Rename one.
- `driver.mjs` exits 0 on FAIL. Set exit 1 when `failures > 0`.
- `mergePeople`, `mergeProductionTags`, `mergeBrollShots`
  (`src/js/03-sync.js:469` onward) union both sides with no base, so a deleted
  entry is resurrected by every merge. Pass `base` and apply the same
  "deleted and unchanged since base" rule the row merge already uses at `:299`.
- `reviewWriteAllowed` (`server/server.js:840`) deep-compares raw stored JSON
  against client-normalised state. A document saved before `brollShots`
  existed will refuse every reviewer comment with `403 review-only`.
- The review token can list and read every document
  (`server/server.js:1006`, `:1066` have no role check).
- Desktop updater: a missing `SHA256SUMS` asset lets the install proceed
  (`desktop/main.js:2824`). `update.mjs:97` trusts the `updateApi` URL from
  the previously downloaded manifest.
- No Content Security Policy anywhere in `src/page.html`, `build.mjs`, or
  `desktop/main.js`, while the renderer parses untrusted `.splitpage` and
  `.md` files.
- `HANDOFF.md` §7/§8 point at `C:\Users\Adam\.claude\plans\...`, which no
  clone can read.

## Phases

Each phase is independently shippable. Do not start phase 5 before phase 2
lands; the rest can overlap.

### Phase 1: close the real risks (about a week, all small PRs)

1. **#57, #58.** Fix `driver.mjs` exit code. Add a GitHub Actions job on ubuntu running
   `node build.mjs --check`, `desktop/test/drafts.test.mjs`,
   `tools/test-server.mjs`, `tools/test-update.mjs`, and browser suite 01
   under Playwright's Chromium. Retire `driver.ps1`.
2. **#59.** Rename the `saveInFlight` collision. Dedupe `SIDE_PANEL_IDS`,
   `HELP_SIDE_PANEL_IDS`, `SIDE_PANEL_WIDTH_DEFAULTS` into one list.
3. **#60.** Field registry: one list of top-level state fields that `migrateRows`,
   `mergeStates` and the exporters iterate. Turns invariant #4 into code.
4. **#61.** Base-aware list merges (`base` param on the three list merge functions).
5. **#64.** Updater trust: checksum mandatory, ignore the manifest's `updateApi`,
   reject `--tunnel` targets starting with `-`.
6. **#65.** CSP meta tag in `page.html`, and a `session.defaultSession` response
   header in Electron. Start with `default-src 'self'; img-src 'self' data:
   blob:` and widen only where a suite fails.
7. **#63.** Review token: add a role check to the list and get routes so a reviewer
   sees only the document their link names.
8. **#62.** Normalise both sides in `reviewWriteAllowed` so reviewer
   comments stop 403ing on older documents. Replaced outright in phase 3.
9. Move this roadmap pointer into HANDOFF.md (done).

### Phase 2: modules and unit tests (a few days of mechanical work)

**#66.** Convert the 39 fragments to ES modules bundled by esbuild
(`--bundle --format=iife --minify`) and inlined by `build.mjs` exactly as
today. One devDependency. The single-file artifact, `--check`, and
`PAGE_SHELL` all survive.

Review A estimates a day. With 818 top-level functions sharing one scope,
expect several days of import/export plumbing. It is mechanical but not
short. Do it as one PR with no behaviour change, verified by the browser
suites passing before and after.

**#67, #68.** Then unit-test `mergeStates`, `migrateRows`, the two file formats,
`parseMarkdownTable`, `deriveDocId` and `planHistoryEviction` directly under
`node --test`, and delete the 12 `window.__*` backdoors. Add ESLint.

### Phase 3: collaboration that matches the README (a few days)

1. **#69.** Return `{docId, rev}` in the `/api/presence` response. On mismatch the
   client GETs, runs `mergeStates(baseState, state, theirs)`, re-renders.
   No PUT. Roughly 30 lines.
2. **#70.** Raise hosted autosave idle from 2s to about 5s (`14-export.js:364`).
3. **#71.** `POST /api/docs/:id/comments` for the review role. Delete
   `reviewWriteAllowed`, `fieldSignature`, `htmlTokens` and the server-side
   HTML tokenizer.
4. **#72.** Extract the merge orchestration (snapshot, `lastMergeUndo`, `baseState`,
   autosave halt) that is copied across `saveToServer`, `resumeServerDoc`,
   `applyStashedWork` and `confirmFileMerge` into one function.
5. **#73.** Collapse `docFileHandle`, `openedFile`, `serverDoc` and their sibling
   globals into one tagged home record. `autoSaveTarget()` is already its
   shape. Issue #10 depends on this.
6. **#74.** PIN rate limiter: key on `X-Forwarded-For` when the server is told it is
   behind a proxy. Read the token before the body on `/api/presence`.

### Phase 4: desktop and distribution (ongoing, deletion-heavy)

1. **#75.** Delete the IExpress installer and the self-updating Node launcher. Keep
   portable zip, Electron NSIS, Docker, `start.mjs` with thin wrappers.
2. **#76.** Pull the pure policy out of `desktop/main.js` into shared modules
   consumed by both builds: `planHistoryEviction`, meta sanitise, duplicate
   doc-id claim rules. `drafts.js` is the pattern. Delete the desktop copy
   and the drift smoke test.
3. **#77.** One IPC channel table and one validator shared by both preloads and main.
4. **#78, decided: keep tabs.** Both reviews recommended one window per
   document; Adam chose to keep the tab strip as the daily interaction
   model. #76 and #77 reduce its cost without changing its shape. #11 builds
   on the tab machinery: one `home` record (#73) per tab in the desktop
   `source` records.
5. **#79.** Service worker: stamp the cache name from `VERSION` in `build.mjs`,
   network-first for `index.html`, never cache `?doc=` URLs or
   `update-status.json`.
6. **#80.** Stop committing `index.html`. Build it in CI and on release. Needs the
   CI from phase 1 and a release script change.
7. **#81, decided: no certificate.** Personal-use project, not worth paying
   for. The SmartScreen warning stays and the hand-rolled updater stays, so
   #64 is the updater's final state rather than a stopgap.
8. **#8, #86.** Voice on desktop: a small helper drives the Windows built-in
   recogniser behind the same interface Web Speech uses (#8), and the
   teleprompter gets an "Open in browser" option so Follow My Voice runs in
   Chrome on any platform (#86). No bundled model.

### Phase 5: the big ones, only after phases 1 to 3

1. **#82.** Images out of state: content-addressed blob map keyed by sha256. Files
   get a sidecar folder, the server gets `/api/blobs/<sha>`. Saves, 409
   payloads, snapshots and stashes stop carrying base64. The
   `imagesStripped` hack in `mergeRow` goes away.
2. **#83.** One history store module shared by browser and desktop. Desktop backend
   is a JSON index plus the blob folder from item 1. Delete the fsck.
3. **#84.** Keyed per-row rendering: one `renderRow(rowId)` primitive and a derived
   production index invalidated per mutation. Removes most of the 80
   `render()` call sites and the four keystroke timers that each re-derive
   `productionEntries()`. Makes issue #53 cheap.
4. **#85.** Structured document model (rows of text runs with marks referencing the
   registry by id). Fixes comment anchors, tag rename cost, merge
   granularity and the three undo systems at once. Decided: write the
   design after #66 and #67 land, build it last, after #82 to #84.

## Open issues

- **#8 Follow My Voice on desktop.** Decided: Windows built-in recogniser
  plus #86 "Open in browser". Unblocked, `phase:4`.
- **#10 Google Drive via loopback OAuth.** Right shape. Labelled `phase:4`;
  build after #73.
- **#11 Per-tab connections.** Unblocked by the tabs decision. `phase:4`,
  after #73.
- **#51, #52, #53 UI polish.** Low risk, do any time. #53 gets cheaper after
  #84.

## Decisions made (2026-09-22)

1. **Tabs stay** (#78, closed). Against both reviews' recommendation; the
   tab strip is how Adam works. #11 is unblocked.
2. **Voice on desktop** (#8): Windows built-in recogniser, plus #86 "Open in
   browser" on the teleprompter. No bundled model.
3. **No code-signing certificate** (#81, closed as not planned). Personal
   use does not justify the cost.
4. **Structured document model** (#85): design after phase 2, build last.

## What was not adopted

- SQLite for the desktop history store (review B). Native dependency, and
  the JSON-index-plus-blobs design gets the same simplification.
- Deleting the service worker outright (review B). Fixing the cache name is
  a smaller change that keeps hosted offline working.
- CRDTs or OT for collaboration. Neither review suggests it and the
  rev-in-presence pull is enough for a handful of people on coarse rows.
- One `BrowserWindow` per document (both reviews). Adam keeps tabs.
- Bundling a local speech model (issue #8's original pitch). Both reviews
  and Adam against it.
- `electron-updater`. Without a certificate it adds a dependency for no
  trust gain.
