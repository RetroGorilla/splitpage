# 4.0 release checklist status

Where each item of the [4.0 release checklist](../IMPLEMENTATION-PLAN.md#7-release-evidence-and-pr-reporting)
stands on `4.0-development` at `53dff02` (the merge of #633, 2026-10-15).
Milestones 0 to 6 are closed. Milestone 7's gate runs passed and are recorded in
[milestone-7-gate.md](milestone-7-gate.md), but the release review found
findings in milestones 5 and 7 that are being fixed (item 8). Rows 4a, 4b and 5 were checked on
`9c39567` (the merge of M7 PR 1) on 2026-10-15. This sheet changes status only;
it records no new requirement.

`VERSION` still says `3.1.0` on `4.0-development`; the bump to 4.0 is a release
step and affects the version the Docker checks compare against.

Status words: **done** (evidence linked), **in progress** (thread or PR named),
**waiting on M7** (cannot be finished before milestone 7 closes; the evidence
it will need is listed), **not started**.

## Checklist items

| # | Item (plan section 7) | Status | Evidence or what is needed |
| --- | --- | --- | --- |
| 1 | Fast gates pass on the final branch | **in progress** | `npm run verify` exit 0 on Linux, Node 24.22.0, at `53dff02` (the M7 gate record PR's run), and the push runs for the three M7 merges succeeded ([M7 gate, CI](milestone-7-gate.md#ci-on-the-closing-tree)). Needed: the same on the release merge commit, including its push run (see [ci.md](ci.md)). |
| 2 | Every browser suite passes on Linux and Windows where supported | **in progress** | Windows on the M7 tree: 10393/10393 plain and 10587/10587 frozen across 194 suites on `cbab324` ([M7 gate](milestone-7-gate.md#windows-runs)). Linux: see [the Linux full run](#linux-full-run-on-1e407db). Needed: the two Linux failures resolved or named as platform-only. An unresolved missing check blocks the release-readiness claim. |
| 3a | Real Electron smoke | **done** | Dev target 974/974, 0 skipped, on `53dff02` ([M7 gate](milestone-7-gate.md#windows-runs)), after #633 fixed the test race in the #531 case ([M7 gate, the #531 smoke case](milestone-7-gate.md#the-531-smoke-case)). Rerun if a later change touches `desktop/`, preload or IPC. |
| 3b | Windows x64 packaged check | **not started** | Last run at the [M5 gate](milestone-5-gate.md) (stage, build, `verify-dist.mjs --arch x64` 6/6, packaged smoke 974/974). Needed: stage, build, verify-dist and packaged smoke on the release tree, on the x64 device. |
| 3c | Windows ARM64 native check | **not started** | Needs the ARM64 device. An ARM64 build made on x64 is not a runtime check ([milestone-2-gate.md](milestone-2-gate.md)). A cloud cross-build (`electron-builder --win --arm64`, 2026-10-15) passed 5 of 6 `verify-dist.mjs` checks (payload extraction needs Windows `7z.exe`) and found no native modules; that is build evidence only. Needed on the device: build or fetch the arm64 payload, `node verify-dist.mjs --arch arm64`, install, `node test/smoke.mjs --only-target packaged-arm64`, and run it natively. |
| 4a | Both Docker paths start with fresh and with existing data | **in progress** | `Dockerfile.prebuilt`: **PASS** at `9c39567`, as user 99:100 with `PERSIST_LINKS=1` and a data volume, on a fresh data folder and on a copy of 3.1 data; a 3.1 owner token and review keys are accepted and survive a restart. Root `Dockerfile`: could not be built in the cloud container (the proxy's certificate breaks `npm ci` inside the build); its build-stage `COPY` set was checked against what the build reads and is complete, and CI's `image` job builds it on every PR. Needed: a start of the root `Dockerfile` image on fresh and 3.1 data where it can be built. Existing gap, not part of this row: `docker.yml` has no multi-arch build. |
| 4b | Portable distribution starts with fresh and existing data | **done** | **PASS** at `9c39567`: `node package.mjs zip`, started on fresh data and on a copy of 3.1 data. Documents read back byte-identical, the blob hash matches, and the 3.1 owner token and review key are accepted. Rerun on the release tree if packaging inputs change. |
| 4c | Sign-ins and links, permissions, offline behaviour, worker upgrade stay correct | **not started** | Needed: a 3.1 to 4.0 upgrade pass over persistent sign-ins and links, permissions, offline use, and the service worker replacing the 3.1 worker. |
| 5 | 4.0 client against the unchanged 3.1 server; 3.1/4.0 project exchanges | **done** | **PASS** at `9c39567` against tag `v3.1.0` (`80500f6`). `server/` differs from 3.1 only in `server/server.js` (+31/-10, commits `562990d`, `f055fa1`, `a0293f7`): a document state that is not an object is refused (400 `bad-state` on create and PUT, 409 `no-state` on comments), and names, comment quotes and titles are cut by code point. So old-client/new-server was also run. `tools/test-server.mjs`: 762/762 on 4.0; 721/762 with the 3.1 `server.js` swapped in, all 41 failures being the checks for those two changes. Over real HTTP with no fetch fakes, the 4.0 client on the 3.1 server and the 3.1 client on the 4.0 server each passed 13/13 (health detection, publish, save, blob upload, 409 merge, external comment); a reload by `?doc=` link, and `JOIN_PIN` with `PERSIST_LINKS` (wrong and right PIN, edit and review links, guest edit saved, guest review comment stored) also passed on the 3.1 server. A 30-scene project exported by each build gives byte-identical `.splitpage` and `.md` files, and each build opens the other's to a byte-identical state. Not covered: the Collaborate dialog by hand, the desktop app, a 3.1 Docker image as the server. Write-up: `release-checks/3.1-server-compatibility.md` in the project's shared files. |
| 6 | No migrated feature touches global `S` or live state; forbidden edges shrink; no cycles in completed areas | **in progress** | M4 to M7 gates record the feature checks. At `53dff02`: the import cycle is 46 modules and 310 edges (one fewer edge than at `2b891f8`); the baseline is 514 exceptions, none naming milestone 7 ([M7 gate](milestone-7-gate.md#dependency-baseline)). Needed: `npm run check:deps` on the release tree, with the baseline file showing exceptions only shrunk. |
| 7 | Release names the legacy initializer shim, its started-module count, and the remaining bridge files with owners | **in progress** | Counts at `53dff02` ([M7 gate, shim status](milestone-7-gate.md#shim-status-at-53dff02)): `src/js/_entry.js`, "the legacy initializer shim", 170 lines, starts 69 of 79 numbered modules, 72 import specifiers equal to its frozen set; 23 bridge files (1,451 lines), 106 bridge imports in 57 numbered modules. Owners per bridge: [milestone-7.md](milestone-7.md#release-checklist-inputs). Needed: these named in the release notes, recounted if the release tree differs. |
| 8 | External review at the release gate covers M5 and M7 with M6's own | **in progress** | M6: Astra review 2026-10-15, fixes in #629, re-reviewed by Sol, all closed ([M6 gate](milestone-6-gate.md#external-review)). M5 and M7: Astra (Codex CLI) reviewed both on `53dff02` on 2026-10-15; verdict no for both. Findings: 1 blocking (M7 teardown leaves an active save running), 2 should-fix (M7 dependency validation; M5 export filename looked up again after the build), and M5's reader and viewer checks still unrecorded ([M7 gate, external review](milestone-7-gate.md#external-review)). M5 viewer checks: in progress, running on Adam's PC at `53dff02`. Needed: the fix PRs #635 (M5) and #636 (M7) merged and reviewed, and the viewer-check result recorded. |
| 9 | Source and format fixtures stable; performance and visual comparisons under documented conditions | **in progress** | Golden fixtures run in `npm run verify` (green above). Performance record and medians: [performance-record.md](performance-record.md), M4 re-run recorded in the [M4 gate](milestone-4-gate.md). CSS comparison uses the byte-identical comparator output in place of browser captures (accepted by Adam, 2026-10-15; [M6 gate](milestone-6-gate.md#external-review)). M7 changed no golden fixture and no hot path (wiring runs once at startup), so no performance re-run. Needed: goldens unchanged on the release tree. |
| 10 | Ownership map, invariant ledger, testing instructions and remaining legacy work describe the delivered source | **not started** | Needed, once the review fixes have merged: a read of [invariants.md](invariants.md), [dependencies.md](dependencies.md), [testing.md](testing.md), [milestone-7.md](milestone-7.md) and the module and bridge counts against the final tree. |

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

Every failing check measures an element's width, so the cause is most likely
that the app's web fonts do not load in the container (the page fetches them
from Google Fonts). This is not confirmed: the documented way to load them,
pinning the proxy's certificate in the browser
([run-splitpage-app skill](../../.claude/skills/run-splitpage-app/SKILL.md)), was
not run here.

Options that weaken no test, none applied yet:

- Run this gate item on the self-hosted Linux runners that already run CI, which have a normal network.
- Provide the fonts in the container or CI image (Chivo, Chivo Mono, Atkinson Hyperlegible Next) so the page does not depend on the network.
- Confirm by rerunning the two suites with the fonts loaded, then record the result here.

## Dependabot target-branch cleanup (#382)

| | |
| --- | --- |
| Item | #382 "Bump the actions group with 4 updates" (opened 2026-10-05 against `main`, touches 3 files) |
| Status | **not started** (planned for the 4.0 release) |
| Why | `.github/dependabot.yml` now targets `4.0-development` for all four ecosystems, but #382 was opened when Dependabot targeted `main`. It stays open until the release. |
| Needed | At the release: after `4.0-development` merges to `main`, close #382 or let Dependabot rebase it on the new `main`, check that no Dependabot branch still targets a removed branch, and confirm `target-branch` in `dependabot.yml` points at the branch Dependabot should now use. |

## Gate items outside the numbered list

| Item | Status | Notes |
| --- | --- | --- |
| Linux full run | **in progress** | Above. Two width suites open. |
| Native ARM64 packaged check | **not started** | Item 3c; needs the ARM64 device. |
| Release candidate named in the release notes (shim, module count, bridges) | **in progress** | Item 7; counts recorded at `53dff02`. |
| M7 gate (Windows full run, Electron dev smoke, gate record) | **in progress** | Runs passed and recorded in [milestone-7-gate.md](milestone-7-gate.md); the release review's M7 findings are being fixed. |
| `VERSION` bump to 4.0 | **not started** | `VERSION` is `3.1.0` on `4.0-development`. |

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
