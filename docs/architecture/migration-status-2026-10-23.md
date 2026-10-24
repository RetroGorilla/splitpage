# Splitpage 4.1 migration status — 2026-10-23

Measured on `4.1-development` at `de712f8d95dc6f112fc9c183cefd91277e643829` (PR #789, 17:09 PDT / 00:09 UTC October 24). This is a dated source audit, not a release-readiness claim. The implementation chat also received Claude's handoff dated October 24; its operational priorities are recorded below separately from measured source facts.

## Measurements

Reproduced with `node tools/dep-report.mjs --legacy-metrics`, `node tools/dep-report.mjs --metrics` and a read of the tracked source tree on the revision above.

| Measure | Earlier L5 inventory (`a1615c0`) | Audited branch |
| --- | --- | --- |
| Numbered files in `src/js/` | 56 | 34 |
| Lines in those numbered files | 29,912 | 19,299 |
| Frontend modules in runtime import cycles | 29 | 11 |
| Runtime cycles | Not recorded in the inventory summary | 2; largest has 9 modules |
| Links inside runtime cycles | Not recorded in the inventory summary | 29 |
| Global `S` fields, references and importers in source and tests | Historical baseline in legacy-reduction.md | 0 |
| `S.state` assigners and direct-write lines detected by legacy metrics | Historical baseline in legacy-reduction.md | 0 |

The handoff's **37 numbered files** and the tool's **34** count different locations: 34 are in `src/js/`, while `02c-blobs.js`, `02d-gallery.js` and `03c-history-idb.js` already live in `src/adapters/storage/`. Their numbered names do not mean their L4 extraction is unfinished. Zero detected direct-write lines does not certify the document-guard browser run.

The source has 407 frontend modules, of which the report classifies 371 as migrated. Module counts alone are not an acceptance criterion.

## L5 waves

The wave definitions and port contracts remain in [feature-ports.md](feature-ports.md). These statuses are based on source removal and receiving owners, not on a claim that the integrated gate has passed.

| Wave | Source status at the audited revision | Work left |
| --- | --- | --- |
| 0 | Script zoom and rundown/presence/target have moved | Integrated verification remains part of the closing gate |
| 1 | Help/tour, draft boxes, read time and find/replace have moved | Integrated verification remains part of the closing gate |
| 2 | Undo, gallery/annotation/video, cell/scene clipboard, B-roll records and the principal row operations have moved | `06-rows.js` still owns video-file functions; complete that extraction and delete the file |
| 3 | Comments, settings and the export dialog have moved; some other groups have partial owners or ports | Render, tags/production, B-roll panel, Writer, prompter, file menu, command menu, collaboration, remaining update glue, onboarding, new tab and app-data work remain wholly or partly numbered |
| 4 | The scheduled L5 lifecycle/adapter moves are not complete; existing L3/L4 owners are prerequisites, not proof of completion | Identity/entry, history, sync/merge, imports, save status, server client, saving/files, desktop, drafts and final bridge/entry retirement |

Do not classify an entire group as complete because one of its files moved: `18c-export-dialog.js` is gone but `18b-file-menu.js` remains; `20s-settings.js` is gone but `20h-appdata.js` remains; `05v-video.js` is gone but `06-rows.js` still has local video-file responsibilities.

## Remaining runtime cycles

The larger cycle contains `02b-doc-id`, `03-sync`, `03a-history-store`, `12-dirty-toast`, `13-hosted`, `18b-file-menu`, `20e-connect`, `20f-desktop` and `20g-drafts` (all under `src/js/`, with `.js` suffixes).

The second cycle is `src/js/08d-broll-panel.js` with `src/js/18-local-files.js`. Moving B-roll records did not eliminate the B-roll panel's remaining dependency.

Therefore the earlier L3h target of zero runtime cycles is not yet met. No wave-3 or wave-4 assignment should assume that target has passed without remeasurement.

## Current onboarding work

Live GitHub inspection found [PR #759](https://github.com/RetroGorilla/splitpage/pull/759), `codex/l5-onboarding`, still open at head `40cc21051caa37081b03155a1b82a4dbebe3288c` with merge conflicts. This contradicts the handoff's blanket statement that nothing is in flight. Treat the handoff's queue as a sequencing proposal, not evidence that #759 merged.

An isolated review-fix candidate is being prepared for that head plus the audited base. It reuses the shared launch/file interfaces that landed after #759, preserves action registration and startup order, and guards asynchronous onboarding work across teardown/remount. Until the coordinator applies it and the PR's own checks/review pass, `20b-onboarding.js` remains in the branch count above.

## Next work and dependencies

The supplied handoff prioritizes the following. This audit records the priorities without treating proposed coordination changes as already adopted policy.

1. Settle the merge-ordering rule: compare ready PRs' changed files, serialize overlapping updates, and keep one pusher per PR branch. The checked-in [review policy](review.md) already requires a base merge for conflicts or overlapping changed files. Record any new coordination agreement there before relying on it.
2. Split the shared-port wiring and legacy-shim test by feature to reduce the central-file conflicts. This is a separate implementation task, not part of #759's conflict resolution.
3. Evaluate CI sharding across the two Unraid runners and parallel lint/typecheck. The handoff's roughly three-minute saving is an estimate, not a measurement made by this audit.
4. Finish `06-rows.js` video-file extraction; the handoff identifies it as unblocked.
5. Resolve and apply #759 through the coordinator, then reconcile the proposed Codex queue: `20b`, `13b`, `08d`, `20f`, `20g`, `20h`, `20j`, `18d`. `20b` is #759 itself, so do not create a duplicate task. File presence alone does not certify the other jobs' prerequisites. Server work remains paused according to the handoff; clarify whether a proposed collaboration/client task falls within that pause before assigning it.
6. Complete L5, L3j and the integrated release gate in the sequence described by the handoff. Remeasure the cycle and legacy exit criteria; run the full Windows regression, Electron smoke, x64 and native ARM64 packaged checks and independent external review required for a release claim.

The handoff references I-26 in `issues/TRACKER.md` and performance history in `perf/perf-log.md`. Neither path exists in the audited repository tree. Locate the external tracker/log before claiming those follow-ups or performance evidence have been reconciled. I-25 remains a future idea, not scope for this update.

## Recheck before the next assignment

Read the current remote branch and PR heads, then rerun the two metric commands. Check the relevant source files and open PRs before assigning work. Counts here deliberately remain pinned to the audited revision; no pending change is counted as merged.
