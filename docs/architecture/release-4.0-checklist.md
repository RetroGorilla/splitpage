# 4.0 release checklist status

Where each item of the [4.0 release checklist](../IMPLEMENTATION-PLAN.md#7-release-evidence-and-pr-reporting)
stands on `4.0-development` at `7d5f357` (the merge of #642, 2026-10-16). The app
code is the same as at `89d309f` (the merge of #637): every merge after it
changed only docs, the browser test driver and one suite (#640), `VERSION`,
`desktop/package.json`, its lockfile and the `sw.js` cache name (#641), or
`CHANGELOG.md`, `README.md` and `docs/help.md` (#642; `help.md` is built into
the app's help text).
Milestones 0 to 7 are closed; milestone 7's record, with its external review
chain, is [milestone-7-gate.md](milestone-7-gate.md). Milestone 5's PDF viewer
check passed on 2026-10-16 (item 8). Rows 4a, 4b and 5 were checked on
`9c39567` (the merge of M7 PR 1) on 2026-10-15. This sheet changes status only;
it records no new requirement.

`VERSION` says `4.0.0` on `4.0-development` (bumped by the release PR "Release: bump VERSION to 4.0.0"); the rows below that record `3.1.0` were run before the bump and keep that version.

Status words: **done** (evidence linked), **in progress** (thread or PR named),
**waiting on M7** (cannot be finished before milestone 7 closes; the evidence
it will need is listed), **not started**.

## Checklist items

| # | Item (plan section 7) | Status | Evidence or what is needed |
| --- | --- | --- | --- |
| 1 | Fast gates pass on the final branch | **done on the current app code** | `npm run verify` exit 0, Node 24.22.0, Linux, on `a4efb59`, `7b7b430` and `7d5f357` (lint, types, `check:deps`, comments, build and `sw.js` unchanged; frontend 174/174, tests 135/135, desktop 15/15, tools 17/17 files), run for this audit; summaries in `release-checks/audit-643/verify-<commit>.txt` in the project's shared files and on [#643](https://github.com/RetroGorilla/splitpage/pull/643). Push runs green: [`7d5f357`](https://github.com/RetroGorilla/splitpage/actions/runs/38857265674), [`7b7b430`](https://github.com/RetroGorilla/splitpage/actions/runs/38856145728), [`a4efb59`](https://github.com/RetroGorilla/splitpage/actions/runs/38854818226), [`89d309f`](https://github.com/RetroGorilla/splitpage/actions/runs/38832624304). Still needed: the push run of the release commit itself (see [ci.md](ci.md)); it changes no app code, so it confirms rather than adds coverage. |
| 2 | Every browser suite passes on Linux and Windows where supported | **done on the current app code** | On `2519df0`, whose tree is identical to `a4efb59` and differs from `7b7b430` only in the version files and this checklist: Windows x64 194/194 suites, 10394/10394 checks; WSL Linux 194/194, 10394/10394; cloud Linux 194/194, 10394/10394 on `c446c79` (comment-only diff), suites 102 and 38 rerun on `2519df0` ([#640 review](https://github.com/RetroGorilla/splitpage/pull/640#issuecomment-6208624000), [Linux full run](#linux-full-run-on-1e407db)). No suite skipped. On `7d5f357` (after #642 changed the help text), cloud Linux, Node 24.22.0, Chromium 141, `node tools/run-suites.mjs`: 194/194 suites, 10394/10394 checks, run for this audit (per-suite summary: `release-checks/audit-643/full-run-7d5f357.txt` in the project's shared files). After #641, `53-service-worker`, the suite that checks the `VERSION`-named cache, passed 32/32 on `7b7b430` (cloud Linux; `release-checks/audit-643/suite-53-7b7b430.txt`). Not repeated since #641: the frozen-caches Windows run, last 10587/10587 on `cbab324` ([M7 gate](milestone-7-gate.md#windows-runs)), before #636 and #637; the plan does not ask for it. |
| 3a | Real Electron smoke | **done** | Dev target 974/974, 0 skipped, on `53dff02` ([M7 gate](milestone-7-gate.md#windows-runs)) and again on #636's head `2566deb`, after #633 fixed the test race in the #531 case ([M7 gate, the #531 smoke case](milestone-7-gate.md#the-531-smoke-case)). Rerun if a later change touches `desktop/`, preload or IPC. |
| 3b | Windows x64 packaged check | **in progress** | Last run at the [M5 gate](milestone-5-gate.md) (stage, build, `verify-dist.mjs --arch x64` 6/6, packaged smoke 974/974); the M7 gate did not require it. Packaging inputs changed since: `VERSION` and `desktop/package.json` are now 4.0.0 (#641). Needed: stage, build, verify-dist and packaged smoke on the release tree, on the x64 device. A thread on the x64 PC is running it. |
| 3c | Windows ARM64 native check | **done** | **PASS** on 2026-10-16 at `63d6962` (the merge of #634; no product or test code changed since the milestone 7 closing tree) on a Windows 11 ARM64 machine (Snapdragon X), Node v24.22.0 running as native arm64 (portable zip, SHA-256 matched nodejs.org's `SHASUMS256.txt`). Root and `desktop/` `npm ci` exited 0; `stage.mjs` and `electron-builder --win --arm64` finished cleanly; `VERSION` and `desktop/package.json` both 3.1.0. `node verify-dist.mjs --arch arm64`: 6 of 6 checks, including the payload extraction check the cloud cross-build could not run. The arm64 installer installed silently into a scratch folder, exit 0. `node test/smoke.mjs --only-target packaged-arm64`: 974 of 974, 0 skipped. The installed `Splitpage.exe` launched natively, opened a test document, and Windows reported the process as native arm64, not emulated. No reruns. Notes: `electron-builder` also produced x64 and universal installers (harmless); its log says "signing with signtool.exe", and whether that is a real signature was not checked. Logs (`verify-dist.log`, `smoke.log`, `builder.log`, `stage.log`, two `npm ci` logs): `C:\Users\Adam\Documents\Claude Projects\.scratch\arm64-3c\` on that laptop only; the session that ran the check could not copy them into the project's shared files. |
| 4a | Both Docker paths start with fresh and with existing data | **done** | `Dockerfile.prebuilt`: **PASS** at `9c39567`, as user 99:100 with `PERSIST_LINKS=1` and a data volume, on a fresh data folder and on a copy of 3.1 data; a 3.1 owner token and review keys are accepted and survive a restart. Root `Dockerfile`, fresh data: **PASS** at 4.0.0 in the Docker workflow's `image` job on #641's head `3cbc876` (same tree as `7b7b430`), [run 38854893082](https://github.com/RetroGorilla/splitpage/actions/runs/38854893082): built with the legacy builder, no source in the image, started as 99:100 with `JOIN_PIN` and `PERSIST_LINKS=1` on an empty data folder, `/api/health` reports 4.0.0, `sw.js` carries `splitpage-4.0.0`, the owner's sign-in survives a restart. The `prebuilt` job in the same run starts `Dockerfile.prebuilt` on fresh data. 3.1 data against the 4.0 server: 13/13 checks each way over real HTTP (row 5, `release-checks/3.1-server-compatibility.md` in the project's shared files). Not run: the root `Dockerfile` image started on a copy of 3.1 data (the cloud container cannot build it: the proxy's certificate breaks `npm ci` inside the build). Adam accepted the evidence above without that run on 2026-10-16. Existing gap, not part of this row: `docker.yml` has no multi-arch build. |
| 4b | Portable distribution starts with fresh and existing data | **done** | **PASS** at `9c39567`: `node package.mjs zip`, started on fresh data and on a copy of 3.1 data. Documents read back byte-identical, the blob hash matches, and the 3.1 owner token and review key are accepted. Rerun on the release tree if packaging inputs change. |
| 4c | Sign-ins and links, permissions, offline behaviour, worker upgrade stay correct | **in progress** | Covered so far: persistent sign-ins and links across a server restart and on 3.1 data (row 4a, `Dockerfile.prebuilt` at `9c39567`; root `Dockerfile` on fresh data in run 38854893082); `JOIN_PIN` with `PERSIST_LINKS`, wrong and right PIN, edit and review links, guest edit and guest review comment, the 4.0 client against the 3.1 server (row 5, `release-checks/3.1-server-compatibility.md` in the project's shared files). Not covered by any recorded run: offline use of the 4.0 app, and the 4.0 service worker (`splitpage-4.0.0`) replacing an installed 3.1 worker in a browser that already ran 3.1. Needed: a 3.1 to 4.0 upgrade pass in a browser covering those two. |
| 5 | 4.0 client against the unchanged 3.1 server; 3.1/4.0 project exchanges | **done** | **PASS** at `9c39567` against tag `v3.1.0` (`80500f6`). `server/` differs from 3.1 only in `server/server.js` (+31/-10, commits `562990d`, `f055fa1`, `a0293f7`): a document state that is not an object is refused (400 `bad-state` on create and PUT, 409 `no-state` on comments), and names, comment quotes and titles are cut by code point. So old-client/new-server was also run. `tools/test-server.mjs`: 762/762 on 4.0; 721/762 with the 3.1 `server.js` swapped in, all 41 failures being the checks for those two changes. Over real HTTP with no fetch fakes, the 4.0 client on the 3.1 server and the 3.1 client on the 4.0 server each passed 13/13 (health detection, publish, save, blob upload, 409 merge, external comment); a reload by `?doc=` link, and `JOIN_PIN` with `PERSIST_LINKS` (wrong and right PIN, edit and review links, guest edit saved, guest review comment stored) also passed on the 3.1 server. A 30-scene project exported by each build gives byte-identical `.splitpage` and `.md` files, and each build opens the other's to a byte-identical state. Not covered: the Collaborate dialog by hand, the desktop app, a 3.1 Docker image as the server. Write-up: `release-checks/3.1-server-compatibility.md` in the project's shared files. |
| 6 | No migrated feature touches global `S` or live state; forbidden edges shrink; no cycles in completed areas | **done on the current app code** | M4 to M7 gates record the feature checks. `npm run check:deps` on `7b7b430` and `7d5f357`, run for this audit: 514 exceptions in the baseline, 0 new, 0 resolved; one runtime cycle, 46 modules, 310 edges; 3 `S` assigners (`00-prelude.js`, `02b-doc-id.js`, `03-sync.js`); no state bridges. The same as the M7 record at `53dff02` ([M7 gate](milestone-7-gate.md#dependency-baseline)); `tools/dep-baseline.json` last changed in `c5615fc` (7.2, 515 to 514). Recheck only if app code changes before the release. |
| 7 | Release names the legacy initializer shim, its started-module count, and the remaining bridge files with owners | **done** | Counts at `7b7b430`, run for this audit, the same as the [M7 gate](milestone-7-gate.md#shim-status-at-53dff02) at `53dff02` except the bridge line total: `src/js/_entry.js`, "the legacy initializer shim", 170 lines, 80 import statements, starts 69 of 79 numbered modules (ten load only as imports); 23 bridge files, 1,452 lines (#636 added one line to `save-bridge.ts`); 106 bridge imports in 57 numbered modules, none in `_entry.js`. Owners per bridge: [milestone-7.md](milestone-7.md#release-checklist-inputs). Named in the release notes: `CHANGELOG.md`, 4.0.0 entry, section "Remaining legacy code" (#642, merged as `7d5f357`): the shim, 69 of 79, the 23 bridge files with lines and what keeps each, and the owner. #642 changed no file under `src/`, so the figures hold on `7d5f357`. |
| 8 | External review at the release gate covers M5 and M7 with M6's own | **done** | M6: Astra review 2026-10-15, fixes in #629, re-reviewed by Sol, all closed ([M6 gate](milestone-6-gate.md#external-review)). M5 and M7: Astra (Codex CLI) reviewed both on `53dff02` on 2026-10-15; verdict no for both. Findings: 1 blocking (M7 teardown leaves an active save running), 2 should-fix (M7 dependency validation; M5 export filename looked up again after the build), and M5's reader and viewer checks still unrecorded ([M7 gate, external review](milestone-7-gate.md#external-review)). M5 viewer checks at `53dff02`: DOCX and XLSX **PASS** in Word and Excel 16.0, project round trips **PASS**, PDF **PASS** (2026-10-16): the pictures show in a PDF exported in a real browser (Chromium, at `89d309f`) with three scene pictures (PNG, JPEG, PNG) and one comment picture (PNG); it has four embedded images, all placed on pages (checked with `pdfimages` and by rendering the pages), and Adam opened it and confirmed the pictures show. The six PDFs made at `53dff02` on the PC are not evidence for images: the Node test harness (jsdom) has no canvas, so the exporter's PNG and GIF to JPEG conversion silently dropped the PNG scene image and the GIF comment image, leaving only the fixture's 23-byte JPEG stub; their page counts and layout were fine. `tests/65-blobs.txt` also asserts that PNG and WebP pictures reach the PDF as JPEG streams ([M5 gate amendment](milestone-5-gate.md#viewer-checks-and-round-trips-amendment-2026-10-15)). Finding 3 fixed by #635 (`81ae567`). Findings 1 and 2 partly fixed by #636 (`23b49a7`); Sol's re-review found R1 (blocking: a held hosted save still reaches the replacement owner) and R2 (should-fix: `timers` and the recovery factory not fully validated) ([M7 gate, re-review](milestone-7-gate.md#re-review-of-the-fixes)). #637 fixed R1 and R2, merged as `89d309f`; Sol's re-check passed (M7 code side pass, no new defects). M5 code side passed in Sol's re-review. |
| 9 | Source and format fixtures stable; performance and visual comparisons under documented conditions | **done on the current app code** | Golden fixtures run in `npm run verify` (green on `7d5f357` above); `src/test/fixtures/` is unchanged since `53dff02` and the goldens last changed in `6879ea9` (M6 6.5). Performance record and medians: [performance-record.md](performance-record.md), M4 re-run recorded in the [M4 gate](milestone-4-gate.md). CSS comparison uses the byte-identical comparator output in place of browser captures (accepted by Adam, 2026-10-15; [M6 gate](milestone-6-gate.md#external-review)). M7, #636 and #637 changed no golden fixture and no hot path (wiring runs once at startup; #637 adds a check in the hosted save's completion), so no performance re-run. |
| 10 | Ownership map, invariant ledger, testing instructions and remaining legacy work describe the delivered source | **in progress** | Needed (the review fixes merged in `89d309f`): a read of [invariants.md](invariants.md), [dependencies.md](dependencies.md), [testing.md](testing.md), [milestone-7.md](milestone-7.md) and the module and bridge counts against the final tree. A docs thread is checking these. Known fix: `milestone-7.md` says 1,451 bridge lines; the count is 1,452 since #636. |

## Linux full run on `1e407db`

Container run, Node 24.22.0 (the `.nvmrc` version; the container's Node 22.22.0
is refused by the suite runner), `npm ci`, `node build.mjs`, headless
Chromium from Playwright, 4 lanes, `node tools/run-suites.mjs`.

| Run | Result |
| --- | --- |
| `node tools/run-suites.mjs` | 192 of 194 suites pass; 10389 of 10393 checks |
| `npm run verify` | exit 0; frontend 173/173, tests 133/133, desktop 15/15, tools 17/17 files; 276 type-check cases |

| Suite | Result | Failing checks |
| --- | --- | --- |
| `102-rundown-lens` | 91/94, same on a one-lane rerun | The focus lens does not engage; blocks 13 and 14 narrower than 80 and 60 px |
| `38-newtab-phone` | 19/20, same on a one-lane rerun | A New Tab card or button extends past the 375 px viewport |

Both failures are the same as in the [milestone 0 baseline](baseline-runs.md).
Suites 247, 252 and 266, which the project had also listed as failing in this
container, passed this time; 252 varied in the baseline. No suite outside the
known list failed.

### Cause and fix (2026-10-16)

The failures were not fonts: Chivo, Chivo Mono and Atkinson Hyperlegible Next
load on Linux, and the same Chromium passes both suites on Windows. Two
differences in the test setup caused them:

- `102-rundown-lens`: headless Chromium off Windows reports `hover: none` and
  no fine pointer. `05f-rundown.js` reads that once at startup (`noHover`) and
  `lensFocus` refuses to open the keyboard-focus lens without hover, so the
  focus lens never engaged and the two width checks never became true. The
  Linux driver now starts Chromium with Blink's hover and pointer settings set
  to a mouse (what headless Edge on Windows already reports), and no longer
  sends an `Emulation.setTouchEmulationEnabled` call that would switch hover
  off again when a suite asks for a desktop viewport.
- `38-newtab-phone`: the "Want its own window" pitch is shown only for a
  Windows user agent (`desktopAppOffered`, `20a-update.js`), so on Linux it had
  no width and the all-elements width check failed. The suite now sets a
  Windows user agent the same way `30-new-tab.txt` does and waits for the
  pitch. It gains one wait and one check (21 instead of 20).

No assertion was changed or removed.

| Run | Result |
| --- | --- |
| Linux, Node 24.22.0, cloud container, `node tools/run-suites.mjs` | 194 of 194 suites; 10394 of 10394 checks (this change, on the base `8658976`) |
| Linux (WSL on the x64 PC), Node 24.22.0, at the PC's own copy of the fix | 194 of 194 suites; 10394 of 10394 checks |
| Windows x64, Node 24.22.0, at the PC's own copy of the fix | 194 of 194 suites; 10394 of 10394 checks |

The two PC runs were of a scratch commit (`afb1725`, 8 added lines) that
passed both suites with the same driver and suite 38 changes but without the
touch-emulation guard; in the cloud container's Chromium 141 suite 102 still
failed three checks until the guard was added, so this change includes it. Logs for
those runs are on the PC at `D:\vibecoding\.scratch\linux-gate\logs-pr-linux` and
`logs-pr-win`, with the write-up at `D:\vibecoding\.scratch\linux-gate\diagnosis.md`;
they are not copied to the project's shared files. The cloud run's per-suite summary is
`release-checks/linux-parity/cloud-full-run-summary.txt` in the project's shared files.

## Dependabot target-branch cleanup (#382)

| | |
| --- | --- |
| Item | #382 "Bump the actions group with 4 updates" (opened 2026-10-05 against `main`, touches 3 files) |
| Status | **cleanup done 2026-10-16; #382 stays open until the release** |
| Why | `.github/dependabot.yml` now targets `4.0-development` for all four ecosystems, but #382 was opened when Dependabot targeted `main`. It stays open until the release. |
| Checked 2026-10-16 | `dependabot.yml` on `4.0-development` sets `target-branch: 4.0-development` on all four entries (npm `/`, npm `/desktop`, github-actions, docker). Open pull requests from Dependabot: only #382. Dependabot branches on the remote: only #382's. No stale Dependabot pull request exists to close, and nothing was rebased or merged. |
| Needed | At the release: after `4.0-development` merges to `main`, close #382 or let Dependabot rebase it on the new `main`, check that no Dependabot branch still targets a removed branch, and confirm `target-branch` in `dependabot.yml` points at the branch Dependabot should now use. |

## Gate items outside the numbered list

| Item | Status | Notes |
| --- | --- | --- |
| Linux full run | **done** | Above. 194 of 194 suites on Linux and Windows after the browser driver fix. On the merged head `2519df0`, the PC runs were Windows x64 (Node 24.22.0) 194 of 194 suites, 10394 of 10394 checks, and WSL Linux (Node 24.22.0) 194 of 194 suites, 10394 of 10394 checks; logs on the PC at `D:\vibecoding\.scratch\linux-gate\logs-640-win` and `logs-640-linux`, recorded in the [#640 review comment](https://github.com/RetroGorilla/splitpage/pull/640#issuecomment-6208624000). |
| Native ARM64 packaged check | **done** | Item 3c. |
| Release candidate named in the release notes (shim, module count, bridges) | **done** | Item 7: `CHANGELOG.md` 4.0.0, "Remaining legacy code" (#642, `7d5f357`), measured at `7b7b430`. |
| M7 gate (Windows full run, Electron dev smoke, gate record) | **done** | Runs and external review recorded in [milestone-7-gate.md](milestone-7-gate.md); closed on `89d309f` after Sol's re-check of #637. |
| `VERSION` bump to 4.0 | **done** | PR "Release: bump VERSION to 4.0.0": `VERSION`, `desktop/package.json`, `desktop/package-lock.json` and the `sw.js` cache name are `4.0.0`; `node build.mjs --check` and `desktop/stage.mjs` pass. |

## Known problems to carry into the release

- Flaky suites, none reproducible: `186` and `migrate-rows`; `66-hosted-blobs` (1 of 4 Windows full runs of #626). Keep the full log if any recurs ([M6 gate, flakes](milestone-6-gate.md#flakes-seen)). The Electron smoke group "#531 tear-off close check under --host", listed here before, was a test race and is fixed by #633 ([M7 gate](milestone-7-gate.md#the-531-smoke-case)).
- Rows animate on open when ids match the old document's (#595, deferred).
- `saveBackToFile` `close()` then `getFile()` on desktop (deferred).
- A push run on `4.0-development` tests only the files its own merge changed, and a docs-only merge right after a code merge cancels the code merge's run ([ci.md](ci.md)). Check the push run after each code merge and rerun by hand if cancelled.
- The tab strip width test was deleted on 2026-10-14 and nothing guards the PR #17 resize-every-tab bug.

## 4.x follow-ups (not release items)

- Composition root as the build entry, then the remaining bridges and the `S` fields ([plan section 8](../IMPLEMENTATION-PLAN.md#8-follow-up-refactors-for-4x)).
- CSS tokens beyond colour, and sorting the remaining rules into base, layout and components.
- Save-recovery consolidation; server and desktop services.
- One shared listener helper in place of the copy in eight features (6.8.5).
- Test follow-ups from Sol's re-review of #629: `app-stop-errors-app.test.mjs` injects only one shutdown failure, and `rows-drag-dispose-app.test.mjs` never creates drop markers, so marker removal is verified by reading the code only.
- A throwing cleanup step inside one feature skips that feature's remaining cleanup (nothing can throw there today).
- A test for the "(with images).zip" export name (noted in the #635 review).
- A save that completes after teardown still resets the Save button label (noted in the #637 review).
