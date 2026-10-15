# 4.0 release checklist status

Where each item of the [4.0 release checklist](../IMPLEMENTATION-PLAN.md#7-release-evidence-and-pr-reporting)
stands on `4.0-development` at `1e407db` (the merge of #627, 2026-10-15).
Milestones 0 to 6 are closed; milestone 7 is in progress (M7 PR 1, the wiring
step and legacy shim). This sheet changes status only; it records no new
requirement.

Status words: **done** (evidence linked), **in progress** (thread or PR named),
**waiting on M7** (cannot be finished before milestone 7 closes; the evidence
it will need is listed), **not started**.

## Checklist items

| # | Item (plan section 7) | Status | Evidence or what is needed |
| --- | --- | --- | --- |
| 1 | Fast gates pass on the final branch | **waiting on M7** | Passing on today's head: `npm run verify` exit 0 on Linux, Node 24.22.0, at `1e407db` (173 frontend, 133 tests, 15 desktop and 17 tools files; 276 type-check cases), and the push run for each M6 merge succeeded ([M6 gate, CI on the closing tree](milestone-6-gate.md#ci-on-the-closing-tree)). Needed: the same on the final merge commit after M7, including the push run for it (see [ci.md](ci.md)). |
| 2 | Every browser suite passes on Linux and Windows where supported | **in progress** | Windows: 10393/10393 plain and 10587/10587 frozen across 194 suites ([M6 gate](milestone-6-gate.md#windows-runs)). Linux: see [the Linux full run](#linux-full-run-on-1e407db). Needed: Windows full runs repeated on the M7 closing tree, and the two Linux failures resolved or named as platform-only. An unresolved missing check blocks the release-readiness claim. |
| 3a | Real Electron smoke | **waiting on M7** | Dev target 974/974 at M6 ([M6 gate](milestone-6-gate.md#windows-runs)). Needed: again on the M7 closing tree. |
| 3b | Windows x64 packaged check | **not started** | Last run at the [M5 gate](milestone-5-gate.md) (stage, build, `verify-dist.mjs --arch x64` 6/6, packaged smoke 974/974). Needed: stage, build, verify-dist and packaged smoke on the release tree, on the x64 device. |
| 3c | Windows ARM64 native check | **not started** | Needs the ARM64 device. An ARM64 build made on x64 is not a runtime check ([milestone-2-gate.md](milestone-2-gate.md)). Needed: payload, install and runtime evidence from the device. |
| 4a | Both Docker paths start with fresh and with existing data | **in progress** | CI builds the root `Dockerfile` (`image` job) and builds and starts `Dockerfile.prebuilt` from the artifact's file list, checking `/api/health`, `/` and `/sw.js` against `VERSION` ([testing.md](testing.md), [ci.md](ci.md)). Not yet done: starts against a fresh data folder and against representative existing 3.1 data. |
| 4b | Portable distribution starts with fresh and existing data | **not started** | Needed: a run of the staged portable package on both kinds of data. |
| 4c | Sign-ins and links, permissions, offline behaviour, worker upgrade stay correct | **not started** | Needed: a 3.1 to 4.0 upgrade pass over persistent sign-ins and links, permissions, offline use, and the service worker replacing the 3.1 worker. |
| 5 | 4.0 client against the unchanged 3.1 server; 3.1/4.0 project exchanges | **not started** | No recorded run. Needed: the client against a 3.1 server, 3.1 and 4.0 project files in both directions, and old-client/new-server coverage if backend code changed (check `server/` against the 3.1 tag first). IPC shapes and native capability checks stay as they are. |
| 6 | No migrated feature touches global `S` or live state; forbidden edges shrink; no cycles in completed areas | **waiting on M7** | M4 to M6 gates record the feature checks. At `2b891f8` the import cycle is 46 modules and 311 edges ([M6 gate](milestone-6-gate.md#shim-status-at-2b891f8)). M7 PR 2 rewords the 20 dependency-baseline exceptions for `22a` to `22f` to name 4.x. Needed: `npm run check:deps` on the final tree, with the baseline file showing exceptions only shrunk. |
| 7 | Release names the legacy initializer shim, its started-module count, and the remaining bridge files with owners | **waiting on M7** | Counts at `2b891f8`: 79 numbered modules, 69 started by `src/js/_entry.js`, 23 bridge files (1,387 lines), 110 legacy bridge imports in 58 files. M7 PR 1 turns `_entry.js` into a named shim with a frozen import list. Needed: recount on the closing tree (do not copy these), and an owner per remaining bridge from the [M7 plan](milestone-7.md) and the 4.x list below. |
| 8 | External review at the release gate covers M5 and M7 with M6's own | **waiting on M7** | M6: Astra review 2026-10-15, fixes in #629, re-reviewed by Sol, all closed ([M6 gate](milestone-6-gate.md#external-review)). M5 had a Sol review at its gate ([M5 gate](milestone-5-gate.md)). Needed: one external review of the integrated M5 and M7 work on the M7 closing tree; findings handled under [review.md](review.md). |
| 9 | Source and format fixtures stable; performance and visual comparisons under documented conditions | **in progress** | Golden fixtures run in `npm run verify` (green above). Performance record and medians: [performance-record.md](performance-record.md), M4 re-run recorded in the [M4 gate](milestone-4-gate.md). CSS comparison uses the byte-identical comparator output in place of browser captures (accepted by Adam, 2026-10-15; [M6 gate](milestone-6-gate.md#external-review)). Needed: goldens unchanged after M7, and a performance re-run only if M7 changes a hot path. |
| 10 | Ownership map, invariant ledger, testing instructions and remaining legacy work describe the delivered source | **waiting on M7** | Needed: a read of [invariants.md](invariants.md), [dependencies.md](dependencies.md), [testing.md](testing.md), [milestone-7.md](milestone-7.md) and the module and bridge counts against the final tree. |

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
| Native ARM64 packaged check | **not started** | Item 3c. |
| Release candidate named in the release notes (shim, module count, bridges) | **waiting on M7** | Item 7. |
| M7 gate (Windows full run, Electron dev smoke, gate record) | **waiting on M7** | M7 PR 2 and its gate record PR. |

## Known problems to carry into the release

- Flaky suites, none reproducible: `186` and `migrate-rows`; `66-hosted-blobs` (1 of 4 Windows full runs of #626); the Electron smoke group "#531 tear-off close check under --host" (1 of 2 runs). Keep the full log if any recurs ([M6 gate, flakes](milestone-6-gate.md#flakes-seen)).
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
