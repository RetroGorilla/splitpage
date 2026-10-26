# Splitpage 4.1 migration status — 2026-10-26

Measured on `4.1-development` at `8020d3876abf0388caa24f0924a84c6c138d522d` (PR #828, merged 11:13 PDT / 18:13 UTC October 26). This replaces [the October 23 audit](migration-status-2026-10-23.md), which stays as history. It is a dated source audit, not a release-readiness claim.

## Measurements

Reproduced with `node tools/dep-report.mjs --legacy-metrics`, `node tools/dep-report.mjs --metrics` and a count of `tools/dep-baseline.json` on the revision above.

| Measure | October 23 audit (`de712f8`, PR #789) | This audit (`8020d38`, PR #828) |
| --- | ---: | ---: |
| Numbered files in `src/js/` | 34 | 17 |
| Lines in those numbered files | 19,299 | 11,997 |
| Frontend modules in runtime import loops | 11 | 0 |
| Runtime import loops | 2 | 0 |
| Links inside runtime import loops | 29 | 0 |
| Global `S` fields, references and importers in source and tests | 0 | 0 |
| `S.state` assigners and direct-write lines | 0 | 0 |
| Frontend modules (migrated) | 407 (371) | 472 (453) |
| Dependency exceptions in `tools/dep-baseline.json` | Not recorded | 90 |

The 90 dependency exceptions break down by rule as: 57 `loop-import`, 17 `legacy-file` (one per remaining numbered file), 9 `unresolved-dynamic`, 6 `platform-global` and 1 `html-cells`. The `loop-import` rule names imports between numbered files and bridges; it is a separate count from the runtime import loops above, which are zero.

## Import loops and shared ports

The runtime import loop count has been zero since #819, which removed the last loop (`13-hosted` and `20e-connect`) through a wired PIN prompt hand-off. #796, #797 and #800 had already broken the toast, file-menu and history loops.

`sharedPorts()` is retired. #793 split the shared ports by responsibility, and features now take named ports from `src/bootstrap/wiring/ports/` (actions, desktop, document, editing, effects, files, identity, location, panels, pictures, preferences, presence, production, project-files, rows, saving, screen, shot-hiding, startup, text, transitions). The name `sharedPorts` no longer appears in `src/`, `tests/` or `tools/`.

## What landed since the October 23 audit

Numbers missing from the range below did not land on `4.1-development` as their own PRs: #767, #781 and #785 were closed without merging (#788 replaced #781); #791 merged into #759's branch as its review fix; #799, #802 and #804 merged into `main`; #814 is an issue.

### Merged before the audited revision

These merged before `de712f8` and are already counted in the October 23 numbers. They are listed so the range #759 to #827 is complete.

| PR | Change |
| --- | --- |
| #760 | Design only: ports for the desktop port's members |
| #761 | `05r-read-time.js` → `features/rows/read-time.js` |
| #762 | Auto-save setter added to the saves port |
| #763 | Editor selection drop-link exposed through the shared ports |
| #764 | Export registry exposed through the shared ports |
| #765 | Recent files port (`application/files`) |
| #766 | Update port and external links port |
| #768 | Design only: the About dialog moves with update notices |
| #769 | About action → `features/update` |
| #770 | `20s-settings.js` → `features/settings/settings.js` |
| #771 | `09-find-replace.js` → `features/find/find.js` |
| #772 | `18c-export-dialog.js` → `features/file-menu/export-dialog.js` |
| #773 | `05t-target.js` → `features/rundown/target.js` |
| #774 | Launch facts shared port |
| #775 | File delivery shared port (`application/files`) |
| #776 | Undo history and replay rules → `application/editing/undo` |
| #777 | `12a-undo.js` deleted: owner in `application/editing/undo/undo.ts`, behind an undo bridge |
| #778 | `05e-gallery-overlay.js` → `features/gallery/overlay.js` |
| #779 | `05c-clipboard.js`, `05g-scene-clip.js`, `05h-scene-select.js` → `features/clipboard/`; `04c-doc-model.js` deleted |
| #780 | `01b-hide-shot.js` → `features/rows/hide-shot.ts` |
| #782 | Startup signal shared port |
| #783 | Last file shared port |
| #784 | `01-scene-status.js` → `features/rows/scene-status.ts` |
| #786 | `05v-video.js` → `features/gallery/video.js`, with the desktop video port in `application/media` |
| #787 | `10-comments.js` → `features/comments/comments.js` |
| #788 | `08c-broll.js` → `features/broll`; records reconciler → `application/production` |
| #789 | Scene commands, drop markers, row menus and pictures from `06-rows.js` → `features/rows/` (`scenes.js`, `row-menu.js`, `scene-media.js`) |

### Merged after the audited revision

| PR | Change |
| --- | --- |
| #759 | `20b-onboarding.js` → `features/onboarding/onboarding.js` |
| #790 | Docs: October 23 status audit and review policy |
| #792 | Tests: legacy shim guards split by responsibility |
| #793 | Shared ports split by responsibility into `bootstrap/wiring/ports/` |
| #794 | CI: tests sharded; document-test save setup fixed |
| #795 | `06-rows.js` deleted: video-file work → `features/gallery/video-files.js` with an application `VideoFiles` contract |
| #796 | Toast and B-roll export import loops broken; toast consumers import the effects bridge directly |
| #797 | Hosted and file-menu import loop broken |
| #798 | CI: the merge's push run is skipped when its tree already passed |
| #800 | History and sync import loop broken; `getEditorName` → `legacy/preferences-bridge.ts` |
| #801 | CI: Chromium reused; app CI work skipped for known non-app changes |
| #803 | Docs: `ci.md` tree-reuse wording |
| #805 | `onServerDoc` from `13-hosted.js` → `legacy/location-bridge.ts` |
| #806 | Tag-anchor rewriting → `adapters/richtext` |
| #807 | Duplicate application type definitions consolidated |
| #808 | `08d-broll-panel.js` → `features/broll/panel.js` |
| #809 | `18d-command-menu.js` → `features/command-menu/command-menu.js` |
| #810 | Desktop adapters and document state from `20f-desktop.js` → `adapters/desktop`, `application/desktop` |
| #811 | `20f-desktop.js` → `features/desktop/desktop.js` |
| #812 | Draft writer lock and desktop draft calls from `20g-drafts.js` → `adapters/storage` |
| #813 | `20g-drafts.js` → `application/recovery/drafts.js` |
| #815 | `20h-appdata.js` → `features/settings/app-data.js` |
| #816 | `20j-newtab.js` → `features/newtab/newtab.js` |
| #817 | `08-production-panels.js` → `features/tags/panels.js` |
| #818 | `04-richtext.js` deleted (consumers import from owners); `03b-side-panels.js` scroll hold → `features/panels/script-place.js` |
| #819 | Last import loop (`13-hosted` and `20e-connect`) broken through `legacy/pin-dialog.ts` |
| #820 | `20a-update.js` → `features/update/update.js` |
| #821 | `18b-file-menu.js` → `features/file-menu/file-menu.js` |
| #822 | Update results from disposed feature mounts ignored |
| #823 | Operation ownership contracts unified |
| #824 | Tag entity containers built in bootstrap wiring |
| #825 | `14b-export-kit.js` deleted: export capture → `application/save/export-kit.ts` |
| #826 | `00-prelude.js` and `02-state.js` deleted: page entry → `bootstrap/startup`, `adapters/page`, `adapters/files/last-file.ts`, `core/merge/state-fields.ts` |
| #827 | `20d-formats.js` deleted: project-file services → `application/save/project-files.ts` |
| #828 | `src/js/_starters.js` → `src/starters/index.ts` (not numbered; merged at the measured revision) |

## Remaining numbered files

Planned homes and waves are from the [feature-ports.md](feature-ports.md) table. Line counts are measured at `8020d38`. "Paused" means server and collaboration work is on hold; "open" means the move can be scheduled.

| File | Lines | Goes to | Wave | Status |
| --- | ---: | --- | ---: | --- |
| `02b-doc-id.js` | 234 | `application/` identity owner, adapters | 4 | open |
| `03-sync.js` | 681 | `application/session` merge, `features/merge`, `features/history` | 4 | open |
| `03a-history-store.js` | 1,402 | `adapters/storage`, `application/recovery` | 4 | open |
| `05-render.js` | 1,231 | `features/rows` | 3 | open |
| `07-production-tags.js` | 650 | `features/tags` | 3 | open |
| `07b-plain-tags.js` | 258 | `features/tags` | 3 | open |
| `11-import.js` | 511 | `features/imports`, `adapters/formats` | 4 | open |
| `12-dirty-toast.js` | 178 | `application/save`, `features/title` | 4 | open |
| `13-hosted.js` | 2,522 | `adapters/transport`, `application/collaboration`, `features/server` | 4 | paused |
| `13a-presence.js` | 253 | `features/collaboration` | 3 | paused |
| `13b-collaborate.js` | 904 | `features/collaboration` | 3 | paused |
| `14-export.js` | 292 | `application/save`, `adapters/files` | 4 | open |
| `18-local-files.js` | 577 | `adapters/files`, `application/transitions`, `features/file-menu` | 4 | open |
| `18a-local-merge.js` | 386 | `features/merge`, `src/core/merge` | 4 | open |
| `19-writer.js` | 378 | `features/writer` | 3 | open |
| `20-teleprompter.js` | 1,030 | `features/prompter` | 3 | open |
| `20e-connect.js` | 510 | `features/collaboration` | 3 | paused |

The paused files total 4,189 lines. The other 13 files total 7,808 lines.

## Recheck before the next assignment

Read the current remote branch and PR heads, then rerun the two metric commands. Counts here stay pinned to the measured revision; no pending change is counted as merged.
