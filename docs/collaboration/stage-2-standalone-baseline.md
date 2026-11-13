# Stage 2 standalone baseline

This is the recorded standalone baseline for the Stage 2 exit line in [COLLABORATION-PLAN.md](../COLLABORATION-PLAN.md) section 11: standalone behaviour and exports stay unchanged. Package 15 of issue #1414 repeats the three parts below on its own head and compares the results with these.

Recorded 2026-11-13 on the Windows PC, between 05:15 and 05:37 local time.

## Commits compared

| Role | Commit | Why |
| --- | --- | --- |
| Before Stage 2 (base) | `2e8e5c70c6369059d446b17a4ceec7cb33cad04d` | The first parent of `0b13f3152`, the merge of #1427 (`collab/s2-yjs-roots`, 2026-11-10). #1427 is the first Stage 2 pull request that adds production code: `src/adapters/collab/roots.ts` and the `yjs` dependency. The merges before it on main's first-parent history are tools, docs, prototypes or ordinary standalone fixes: #1420 adds the export comparison tool, #1415 is the review tier, #1418 and #1421 are prototypes, #1403 is the Stage 1a decision, and #1431 and #1432 fix standalone bugs |
| Current main (head) | `1bcd949f1fa66d089886aedbde0b4ac8028b1a8d` | main after the merge of #1524, 2026-11-13 |

## Conditions

| Item | Value |
| --- | --- |
| Machine | The Windows PC of [7-performance-baseline.md](stage-0/7-performance-baseline.md) section 1: 16 cores, 32 threads, 31 GB, Windows 11 Pro 10.0.26300 x64 |
| Node | v24.22.1 (repository pin) |
| Browser | Microsoft Edge 157.0.4341.46, headless, started by `driver.mjs` (which passes `--disable-features=...,msImplicitSignin`) |
| Dependencies | `npm ci` in the worktree at head; `perf-ab` and `export-ab` link those `node_modules` into their base checkouts |
| Locks | Each browser run held the machine's `smoke` lock through its lock wrapper (part 3 held `perf` and `smoke`), so no other browser suite, smoke or timing ran at the same time. Other agent sessions were running on the PC |
| Before part 3 | 9.4 GB free memory, no `msedge` process, no PC hold active |

## Part 1: export bytes

Command, from the head worktree, with `TEMP` and `TMP` set to a path without spaces:

```
node tools/export-ab.mjs 2e8e5c70c6369059d446b17a4ceec7cb33cad04d 1bcd949f1fa66d089886aedbde0b4ac8028b1a8d
```

Result: exit 0 after 15.6 s. The result line:

> Exports of 10 fixtures in 20 formats, base 2e8e5c70 against head 1bcd949f: every cell has identical compared bytes.

Declared exclusions: none. The capture clock was 2026-10-13T17:30:00.000Z and the wall clock 2030-01-02T03:04:05.678Z, as the tool sets them. The Standalone HTML page shell, which the tool reports without comparing, was 88,130 bytes on both sides for every fixture.

| Format | to-camera | interview | spot-30 | long-demo | crafted | canonical-attribute-cases | canonical-quoted-tag | canonical-quoted-who | canonical-special-keys | canonical-supplement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| .splitpage (save) | same | same | same | same | same | same | same | same | same | same |
| .md project (save) | same | same | same | same | same | same | same | same | same | same |
| .splitpage (export copy) | same | same | same | same | same | same | same | same | same | same |
| Markdown (.md, or .zip with images) | same | same | same | same | same | same | same | same | same | same |
| Markdown, two columns | same | same | same | same | same | same | same | same | same | same |
| Plain text (.txt write-back) | same | same | same | same | same | same | same | same | same | same |
| Word (.docx) | same | same | same | same | same | same | same | same | same | same |
| Narration (.docx) | same | same | same | same | same | same | same | same | same | same |
| Narration (.txt) | same | same | same | same | same | same | same | same | same | same |
| Spreadsheet (.xlsx) | same | same | same | same | same | same | same | same | same | same |
| Spreadsheet (.csv) | same | same | same | same | same | same | same | same | same | same |
| Breakdown (.xlsx) | same | same | same | same | same | same | same | same | same | same |
| Breakdown (.csv) | same | same | same | same | same | same | same | same | same | same |
| B-roll shot list (.xlsx) | same | same | same | same | same | same | same | same | same | same |
| B-roll shot list (.csv) | same | same | same | same | same | same | same | same | same | same |
| Standalone HTML: state, title, description | same | same | same | same | same | same | same | same | same | same |
| PDF: print page HTML | same | same | same | same | same | same | same | same | same | same |
| Gear packing list PDF: print page HTML | same | same | same | same | same | same | same | same | same | same |
| Props packing list PDF: print page HTML | same | same | same | same | same | same | same | same | same | same |
| B-roll shot list PDF: print page HTML | same | same | same | same | same | same | same | same | same | same |

The tool does not compare PDF bytes, the `.zip` export with the script's files, or the Standalone HTML outside its state, title and description. It names the tests that cover each of those.

## Part 2: full browser regression at head

Commands, from the head worktree:

```
node build.mjs --test
node tools/run-suites.mjs <out-dir> --lanes 3 --port-base 700
```

Plain mode: neither `SPLITPAGE_FREEZE_CACHES` nor `SPLITPAGE_DOCUMENT_GUARD` was set. Three lanes is the per-lane cap on this PC. The run took 8.8 minutes, wrapper included.

Result: 311 of 311 suites ran and 309 passed, with 12,238 of 12,242 checks passing. Runner exit 1.

| Suite | Checks | Result | Rerun alone at head | Alone at base | Known as |
| --- | --- | --- | --- | --- | --- |
| `109-rundown-lens-sweep-mixed.txt` | 4/5 | FAIL: `inOrder(__R.c_index_med)` got false | FAIL, same check | FAIL, same check | #1426 (the pointer sweep skips beats; it fails on the CI runner alone too) |
| `1201-audio-editor.txt` | 6/9 | FAIL: timeout waiting for `#rows [data-tags-open="true"]`, then `no element for: #rows [data-tags-open="true"] .tag-toolbar-choice[data-tag-cat="cast"]`, then `a(0).querySelector('[data-tag-cat="cast"] [data-tag-cat="sound"] [data-tag-cat="gear"]') !== null` got false | PASS 9/9 | PASS 9/9 | No issue. #1428 added a wait for `[data-tags-open="true"]` and records that the suite still fails sometimes under four-lane load and passes alone, cause not established. This run timed out on that wait |

Each failing suite was rerun once, alone (`--lanes 1`), at head. They were also run once at base, in a detached checkout of `2e8e5c70c` built with `node build.mjs --test`, with base's own runner and suites. Suite 109 fails the same way at base, so Stage 2 did not cause it. 1201-audio-editor fails only in the three-lane run.

The two known flakes, #1486 (suite 375, Writer markdown inputs) and #1488 (a desktop smoke check), did not show: suite 375 passed, and the desktop smoke is not part of this run.

### Every suite

Each suite's first `RESULT:` line from `summary.txt`.

| Suite | Result | Checks |
| --- | --- | --- |
| `01-core.txt` | PASS | 19/19 |
| `02-production.txt` | PASS | 26/26 |
| `03-exports.txt` | PASS | 43/43 |
| `04-prompter-find.txt` | PASS | 27/27 |
| `05-mobile.txt` | PASS | 79/79 |
| `06-writer.txt` | PASS | 64/64 |
| `07-untagged.txt` | PASS | 25/25 |
| `08-writer-width.txt` | PASS | 9/9 |
| `09-alt-enter-and-scroll.txt` | PASS | 22/22 |
| `10-comments-panel.txt` | PASS | 17/17 |
| `11-comments-sort-persist.txt` | PASS | 2/2 |
| `12-gear.txt` | PASS | 61/61 |
| `13-onboarding.txt` | PASS | 25/25 |
| `14-help.txt` | PASS | 22/22 |
| `15-tutorial.txt` | PASS | 86/86 |
| `17-formats.txt` | PASS | 68/68 |
| `19-save-conflict.txt` | PASS | 32/32 |
| `20-comment-drift.txt` | PASS | 43/43 |
| `21-desktop-shim.txt` | PASS | 78/78 |
| `22-doc-id.txt` | PASS | 100/100 |
| `23-doc-id-reload.txt` | PASS | 10/10 |
| `24-history.txt` | PASS | 153/153 |
| `25-history-migration.txt` | PASS | 50/50 |
| `26-desktop-drafts.txt` | PASS | 100/100 |
| `27-app-data.txt` | PASS | 101/101 |
| `28-autosave.txt` | PASS | 49/49 |
| `29-updates.txt` | PASS | 31/31 |
| `30-new-tab.txt` | PASS | 151/151 |
| `31-broll.txt` | PASS | 21/21 |
| `32-prompter-mirror.txt` | PASS | 46/46 |
| `33-drag-autoscroll.txt` | PASS | 19/19 |
| `34-desktop-app-data-export.txt` | PASS | 66/66 |
| `35-open-new-document.txt` | PASS | 67/67 |
| `36-newtab-recents.txt` | PASS | 69/69 |
| `38-newtab-phone.txt` | PASS | 20/20 |
| `40-comment-assign-filter.txt` | PASS | 58/58 |
| `41-export-polish.txt` | PASS | 132/132 |
| `42-local-merge.txt` | PASS | 114/114 |
| `45-broll-anchoring.txt` | PASS | 42/42 |
| `46-import-tag-prompt.txt` | PASS | 27/27 |
| `47-move-scene-keys.txt` | PASS | 48/48 |
| `48-hide-shot.txt` | PASS | 58/58 |
| `49-prompter-scene-mode.txt` | PASS | 32/32 |
| `50-panel-resize.txt` | PASS | 25/25 |
| `52-csp.txt` | PASS | 22/22 |
| `53-service-worker.txt` | PASS | 32/32 |
| `56-one-home.txt` | PASS | 19/19 |
| `58-prompter-open-in-browser.txt` | PASS | 88/88 |
| `60-file-menu.txt` | PASS | 151/151 |
| `61-transitions.txt` | PASS | 92/92 |
| `63-restore-notice.txt` | PASS | 15/15 |
| `65-blobs.txt` | PASS | 55/55 |
| `67-render-perf.txt` | PASS | 43/43 |
| `68-images.txt` | PASS | 31/31 |
| `69-html-images.txt` | PASS | 55/55 |
| `71-prompter-bar-wrap.txt` | PASS | 45/45 |
| `72-desktop-voice.txt` | PASS | 62/62 |
| `73-undo.txt` | PASS | 20/20 |
| `75-format-model.txt` | PASS | 47/47 |
| `76-tags-model.txt` | PASS | 41/41 |
| `77-clipboard-model.txt` | PASS | 51/51 |
| `78-split-join-model.txt` | PASS | 60/60 |
| `79-tag-panel-model.txt` | PASS | 46/46 |
| `80-broll-paste-ids.txt` | PASS | 58/58 |
| `81-draft-edit.txt` | PASS | 87/87 |
| `82-desktop-voice-clear.txt` | PASS | 24/24 |
| `83-voice-mic-name.txt` | PASS | 37/37 |
| `84-undo-caret.txt` | PASS | 18/18 |
| `85-header-fit.txt` | PASS | 123/123 |
| `86-gdocs-paste-bold.txt` | PASS | 5/5 |
| `87-voice-relay.txt` | PASS | 38/38 |
| `88-present-in-chromium.txt` | PASS | 15/15 |
| `90-voice-mic-blocked.txt` | PASS | 29/29 |
| `91-scene-gallery.txt` | PASS | 88/88 |
| `92-paste-into-gallery.txt` | PASS | 105/105 |
| `94-broll-panel.txt` | PASS | 108/108 |
| `95-broll-props.txt` | PASS | 49/49 |
| `96-broll-page.txt` | PASS | 81/81 |
| `97-broll-page-phone.txt` | PASS | 15/15 |
| `98-export-dialog.txt` | PASS | 200/200 |
| `99-command-menu.txt` | PASS | 86/86 |
| `100-rundown-minimize.txt` | PASS | 68/68 |
| `101-rundown-minimize-phone.txt` | PASS | 22/22 |
| `102-rundown-lens.txt` | PASS | 97/97 |
| `103-rundown-drop.txt` | PASS | 48/48 |
| `104-rundown-length.txt` | PASS | 87/87 |
| `105-rundown-length-widths.txt` | PASS | 27/27 |
| `106-rundown-length-phone.txt` | PASS | 30/30 |
| `107-rundown-lens-sweep-alternating.txt` | PASS | 6/6 |
| `108-rundown-lens-sweep-demo.txt` | PASS | 7/7 |
| `109-rundown-lens-sweep-mixed.txt` | FAIL | 4/5 |
| `110-rundown-click-scroll.txt` | PASS | 14/14 |
| `128-side-panels-modes.txt` | PASS | 154/154 |
| `130-name-popovers.txt` | PASS | 50/50 |
| `131-name-popovers-phone.txt` | PASS | 24/24 |
| `132-person-colours.txt` | PASS | 30/30 |
| `133-clock-format.txt` | PASS | 44/44 |
| `134-settings.txt` | PASS | 71/71 |
| `135-settings-reload.txt` | PASS | 22/22 |
| `140-target-length.txt` | PASS | 131/131 |
| `141-target-length-phone.txt` | PASS | 42/42 |
| `142-present-set-length.txt` | PASS | 13/13 |
| `145-export-colours.txt` | PASS | 27/27 |
| `150-mode-transitions.txt` | PASS | 132/132 |
| `155-stage-directions.txt` | PASS | 46/46 |
| `156-stage-directions-present.txt` | PASS | 56/56 |
| `160-gallery-video.txt` | PASS | 127/127 |
| `161-gallery-full-size.txt` | PASS | 55/55 |
| `162-gallery-thumbnail-on-click.txt` | PASS | 68/68 |
| `170-script-fields.txt` | PASS | 34/34 |
| `171-narrow-window.txt` | PASS | 13/13 |
| `172-script-zoom.txt` | PASS | 41/41 |
| `173-scene-length.txt` | PASS | 58/58 |
| `174-scene-length-phone.txt` | PASS | 20/20 |
| `180-tagging-card.txt` | PASS | 82/82 |
| `181-tagging-card-phone.txt` | PASS | 22/22 |
| `185-autosave-every-edit.txt` | PASS | 91/91 |
| `186-autosave-panel-edits.txt` | PASS | 97/97 |
| `187-autosave-status-words.txt` | PASS | 31/31 |
| `190-scene-select.txt` | PASS | 135/135 |
| `195-plain-tags.txt` | PASS | 133/133 |
| `196-plain-tags-phone.txt` | PASS | 14/14 |
| `197-plain-tags-existing-line.txt` | PASS | 39/39 |
| `198-mixed-tag-selection.txt` | PASS | 30/30 |
| `200-long-demo.txt` | PASS | 47/47 |
| `217b-tag-icons-boot.txt` | PASS | 7/7 |
| `217-tag-icons.txt` | PASS | 52/52 |
| `218-bulk-tag.txt` | PASS | 53/53 |
| `219-sound-cues.txt` | PASS | 35/35 |
| `240-bold-space-at-end.txt` | PASS | 5/5 |
| `241-cue-edit-keeps-item.txt` | PASS | 19/19 |
| `245-scene-cut-undo.txt` | PASS | 41/41 |
| `246-scene-delete-comments.txt` | PASS | 32/32 |
| `247-new-script-history.txt` | PASS | 31/31 |
| `250-panel-keeps-place.txt` | PASS | 29/29 |
| `251-panel-narrow-window.txt` | PASS | 36/36 |
| `253-phone-overlays.txt` | PASS | 21/21 |
| `255-find-keeps-focus.txt` | PASS | 50/50 |
| `256-scene-list-commas.txt` | PASS | 27/27 |
| `257-gallery-annotate.txt` | PASS | 144/144 |
| `258-gallery-annotate-phone.txt` | PASS | 23/23 |
| `259-xlsx-export.txt` | PASS | 91/91 |
| `260-about-and-platform.txt` | PASS | 17/17 |
| `260-create-bundle.txt` | PASS | 31/31 |
| `261-import-save-back-late-edit.txt` | PASS | 24/24 |
| `262-empty-scene-delete.txt` | PASS | 15/15 |
| `266-header-collab-condense.txt` | PASS | 57/57 |
| `267-writer-undo.txt` | PASS | 38/38 |
| `268-actions-every-surface.txt` | PASS | 35/35 |
| `269-file-actions-every-surface.txt` | PASS | 55/55 |
| `270-save-open-every-surface.txt` | PASS | 31/31 |
| `271-scene-length-effects.txt` | PASS | 15/15 |
| `272-view-actions-every-surface.txt` | PASS | 46/46 |
| `273-help-actions-every-surface.txt` | PASS | 31/31 |
| `274-more-actions-every-surface.txt` | PASS | 23/23 |
| `275-menu-refused-under-overlay.txt` | PASS | 295/295 |
| `276-availability-follows-state.txt` | PASS | 5/5 |
| `278-commands-as-before.txt` | PASS | 57/57 |
| `279-command-menu-listing.txt` | PASS | 12/12 |
| `280-comment-on-tag.txt` | PASS | 10/10 |
| `280-other-surfaces.txt` | PASS | 39/39 |
| `281-script-zoom-commands.txt` | PASS | 20/20 |
| `282-editor-operations.txt` | PASS | 44/44 |
| `283-save-status-by-destination.txt` | PASS | 36/36 |
| `284-exports-from-a-fixture.txt` | PASS | 27/27 |
| `285-save-buttons-one-state.txt` | PASS | 15/15 |
| `286-find-from-every-surface.txt` | PASS | 19/19 |
| `287-delete-person-broll-owner.txt` | PASS | 10/10 |
| `288-scene-status-effects.txt` | PASS | 103/103 |
| `289-script-cell-ime.txt` | PASS | 81/81 |
| `290-focus-emulation.txt` | PASS | 2/2 |
| `307-menu-dialogs-not-stacked.txt` | PASS | 74/74 |
| `309-present-modifier-keys.txt` | PASS | 36/36 |
| `311-reserved-ids.txt` | PASS | 66/66 |
| `316-production-outline.txt` | PASS | 39/39 |
| `321-writer-flow-lifecycle.txt` | PASS | 30/30 |
| `322-tag-all-emoji.txt` | PASS | 29/29 |
| `322-writer-flow-first-open.txt` | PASS | 13/13 |
| `323-tag-button-open.txt` | PASS | 116/116 |
| `323-writer-flow-undo.txt` | PASS | 17/17 |
| `324-tag-toolbar.txt` | PASS | 30/30 |
| `324-writer-flow-initialization-history.txt` | PASS | 25/25 |
| `325-writer-flow-composition-beat-isolation.txt` | PASS | 14/14 |
| `326-writer-flow-composed-heading-close.txt` | PASS | 11/11 |
| `327-writer-flow-composition-before-repaint.txt` | PASS | 12/12 |
| `328-writer-flow-composition-touched-input.txt` | PASS | 11/11 |
| `329-writer-flow-shortcuts.txt` | PASS | 23/23 |
| `330-writer-flow-ghost.txt` | PASS | 22/22 |
| `331-writer-flow-pending-marks.txt` | PASS | 10/10 |
| `332-writer-flow-leave-beat.txt` | PASS | 15/15 |
| `333-writer-flow-comment-jump.txt` | PASS | 9/9 |
| `334-writer-flow-held-selection.txt` | PASS | 16/16 |
| `335-writer-flow-format-ranges.txt` | PASS | 38/38 |
| `336-writer-flow-shift-selection.txt` | PASS | 17/17 |
| `337-writer-flow-repaint-range.txt` | PASS | 11/11 |
| `338-writer-flow-removed-endpoints.txt` | PASS | 16/16 |
| `339-writer-flow-input-targets.txt` | PASS | 20/20 |
| `340-writer-flow-destructive-selections.txt` | PASS | 78/78 |
| `341-writer-flow-join.txt` | PASS | 19/19 |
| `342-writer-flow-comment-restriction.txt` | PASS | 10/10 |
| `343-writer-flow-boundary-keys.txt` | PASS | 49/49 |
| `344-writer-flow-exact-boundaries.txt` | PASS | 17/17 |
| `345-writer-flow-join-refusals.txt` | PASS | 19/19 |
| `346-writer-flow-single-beat-selections.txt` | PASS | 23/23 |
| `347-writer-flow-shortened-endpoints.txt` | PASS | 8/8 |
| `348-writer-flow-exclusive-empty-endpoint.txt` | PASS | 35/35 |
| `349-writer-flow-clipboard.txt` | PASS | 19/19 |
| `350-writer-flow-clipboard-metadata.txt` | PASS | 22/22 |
| `351-writer-flow-clipboard-headers.txt` | PASS | 23/23 |
| `352-overlay-followups.txt` | PASS | 32/32 |
| `352-writer-flow-clipboard-placement.txt` | PASS | 27/27 |
| `353-writer-flow-clipboard-cut-endpoints.txt` | PASS | 19/19 |
| `354-writer-flow-clipboard-safety.txt` | PASS | 6/6 |
| `355-writer-flow-clipboard-beat-payload.txt` | PASS | 7/7 |
| `356-writer-flow-clipboard-multiple-headers.txt` | PASS | 11/11 |
| `357-writer-flow-clipboard-at-headers.txt` | PASS | 13/13 |
| `358-writer-flow-clipboard-replacement.txt` | PASS | 18/18 |
| `359-writer-flow-shared-bar.txt` | PASS | 11/11 |
| `360-writer-flow-toolbar.txt` | PASS | 16/16 |
| `361-writer-flow-comments.txt` | PASS | 18/18 |
| `362-writer-flow-selection-tools.txt` | PASS | 19/19 |
| `363-writer-flow-save-status.txt` | PASS | 18/18 |
| `364-writer-flow-window.txt` | PASS | 15/15 |
| `365-writer-flow-narrow-bar.txt` | PASS | 9/9 |
| `366-writer-flow-narration-export.txt` | PASS | 10/10 |
| `367-writer-flow-header-popovers.txt` | PASS | 10/10 |
| `370-writer-flow-find.txt` | PASS | 23/23 |
| `371-writer-flow-find-visuals.txt` | PASS | 17/17 |
| `372-writer-flow-find-safety.txt` | PASS | 13/13 |
| `373-writer-flow-inline-markdown.txt` | PASS | 20/20 |
| `374-writer-flow-heading-rules.txt` | PASS | 20/20 |
| `375-writer-flow-markdown-inputs.txt` | PASS | 17/17 |
| `376-writer-flow-heading-lines.txt` | PASS | 11/11 |
| `377-writer-flow-markdown-provenance.txt` | PASS | 11/11 |
| `380-frozen-caches.txt` | PASS | 4/4 |
| `381-document-guard.txt` | PASS | 5/5 |
| `384-browser-print.txt` | PASS | 36/36 |
| `385-section-headers.txt` | PASS | 66/66 |
| `386-section-outputs.txt` | PASS | 36/36 |
| `387-section-editor-reveals.txt` | PASS | 19/19 |
| `388-scene-numbering.txt` | PASS | 36/36 |
| `389-merge-review-numbering.txt` | PASS | 30/30 |
| `391-history-damaged.txt` | PASS | 16/16 |
| `392-history-export-damaged.txt` | PASS | 44/44 |
| `405-first-save-title.txt` | PASS | 34/34 |
| `424-paste-tracking-links.txt` | PASS | 37/37 |
| `457-toast-accessibility.txt` | PASS | 57/57 |
| `458-find-in-present.txt` | PASS | 57/57 |
| `459-cancelled-composition-redo.txt` | PASS | 6/6 |
| `459-find-keyboard-lock-fallback.txt` | PASS | 17/17 |
| `460-harness-fullscreen.txt` | PASS | 6/6 |
| `482-name-limit-caret.txt` | PASS | 19/19 |
| `513-repaint-recovery.txt` | PASS | 19/19 |
| `570-writer-flow-decorations.txt` | PASS | 15/15 |
| `571-writer-flow-visual-box.txt` | PASS | 26/26 |
| `572-writer-flow-visual-content.txt` | PASS | 14/14 |
| `573-writer-flow-display.txt` | PASS | 15/15 |
| `574-writer-flow-visual-lifecycle.txt` | PASS | 15/15 |
| `575-writer-flow-find-rich-replace.txt` | PASS | 13/13 |
| `576-writer-flow-find-refresh.txt` | PASS | 20/20 |
| `577-writer-flow-find-visual-box.txt` | PASS | 15/15 |
| `578-writer-flow-find-visual-replace.txt` | PASS | 10/10 |
| `579-writer-flow-empty-heading.txt` | PASS | 26/26 |
| `580-writer-flow-pending-heading.txt` | PASS | 23/23 |
| `581-writer-flow-heading-keys.txt` | PASS | 22/22 |
| `582-writer-flow-heading-protection.txt` | PASS | 19/19 |
| `583-writer-flow-protected-delimiters.txt` | PASS | 12/12 |
| `584-writer-flow-empty-heading-keys.txt` | PASS | 25/25 |
| `585-writer-flow-visual-heading-target.txt` | PASS | 24/24 |
| `586-writer-flow-visual-heading-refusals.txt` | PASS | 16/16 |
| `587-writer-flow-find-pending-heading.txt` | PASS | 18/18 |
| `588-writer-flow-save-retry.txt` | PASS | 11/11 |
| `589-writer-flow-idle-word-count.txt` | PASS | 8/8 |
| `590-writer-flow-combined-bar.txt` | PASS | 17/17 |
| `591-writer-flow-find-bar-controls.txt` | PASS | 8/8 |
| `594-writer-flow-visual-cost.txt` | PASS | 7/7 |
| `595-writer-flow-mode-position.txt` | PASS | 8/8 |
| `596-writer-flow-typing-work.txt` | PASS | 12/12 |
| `597-writer-flow-beat-menu.txt` | PASS | 20/20 |
| `598-writer-to-split-clipboard.txt` | PASS | 20/20 |
| `966-gear-rename-draft.txt` | PASS | 14/14 |
| `1098-gallery-picture-bytes.txt` | PASS | 12/12 |
| `1160-comment-dropdowns-dark.txt` | PASS | 5/5 |
| `1162-microphone-choice.txt` | PASS | 136/136 |
| `1166-header-name-lifetime.txt` | PASS | 17/17 |
| `1166-header-name-line.txt` | PASS | 78/78 |
| `1168-scene-heading-look.txt` | PASS | 28/28 |
| `1168-scene-heading-touch.txt` | PASS | 11/11 |
| `1169-scene-header-scaling.txt` | PASS | 140/140 |
| `1170a-scene-panels.txt` | PASS | 13/13 |
| `1170b-scene-production-gear.txt` | PASS | 24/24 |
| `1179-beat-multi-select.txt` | PASS | 96/96 |
| `1194-row-menu-move-header.txt` | PASS | 54/54 |
| `1197-ctrl-click-link.txt` | PASS | 42/42 |
| `1201-audio-editor.txt` | FAIL | 6/9 |
| `1201-editor-regressions.txt` | PASS | 26/26 |
| `1201-nested-consumers.txt` | PASS | 11/11 |
| `1201-nested-depth.txt` | PASS | 17/17 |
| `1201-nested-phone.txt` | PASS | 11/11 |
| `1201-nested-typing.txt` | PASS | 37/37 |
| `1201-tag-editor.txt` | PASS | 48/48 |
| `1206-link-press-drag.txt` | PASS | 20/20 |
| `1207-open-tags.txt` | PASS | 43/43 |
| `1207-writer-open-tags.txt` | PASS | 28/28 |
| `1211-beat-list-wrap.txt` | PASS | 5/5 |
| `1257-who-chip-editor.txt` | PASS | 41/41 |
| `1258-who-chip-writer.txt` | PASS | 33/33 |
| `1263-keyword-tag-autocomplete.txt` | PASS | 30/30 |
| `1264-tag-starter.txt` | PASS | 24/24 |
| `1265-production-scene-label.txt` | PASS | 7/7 |
| `1326-scene-prep-rename.txt` | PASS | 9/9 |

## Part 3: performance base

Command, from the head worktree, holding the `perf` and `smoke` locks, with nothing else of this package running:

```
node tools/perf-ab.mjs 2e8e5c70c6369059d446b17a4ceec7cb33cad04d 1bcd949f1fa66d089886aedbde0b4ac8028b1a8d --only short,long --rounds 5
```

Both builds are `node build.mjs --test` and use head's recorder, alternating base then head for five rounds. The run took 9.9 minutes and exited 0.

The tolerance is the one fixed in [7-performance-baseline.md](stage-0/7-performance-baseline.md) section 6, recomputed from this A/B's own base runs. A case fails when the head median is greater than the base median plus T. T is the largest of three numbers: the base runs' max minus min, 15% of the base median, and the floor (0.5 ms for any p50; 3 ms for typing p95). The absolute limits in `tools/perf-ab.mjs` also apply: 8 ms typing p50, 65 ms new scene, 45 ms short undo and 70 ms long undo.

### Medians of 5 runs, p50 unless marked (ms)

| Case | Base | Head | Base range | T | Limit (base + T) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| short typing | 2.4 | 2.4 | 0.4 | 0.5 | 2.9 | within |
| short typing p95 | 15.2 | 14 | 6.1 | 6.1 | 21.3 | within |
| short split open tag spaces | 7 | 8.8 | 7.1 | 7.1 | 14.1 | within |
| short split open tag name | 3.2 | 4.3 | 6.1 | 6.1 | 9.3 | within |
| short writer open tag spaces | 9.5 | 6.5 | 6.9 | 6.9 | 16.4 | within |
| short writer open tag name | 2.6 | 2.5 | 0.5 | 0.5 | 3.1 | within |
| short new scene | 20.3 | 16.7 | 5.3 | 5.3 | 25.6 | within |
| short delete every scene | 7.3 | 7.3 | 0.4 | 1.1 | 8.4 | within |
| short undo the delete | 10.3 | 10.2 | 0.5 | 1.55 | 11.85 | within |
| long typing | 2.6 | 2.6 | 0.6 | 0.6 | 3.2 | within |
| long typing p95 | 15.4 | 15.8 | 1.8 | 3 | 18.4 | within |
| long split open tag spaces | 3.3 | 3.3 | 5.3 | 5.3 | 8.6 | within |
| long split open tag name | 2.8 | 2.9 | 2.9 | 2.9 | 5.7 | within |
| long writer open tag spaces | 6.2 | 7.1 | 7.4 | 7.4 | 13.6 | within |
| long writer open tag name | 2.9 | 2.9 | 1.1 | 1.1 | 4 | within |
| long new scene | 25.6 | 26 | 4.4 | 4.4 | 30 | within |
| long delete every scene | 9.7 | 10 | 0.8 | 1.45 | 11.15 | within |
| long undo the delete | 26.3 | 27.1 | 1.5 | 3.94 | 30.24 | within |
| long stamp a scene | 7.1 | 7.1 | 0.4 | 1.06 | 8.16 | within |
| long hide shot scenes | 15.8 | 16 | 0.9 | 2.37 | 18.17 | within |
| long display preference | 15.8 | 15.9 | 0.3 | 2.37 | 18.17 | within |
| short export .splitpage | 0.5 | 0.5 | 0 | 0.5 | 1 | within |
| short export .md project | 0.9 | 0.9 | 0.3 | 0.5 | 1.4 | within |
| short export Standalone HTML | 0.4 | 0.4 | 0 | 0.5 | 0.9 | within |
| long export .splitpage | 4.6 | 4.6 | 0.4 | 0.69 | 5.29 | within |
| long export .md project | 4.6 | 4.7 | 0.2 | 0.69 | 5.29 | within |
| long export Standalone HTML | 1.9 | 1.8 | 0.2 | 0.5 | 2.4 | within |

Every case is within T. Every head value is also under its absolute limit: typing p50 2.4 and 2.6 ms against 8, new scene 16.7 and 26 ms against 65, and undo 10.2 ms against 45 and 27.1 ms against 70. No case is faster than base by more than its T, so no result needs checking for a measurement fault.

### Every run (ms, base then head, in execution order)

| Case | Base runs p50 / p95 | Head runs p50 / p95 |
| --- | --- | --- |
| short typing | 2.1, 2.5, 2.5, 2.4, 2.4 / 17, 12.9, 10.9, 15.2, 16.9 | 2.4, 2.4, 2.5, 2.4, 2.6 / 13.1, 16, 14, 13.9, 17.3 |
| short split open tag spaces | 12.6, 7, 5.5, 6.7, 9.4 / 19.2, 16.1, 17.6, 17.3, 17.3 | 6.8, 10.4, 9.1, 7.8, 8.8 / 20.8, 16.5, 17.3, 17.4, 17.1 |
| short split open tag name | 8.4, 7, 2.4, 2.3, 3.2 / 18.4, 16.9, 19.6, 17.8, 16.9 | 4.3, 2.5, 2.8, 6.4, 9.4 / 17.6, 17.6, 18.5, 18.7, 18.8 |
| short writer open tag spaces | 9.5, 9.6, 2.8, 9.7, 8.1 / 28.4, 18.1, 28.5, 20.3, 16.1 | 12.2, 5.2, 6.5, 7.9, 2.6 / 25.1, 18.9, 16.7, 15.4, 16.9 |
| short writer open tag name | 2.3, 2.7, 2.6, 2.8, 2.4 / 12.7, 17, 16.6, 14.1, 14.2 | 2.5, 2.4, 2.5, 2.2, 4.3 / 13.4, 11.5, 15.8, 11.6, 17.9 |
| short new scene | 19.7, 15.9, 20.3, 21.2, 20.7 / 35, 19.7, 32, 32.9, 30.7 | 21.1, 14.9, 14.9, 18.3, 16.7 / 27.8, 26.7, 28.2, 41, 26.7 |
| short delete every scene | 6.9, 7.3, 7.2, 7.3, 7.3 | 7.3, 7.3, 7.1, 7.3, 7.1 |
| short undo the delete | 10.3, 10.4, 10.3, 9.9, 10.1 | 10.2, 10.1, 10.4, 10.4, 10.1 |
| long typing | 2.2, 2.8, 2.7, 2.6, 2.6 / 15.4, 14.8, 15.4, 16.6, 15.1 | 2.8, 2.7, 2.5, 2.6, 2.6 / 16.7, 15.8, 15.8, 16.1, 15.6 |
| long split open tag spaces | 6.3, 2.9, 3.3, 8.2, 3.1 / 16.4, 11.4, 24.2, 22.8, 11.8 | 2.7, 3.3, 4.8, 3, 5.3 / 11.6, 15.6, 15.3, 17.1, 16.4 |
| long split open tag name | 5.6, 2.7, 3, 2.7, 2.8 / 17.1, 6, 17.4, 5.7, 9.2 | 2.9, 3.1, 3.1, 2.5, 2.7 / 13.6, 14.3, 17.4, 17.9, 14.5 |
| long writer open tag spaces | 10.7, 4.4, 6.2, 3.3, 10.1 / 30.4, 17.4, 27.7, 27.9, 16.8 | 9.9, 7.1, 3.4, 3.2, 7.7 / 24.7, 26.9, 16.9, 25.8, 33.1 |
| long writer open tag name | 2.6, 2.9, 3.7, 3.2, 2.9 / 17, 4.8, 17.7, 9.4, 16.5 | 4.2, 3, 2.7, 2.9, 2.9 / 16.8, 12.5, 8.8, 11.4, 16.3 |
| long new scene | 29.5, 28.7, 25.1, 25.3, 25.6 / 54, 52.2, 27.3, 49.8, 31.9 | 31.4, 26, 26.4, 25.1, 25.5 / 52.2, 26.6, 31.6, 27, 27.5 |
| long delete every scene | 8.9, 9.7, 9.6, 9.7, 9.7 | 10, 10.3, 9.6, 9.8, 10.1 |
| long undo the delete | 26.6, 27, 25.5, 26.3, 26.3 | 27.2, 25.5, 26.6, 27.1, 27.1 |
| long stamp a scene | 6.8, 7.2, 7.1, 7.2, 7.1 / 19.9, 7.6, 10.3, 7.5, 8.8 | 7, 7.1, 7.1, 7.1, 7.2 / 7.2, 11.1, 7.9, 7.8, 7.5 |
| long hide shot scenes | 16.2, 15.7, 15.3, 15.8, 16 / 18, 16.7, 17, 16.6, 17.7 | 16, 16, 15.9, 16.1, 15.9 / 16.9, 16.9, 17.5, 17, 16.8 |
| long display preference | 15.8, 15.8, 15.8, 16.1, 15.9 / 17.2, 17.4, 20.3, 17.4, 16.6 | 16.1, 16.1, 15.8, 15.8, 15.9 / 18.7, 17.9, 16.3, 17.5, 19.3 |
| short export .splitpage | 0.5, 0.5, 0.5, 0.5, 0.5 | 0.5, 0.5, 0.5, 0.5, 0.4 |
| short export .md project | 0.9, 1, 1, 0.9, 0.7 | 0.9, 1, 0.9, 0.9, 1 |
| short export Standalone HTML | 0.4, 0.4, 0.4, 0.4, 0.4 | 0.4, 0.4, 0.4, 0.6, 0.4 |
| long export .splitpage | 4.7, 4.8, 4.6, 4.4, 4.5 | 4.6, 4.4, 4.6, 4.6, 4.7 |
| long export .md project | 4.6, 4.6, 4.8, 4.6, 4.6 | 4.8, 4.5, 4.7, 4.6, 4.7 |
| long export Standalone HTML | 2, 1.8, 1.9, 1.9, 2 | 1.8, 1.9, 1.9, 1.8, 1.8 |

Delete and undo have one key, so p95 equals p50 and is left out. `Range.getClientRects` calls were the same in every run of both builds: 80 for each spaces case, 40 for each name case, and 0 for every other case.

### Gaps against the section 6 rules

- `perf-ab` does not print the CPU busy reading for each run, so the "over 35% busy voids a run" rule could not be applied run by run. Free memory and the `msedge` check were read once, before the run (Conditions).
- The `footprint`, `footprint-long` and `large` fixtures are outside `perf-ab` (section 2 of the Stage 0 audit) and were not run. Load, heap, open and the `large` cases have no base-to-head comparison here.

## Findings

1. Exports: none. All 200 compared cells are identical between base and head.
2. Browser regression: two suites failed at head, neither caused by Stage 2:
   - Suite 109 fails at base too, alone and in the full run (#1426).
   - 1201-audio-editor failed only in the three-lane run. It passed alone at head and at base. It has no issue; #1428 records the same failure under load.
3. Performance: no case is outside its tolerance, and every case is under its absolute limit.

## Repeating this for package 15

Use the same base commit with package 15's head, on the same machine and Edge build, or re-record the base first as section 6 of the Stage 0 audit requires. Run the three commands above in this order: `export-ab`, then the build and `run-suites` under the `smoke` lock, then `perf-ab` alone under `perf` and `smoke`. Rerun each failing suite once alone at head and once at base. Compute T from the new A/B's own base runs.
