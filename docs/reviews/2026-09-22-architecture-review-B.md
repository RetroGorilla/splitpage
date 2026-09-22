# Splitpage architecture review

Date: 2026-09-22. Reviewed at commit `e217a4c` (main after PR #54).

Sources: `HANDOFF.md`, `README.md`, `build.mjs`, the open GitHub issues, and full reads of `src/js/`, `desktop/`, `server/server.js`, `update.mjs`, `start.mjs`, `package.mjs`, `sw.js`. Every claim below was checked against the code.

## The verdict

The engineering inside each file is unusually careful. The problem is not code quality. It is that the project has grown into five products (browser app, desktop app, collaboration server, updater, installer) held together by prose rules instead of structure. The 51-item invariant list in the handoff is the tell: most of those invariants exist because a module boundary, a type, or a unit test does not.

## Structural problems, ranked by risk

1. **Silent data loss is one forgotten line away.** The three-way merge in `src/js/03-sync.js` ends in a hand-written object literal listing every top-level field (lines 458–474). A field missing there is destroyed on every merge. The handoff admits this already happened to `people` and `productionTags` (invariant 4). Fix: one field registry that both `migrateRows` and `mergeStates` iterate over.

2. **Nothing pure is unit-tested.** Zero unit tests exist over `src/js`, and `desktop/main.js` exports nothing. The merge, the document-id derivation, the eviction planner, and the diff engine are pure functions reachable only by booting a browser or Electron over the DevTools protocol (50 browser suites, a 4.5k-line Electron smoke test). Those are exactly the places data loss lives. The fragment-concatenation design causes this: a fragment is not valid JavaScript on its own, so nothing can import it.

3. **The single-closure pattern has produced a real bug.** `var saveInFlight` is declared twice in the same closure: `src/js/12-dirty-toast.js:14` for the Save button state and `src/js/14-export.js:481` as the autosave mutex. JavaScript hoists both into one binding, so the save indicator and the autosave lock share state by accident. Overlapping saves are serialised today only by clean-up ordering nobody designed. Related: three copies of the side-panel id list under different names (`SIDE_PANEL_IDS`, `HELP_SIDE_PANEL_IDS`, `SIDE_PANEL_WIDTH_DEFAULTS`), which is collision avoidance by renaming.

4. **Collaboration is turn-taking sold as live editing.** Hosted mode has no pull channel. Nothing in `src/js/13-hosted.js` polls the document. A second editor's changes arrive only when you save and get a 409, then land as conflict comments. The presence heartbeat (`13a-presence.js`) already fires every two seconds, so the fix is cheap: return the current `rev` in that response and prompt to reload.

5. **The updater can be permanently hijacked by one bad release.** `update.mjs:97–103` prefers the `updateApi` URL from the local `.splitpage-release.json`, which arrived with the last downloaded release. Files are verified against that same zip's own hash list, which detects corruption but not tampering. Installers are unsigned and the published SHA256 checksum is optional (`desktop/main.js` `fetchPublishedChecksum`). This is the only remote-code-execution-shaped risk in the repo. Fix: ignore the manifest's URL, require the checksum file, sign when budget allows.

6. **No Content Security Policy in the desktop app.** The Electron shell is otherwise the best-defended part of the codebase: context isolation, sandbox, origin-gated preload, navigation guards, zero-argument update calls, every IPC handler re-checking the sender frame. But the renderer parses untrusted `.splitpage` and `.md` files, and one HTML injection reaches the full file and history bridge. No CSP exists in `src/page.html`, `build.mjs`, or `desktop/main.js`. Cheapest high-value change in the project.

7. **The review link is a server-wide credential.** A review token can list and read every document (`server/server.js` list route around line 1006 and get route around 1066 have no role check). Revocation means restarting the process. Users are told it is a per-document share link. Also: `ALLOW_ORIGINS=null` matches any sandboxed iframe on any site, and the PIN rate limiter keys on socket address, so behind a tunnel or Cloudflare every client shares one bucket.

8. **Two version-history stores, mirrored by hand.** The browser keeps a 2,269-line IndexedDB store (`03a-history-store.js`). The desktop reimplements it over a folder tree with its own fsck and byte accounting (`desktop/main.js` roughly lines 1408–2350). `planHistoryEviction` is copied byte-for-byte between them, with a smoke test whose only job is detecting drift. Worst complexity-to-value ratio in the tree for "50 snapshots per document".

9. **Full re-render is the default mutation.** Add, delete, move, image, and split all rebuild `#rows` via innerHTML (`05-render.js:152`, 69 call sites). Caret restoration admits it can only land at end-of-cell. Invariant 7 says "repaint a row, don't re-render," but there is no row-level render primitive to make that the easy path.

10. **Images live inside document state as data URIs.** Every save clones the full state four or more times (`14-export.js:88,193,201`, draft stringify, snapshot stringify), so cost scales with images times copies. This is why `stashLocalWork` needs an image-stripping fallback, whose "absent or null" ambiguity then leaks into `mergeRow` (`03-sync.js:275–283`).

## Smaller items

- **Too many distribution surfaces.** Portable zip, an IExpress installer that `DEPLOY.md` already calls deprecated, the Electron NSIS installer, a service worker, Docker, and four launcher scripts. `start.ps1` is a third HTTP server implementation. Keep zip, Electron, Docker, and `start.mjs` with thin `.bat`/`.sh` wrappers. Delete the rest.
- **The service worker hurts more than it helps.** `sw.js` caches the 1.3 MB page under a frozen cache name, so every update serves the old app for one load. Offline already works from disk.
- **Generated 1.3 MB `index.html` is committed** and has churned 44 times since June. The pre-commit hook guarding it is not installed by default (no `core.hooksPath` set). There is no CI.
- **The roadmap lives on one Windows machine.** `HANDOFF.md` points at a plan file under a local user directory as the source of truth for status and pending decisions.
- **The tab strip costs ~1,400 lines of main-process plumbing** for 276 lines of chrome. The separate origin is the right security call. The separate `WebContentsView` is what makes it expensive.
- **49 string-literal IPC channels** validated five different ways, duplicated across two preloads and main. One channel table and one validator module would do.
- **`desktop/main.js` is 5.6k lines with no exports.** Its section numbering is already out of order (8b sits between 6 and 7). `drafts.js` proves the extraction pattern works: injected deps, no Electron import, 194 unit assertions. Nothing else got that treatment.
- **`GET /api/docs`** reads and parses every document on disk to build the picker list.
- **Two rev counters** (`doc.rev` on the server, `state.rev` on the client, incremented then decremented on failure) are a standing source of off-by-one bugs.

## The future plans

- **Per-tab server connections (issue #11).** Sensible product goal, but it stacks a fourth identity system on top of the file registry, the server-doc map, and the in-memory duplicate-claim table. Collapse those three into one document-identity module first.
- **Google Drive via loopback OAuth (issue #10).** Right shape. The notes correctly keep the bridge as narrow as the update bridge. Fine to build.
- **Follow My Voice on desktop with a local speech model (issue #8).** Push back on this one. It adds a native binary, a second architecture to verify, and an allowlist the dist checker cannot write yet, for a feature that already works in the browser. Web Speech is missing in Electron because Chromium's speech service is Google-hosted. Either point desktop users at the browser build for this feature, or use the OS speech recogniser through a small helper rather than bundling a model.
- **UI issues #51, #52, #53.** Well specified and cheap. No concerns.

## Smarter moves for the long run

- **Real modules plus a bundler.** The single-file output is load-bearing, but that argues for a bundler step, not against modules. esbuild with no plugins produces the same inlined page and gives imports, unit tests, and an end to name collisions. This one change unlocks most of the rest.
- **One field registry** driving migration, merge, and export. Turns invariant 4 from a rule into code.
- **One storage layer** in front of the ~40 raw `localStorage` sites and the two IndexedDB implementations. Then app-data export can enumerate keys instead of regex-scanning for secrets (invariant 48).
- **One history store**, shared as a module by browser and desktop. Desktop backend: SQLite, or a single JSON index plus content-addressed blobs. Delete the fsck.
- **Images out of state** into a content-addressed blob map keyed by hash. Saves stop cloning megabytes; the merge loses the stripped-images hack.
- **A pull channel in hosted mode**, piggybacking on the presence heartbeat. Cheapest way to make collaboration match the README.
- **Harden the updater**: ignore the downloaded manifest's API URL, require the checksum file, code-sign when possible.

## Suggested order

1. Field registry for merge and migrate, the updater trust fix, and a CSP. Three small changes, three real risks closed.
2. Fix the `saveInFlight` collision and dedupe the panel id lists.
3. Move to modules with a bundler, keeping byte-identical single-file output. Add unit tests for the pure cores as they become importable.
4. Pull channel in hosted mode.
5. Storage layer, then the history-store merge, then images out of state.
6. Prune distribution surfaces. Add CI that runs `build.mjs --check` and the Linux test driver.
