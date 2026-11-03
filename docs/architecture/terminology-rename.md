# Terminology rename inventory

This inventory is for PR 2 of #1186. Old "scene" means beat and old "section" means scene. Internal names can change, but the following boundaries must keep their wire names. Line numbers refer to the source at the time of this inventory. Preserve old readers as well as writers; snapshots and clipboard payloads can outlive the process that wrote them.

## Saved and external boundaries

| Name or surface | Decision and evidence |
| --- | --- |
| `sections`, `firstSceneId` | **Stay.** Saved scene headers and the ID of their first beat: `src/core/document/fields.ts:57`, `src/core/document/scenes.ts:20`, `src/core/document/scenes.ts:73`. |
| `brollShots`; row and B-roll status `"shot"`; B-roll `"unshot"` | **Stay.** Records and status identifiers are document data: `src/core/document/fields.ts:50`, `src/core/document/timing.ts:1`, `src/core/document/broll.ts:6`, `src/core/document/validated.ts:39`. |
| `.broll-key`, `data-broll-id` | **Stay.** These are serialized in cell HTML, not just styling: `docs/DOCUMENT-MODEL.md:33`, `src/core/production/broll.ts:230`; `src/test/doc-model.test.mjs:321` asserts the HTML. |
| `splitpage-hide-shot`, `splitpage-prompter-scene-mode` | **Stay.** Preference storage keys read and written by `src/application/preferences/preferences.ts:21`, `:26`, `:281`. |
| `hideShot`, `prompterSceneMode` | **Stay in app-data preferences.** Export/import uses these names: `src/application/preferences/preferences.ts:151`, `:154`, `:341`; bundle export/import: `src/features/settings/app-data.ts:71`, `:284`. Internal accessor names can change behind the boundary. |
| B-roll view values `scene`, `shot`, `unshot` | **Stay in stored preference.** The view owner serializes and reads `group`, `pageGroup`, `filter` at `src/application/preferences/broll-view.ts:24`, `:26`, `:31`; valid values are `src/core/production/broll-view.ts:42`, `:49`, `:152`; storage is `src/bootstrap/wiring/preferences-owner.ts:35`, `:94`. |
| Draft, recovery and history document fields above | **Stay.** Draft capture writes the whole document and restoration parses/migrates it: `src/application/recovery/drafts.ts:179`, `:335`, `src/application/recovery/draft-restore.ts:78`. Conflict stash writes/reads its payload at `src/application/recovery/conflict-stash.ts:81`, `:88`. History serializes state and stores/reads `stateJson` at `src/application/recovery/history.ts:191`, `:198`, `:311`, `src/adapters/storage/history-backends.ts:266`, `:318`. |
| `splitpage-snapshots`, `snapshots`, `snapshotId`, `splitpage:history-get` | **Stay.** These contain "shot" as part of snapshot and are external storage/IPC names, not terminology to rename: `src/application/recovery/legacy-snapshots.ts:3`, `src/features/settings/app-data.ts:48`, `:273`, `desktop/ipc-channels.ts:30`, `:88`, `desktop/preload.ts:218`, `desktop/ipc-history-blob.ts:74`. |
| `application/x-splitpage-scenes`, `data-splitpage-scenes`, `splitpage-scenes`, `brollShots` | **Stay.** Clipboard MIME, HTML fallback, format marker and payload: `src/features/clipboard/beat-clip.ts:46`, `:100`, `:123`, `:178`, `:190`, `:211`. |
| `application/x-splitpage-section` | **Stay.** Drag data is an external DataTransfer type: `src/features/rows/scene-controls.ts:151`. |
| `toggle-hide-shot`, `go-to-scene` | **Stay.** Action IDs are registered at `src/features/rows/actions.ts:33`, `src/features/rundown/actions.ts:34`; the desktop menu sends `toggle-hide-shot` at `desktop/main.ts:1681`. Keep IDs even if labels and internal functions change. |
| CSV/DOCX legacy headings and recognizers | **Keep reading old names.** CSV recognizes `scene` and `shot` on import at `src/adapters/formats/csv.ts:193`, `:209`; DOCX recognizes visual `shot` and generated headings including `B-roll shot list` at `src/adapters/formats/docx.ts:1028`, `:1032`, `:1042`. Visible exported wording can change in PR 4 only with compatible import. |
| XLSX `Scene` and `Scenes` column headings | **Stay.** These exported headers are also keys when workbook rows are read by the round-trip tests. |
| `__sceneSelectTest` and its tracking `scene` field | **Stay.** Browser suites use this test hook to exercise scene selection. |
| `__perfScene` | **Stay.** The performance suite's generated script and its test exchange this hook name. |
| Test fixture keys `sceneLength` and `scene` | **Stay.** The normalizer golden records use `sceneLength`; print-layout fixture data uses `scene`. |
| URLs | **No scene/section/shot URL parameter found.** The present-mode URL reader uses `teleprompter`, `script`, `voice`: `src/features/prompter/prompter.ts:1028`. Keep existing links readable; no terminology-bearing URL was identified. |

Project files write and parse the same document state through `src/adapters/formats/project-file.ts:71`, `:114`, `:307`; the embedded JSON keys above therefore stay.

## Import and paste compatibility

New exports can use the new wording, but import and paste readers must continue recognizing the old wording and styles. Add new recognizers alongside these when needed; changing export text alone must not make old files ambiguous or import their scaffolding as content.

| Existing reader input | Decision, writer and reader |
| --- | --- |
| DOCX run style `SplitpageSceneNo` | **Stay.** Narration export writes it at `src/adapters/formats/docx.ts:861`, `:893`, `:1358`. Import drops the styled scene-number run via `isDroppedRun` at `src/adapters/formats/docx.ts:926`, used at `:940`, `:1004`. Without the reader, old exported numbers become narration text. |
| DOCX `SplitpageBroll`, `SplitpageMarker` | **Stay.** The writer emits B-roll and comment marker styles at `src/adapters/formats/docx.ts:174`, `:206`, `:230`, `:1354`; the reader drops marker runs and recognizes the B-roll style at `:926`, `:951`. Preserve the B-roll atom when importing old files. |
| DOCX visual columns `shot`, `shots`, `b-roll`; breakdown headers with `scenes`; `B-roll shot list` | **Keep recognizing.** Table detection recognizes visual labels and rejects breakdown tables at `src/adapters/formats/docx.ts:1028`, `:1031`, `:1066`. The appendix cutoff recognizes old heading text at `:1042`, `:1059`; its writer is `:570`. Otherwise appendices can be imported as script. |
| Markdown stacked `### Scene N`, `_N scenes ..._`, `_(blank scene)_` | **Keep recognizing.** Stacked text import reads heading, metadata and blank placeholder at `src/adapters/formats/import-text.ts:43`, `:44`, `:55`, `:90`; export writes scene headings and blank placeholder at `src/adapters/formats/export-text.ts:275`, `:305`, with summary at `:260`. |
| Markdown stacked facts, visual lead and media | **Keep recognizing.** Import strips old `Read` facts, `*Visual ...*`, `![visual ...](images/...)` and video metadata at `src/adapters/formats/import-text.ts:45`, `:47`, `:48`, `:80`; corresponding export at `src/adapters/formats/export-text.ts:275`, `:280`, `:291`. The old image paths `images/scene-N...` are written at `:223`, `:238`; accept old image references when importing. |
| Markdown table and tab column `scene` / `shot`; old stacked section + `### Scene ...`; `## B-roll shot list` | **Keep recognizing.** `src/adapters/formats/markdown-table.ts:12`, `:15`, `:17`, `:19`, `:24`, `:48`, `:60` control column selection, section recognition and appendix truncation. Tab and stacked imports reuse them at `src/adapters/formats/import-text.ts:2`, `:102`, `:158`. Markdown writer emits the appendix at `src/adapters/formats/export-text.ts:174`. |
| Labeled text `Scene:`, `Shot:`, `B-roll:` | **Keep recognizing.** Detection and parsing use `VISUAL_LABEL_RE` at `src/adapters/formats/import-text.ts:19`, `:35`, `:125`; this accepts user-authored text, not just exports. |
| CSV `Scene` / `Shot` header and exported `Comments` boundary | **Keep recognizing.** `src/adapters/formats/csv.ts:193`, `:196`, `:209`, `:215` identify columns and stop before the comments appendix for old exports. The current writer emits `Scene` at `:41`. |
| Rich-text B-roll marker text and HTML | **Keep recognizing.** `B-roll:` and accepted variants are parsed by `src/core/document/broll.ts:27`; serialized `broll-key` / `data-broll-id` are written at `src/core/text/html.ts:42` and decoded and sanitized at `src/adapters/richtext/decode.ts:60`, `src/adapters/richtext/sanitize.ts:374`. The B-roll anchor reader/writer also uses the marker at `src/adapters/production/broll-anchors.ts:68`, `:93`, `:126`. Paste and stored HTML both depend on this. |

## DOM and test selectors

The following CSS selectors and data attributes contain the old words. They **can change together** with producers, consumers, styles and tests, except serialized cell HTML and clipboard attributes listed above, which **stay**. The test column lists literal occurrences, including fixture and browser checks; inspect each before renaming. "No direct literal" does not prove there is no indirect use. The list includes identifiers containing "snapshot", which should not be mistaken for the old status.

| Selector or attribute | First source occurrence | Tests with a literal occurrence |
| --- | --- | --- |
| `.broll-group-scene` | src/features/broll/styles.css:121 | src/test/split-join-app.test.mjs:398 |
| `.broll-page-c-shot` | src/features/broll/styles.css:406 | No direct literal found |
| `.broll-page-group-scene` | src/features/broll/styles.css:393 | No direct literal found |
| `.broll-page-scene` | src/features/broll/styles.css:410 | No direct literal found |
| `.broll-page-w-scene` | src/features/broll/styles.css:378 | No direct literal found |
| `.broll-page-w-shot` | src/features/broll/styles.css:377 | No direct literal found |
| `.broll-scene-link` | src/features/broll/styles.css:231 | No direct literal found |
| `.hidden-shot-hint` | src/styles/components.css:474 | No direct literal found |
| `.hidden-shot-strip` | src/features/writer/styles.css:1 | src/test/screen-listens-app.test.mjs:196, tests/features/rows/routes.test.ts:19, tests/features/rows/row-motion.test.ts:72 |
| `.history-scenes` | src/features/history/styles.css:54 | No direct literal found |
| `.is-scene-selecting` | src/styles/layout.css:126 | No direct literal found |
| `.is-shot` | src/features/broll/styles.css:51 | No direct literal found |
| `.pp-scene-pos` | src/features/prompter/styles-bar-rundown.css:224 | No direct literal found |
| `.pp-scene-readout` | src/features/prompter/styles-bar-rundown.css:176 | tests/features/prompter/runtime-mount.test.ts:93 |
| `.pp-scene-start` | src/features/prompter/styles-bar-rundown.css:225 | No direct literal found |
| `.pp-section` | src/features/prompter/styles-bar-rundown.css:227 | No direct literal found |
| `.pv-lamp-shot` | src/styles/components.css:1335 | No direct literal found |
| `.pv-rd-shot` | src/styles/components.css:1341 | No direct literal found |
| `.rd-section` | src/styles/components.css:1940 | No direct literal found |
| `.rundown-sections` | src/styles/components.css:1938 | No direct literal found |
| `.scene` | src/styles/layout.css:78 | src/features/file-menu/ports.test.ts:52, src/features/settings/ports.test.ts:47, src/test/apply-merge.test.mjs:106, src/test/broll-model.test.mjs:30, src/test/broll-mount-app.test.mjs:125, src/test/browser-pdf-app.test.mjs:42, src/test/clipboard.test.mjs:92, src/test/comment-images-export.test.mjs:40, src/test/css-aggregation.test.mjs:51, src/test/cut-paste-app.test.mjs:144, src/test/directions.test.mjs:292, src/test/document-guard.test.mjs:14, src/test/docx-reimport.test.mjs:226, src/test/editor-open-actions-app.test.mjs:23, src/test/entry-fuzz-app.test.mjs:249, src/test/export-capture-app.test.mjs:48, src/test/export-kit-services.test.mjs:45, src/test/export-kit.test.mjs:21, src/test/export-projections.test.mjs:21, src/test/export-text-captures.test.mjs:33, src/test/exports-golden.test.mjs:56, src/test/find-present-app.test.mjs:126, src/test/fold-into-edit-app.test.mjs:121, src/test/formats.test.mjs:44, src/test/gallery.test.mjs:65, src/test/import-no-write-back-app.test.mjs:50, src/test/import-rows.test.mjs:98, src/test/list-pdfs.test.mjs:18, src/test/local-merge-ids.test.mjs:40, src/test/long-demo.test.mjs:35, src/test/m4-matrix-continuations.test.mjs:155, src/test/m4-matrix-files.test.mjs:101, src/test/m4-matrix-recovery.test.mjs:371, src/test/m4-matrix-session.test.mjs:69, src/test/media-cell-app.test.mjs:182, src/test/media-routes-app.test.mjs:113, src/test/merge-golden.test.mjs:391, src/test/merge-states.test.mjs:37, src/test/migrate-rows.test.mjs:28, src/test/normalisers-golden.test.mjs:383, src/test/orphan-records-app.test.mjs:271, src/test/panels-listen-app.test.mjs:20, src/test/readers.test.mjs:123, src/test/remaining-rows-app.test.mjs:199, src/test/render-focus-app.test.mjs:87, src/test/render-guard-app.test.mjs:312, src/test/render-mount-app.test.mjs:37, src/test/render-no-edit-app.test.mjs:220, src/test/repair-on-read-app.test.mjs:172, src/test/reserved-ids-views.test.mjs:18, src/test/reserved-ids.test.mjs:57, src/test/route-rollback-app.test.mjs:16, src/test/rows-commands-app.test.mjs:107, src/test/rows-drag-dispose-app.test.mjs:48, src/test/rundown.test.mjs:75, src/test/save-coordinator-app.test.mjs:60, src/test/save-failure-recovery-app.test.mjs:53, src/test/save-label-late-app.test.mjs:84, src/test/beat-clip.test.mjs:16, src/test/beat-clipboard-app.test.mjs:13, src/test/beat-effects-app.test.mjs:9, src/test/beat-effects-order.test.mjs:8, src/test/beat-effects-undo.test.mjs:15, src/test/beat-length.test.mjs:76, src/test/screen-listens-app.test.mjs:13, src/test/scene-outputs.test.mjs:12, src/test/scenes-app.test.mjs:53, src/test/selection-model-app.test.mjs:153, src/test/session-bridge-unwired.test.mjs:8, src/test/session-change-listeners.test.mjs:7, src/test/session-commit-app.test.mjs:10, src/test/session-video-files.test.mjs:85, src/test/split-join-app.test.mjs:179, src/test/stable-row-ids-app.test.mjs:50, src/test/starters.test.mjs:65, src/test/text-cuts-app.test.mjs:20, src/test/text-editing-app.test.mjs:388, src/test/text-exports.test.mjs:44, src/test/undo.test.mjs:140, src/test/video-commands-app.test.mjs:95, src/test/wording.test.mjs:32, src/test/writer-commands-app.test.mjs:164, src/test/xlsx-export.test.mjs:92, src/test/_fanout-stubs.mjs:96, src/test/_load-order-hooks.mjs:37, tests/adapters/formats/export-tables.test.mjs:22, tests/adapters/formats/fixtures/inspect-script-print.mjs:355, tests/adapters/formats/fixtures/write-list-print-fixtures.mjs:12, tests/adapters/formats/list-print.test.mjs:31, tests/adapters/formats/markdown-table-edges.test.mjs:8, tests/adapters/formats/markdown-table.test.mjs:93, tests/adapters/formats/project-file.test.ts:76, tests/adapters/formats/script-print.test.mjs:10, tests/adapters/formats/scene-printed-layout.test.mjs:13, tests/adapters/formats/xlsx-round-trip.test.mjs:20, tests/application/actions.test.ts:130, tests/application/broll-view.test.ts:18, tests/application/capture.test.ts:43, tests/application/cell-text-edges.test.ts:45, tests/application/cell-text.test.ts:121, tests/application/clipboard.test.ts:222, tests/application/document-edits.test.ts:336, tests/application/document-session.test.ts:23, tests/application/editing/cell-editing.test.ts:141, tests/application/editing/focus-memory.test.ts:7, tests/application/editing/row-drag.test.ts:5, tests/application/editing/selection.test.ts:56, tests/application/entry-fuzz.test.ts:75, tests/application/export-kit.test.ts:75, tests/application/gallery.test.ts:61, tests/application/import-rows.test.ts:61, tests/application/panel-state.test.ts:24, tests/application/preferences/preferences.test.ts:41, tests/application/production/broll-records.test.ts:64, tests/application/project-files.test.ts:177, tests/application/recovery/identity-replacement.test.ts:50, tests/application/rows-edges.test.ts:24, tests/application/rows.test.ts:53, tests/application/beat-fields-edges.test.ts:3, tests/application/beat-length.test.ts:5, tests/application/beat-status.test.ts:5, tests/application/beats-edges.test.ts:3, tests/application/beats.test.ts:7, tests/application/scenes.test.ts:5, tests/application/session-commit.test.ts:16, tests/application/session-records.test.ts:16, tests/application/session-replay.test.ts:22, tests/application/split-join-edges.test.ts:23, tests/application/split-join.test.ts:126, tests/application/title.test.ts:45, tests/bootstrap/action-order.test.ts:26, tests/bootstrap/wiring.test.ts:49, tests/core/document/comments.test.ts:35, tests/core/document/export-document.test.ts:30, tests/core/document/fields.test.ts:102, tests/core/document/media.test.ts:222, tests/core/document/timing.test.ts:17, tests/core/merge/review.test.ts:24, tests/core/merge/rows-property.test.ts:10, tests/core/merge/shape.test.ts:55, tests/core/migrate-fields.test.ts:46, tests/core/migrate.test.ts:17, tests/core/production/broll-view.test.ts:10, tests/core/production/broll.test.ts:343, tests/core/production/tags.test.ts:289, tests/core/production/timing.test.ts:36, tests/core/scenes-property.test.ts:9, tests/core/scenes.test.ts:13, tests/core/text/selection.test.ts:142, tests/features/broll/mount.test.ts:21, tests/features/broll/panel-mount.test.ts:74, tests/features/clipboard/copy-paste.test.ts:7, tests/features/clipboard/routes.test.ts:40, tests/features/editing/focus.test.ts:103, tests/features/file-menu/browser-pdf.test.mjs:26, tests/features/file-menu/desktop-pdf.test.mjs:30, tests/features/file-menu/dropdown-mount.test.ts:140, tests/features/file-menu/export-again.test.ts:54, tests/features/file-menu/local-files-lifetime.test.ts:38, tests/features/file-menu/local-files-mount.test.ts:21, tests/features/gallery/overlay.test.ts:44, tests/features/gallery/video-files.test.ts:110, tests/features/media/routes.test.ts:75, tests/features/prompter/mount.test.ts:76, tests/features/prompter/runtime-mount.test.ts:21, tests/features/routing/root-router.test.ts:51, tests/features/rows/editor.test.ts:93, tests/features/rows/hide-shot.test.ts:39, tests/features/rows/read-time.test.ts:35, tests/features/rows/render-mount.test.ts:61, tests/features/rows/routes.test.ts:81, tests/features/rows/beat-status.test.ts:8, tests/features/rows/beats.test.ts:11, tests/features/rows/scene-controls.test.ts:42, tests/features/rundown/mount.test.ts:59, tests/features/tags/mount.test.ts:149, tests/features/undo/routes.test.ts:218, tests/legacy/overlay-availability.test.ts:136, tests/starters/index.test.ts:18, desktop/test/smoke.mjs:3807 |
| `.scene-gallery` | src/features/gallery/styles-tiles-and-modal.css:1 | desktop/test/smoke.mjs:3807 |
| `.scene-gallery-actions` | src/features/gallery/styles-tiles-and-modal.css:220 | No direct literal found |
| `.scene-gallery-buttons` | src/features/gallery/styles-tiles-and-modal.css:229 | No direct literal found |
| `.scene-gallery-caption` | src/features/gallery/styles-tiles-and-modal.css:46 | desktop/test/smoke.mjs:3807 |
| `.scene-gallery-close` | src/features/gallery/styles-tiles-and-modal.css:93 | No direct literal found |
| `.scene-gallery-divider` | src/features/gallery/styles-tiles-and-modal.css:264 | No direct literal found |
| `.scene-gallery-divider-count` | src/features/gallery/styles-tiles-and-modal.css:271 | No direct literal found |
| `.scene-gallery-grid` | src/features/gallery/styles-tiles-and-modal.css:239 | No direct literal found |
| `.scene-gallery-grid-tile` | src/features/gallery/styles-tiles-and-modal.css:103 | No direct literal found |
| `.scene-gallery-head` | src/features/gallery/styles-tiles-and-modal.css:76 | No direct literal found |
| `.scene-gallery-heading` | src/features/gallery/styles-tiles-and-modal.css:80 | No direct literal found |
| `.scene-gallery-hint` | src/features/gallery/styles-tiles-and-modal.css:102 | No direct literal found |
| `.scene-gallery-host` | src/features/gallery/styles-tiles-and-modal.css:48 | No direct literal found |
| `.scene-gallery-kind` | src/features/gallery/styles-tiles-and-modal.css:138 | No direct literal found |
| `.scene-gallery-length` | src/features/gallery/styles-tiles-and-modal.css:28 | No direct literal found |
| `.scene-gallery-line` | src/features/gallery/styles-tiles-and-modal.css:47 | No direct literal found |
| `.scene-gallery-link` | src/features/gallery/styles-tiles-and-modal.css:52 | desktop/test/smoke.mjs:3807 |
| `.scene-gallery-link-remove` | src/features/gallery/styles-tiles-and-modal.css:60 | No direct literal found |
| `.scene-gallery-more-count` | src/features/gallery/styles-tiles-and-modal.css:40 | No direct literal found |
| `.scene-gallery-more-videos` | src/features/gallery/styles-tiles-and-modal.css:65 | No direct literal found |
| `.scene-gallery-note` | src/features/gallery/styles-tiles-and-modal.css:160 | No direct literal found |
| `.scene-gallery-num` | src/features/gallery/styles-tiles-and-modal.css:259 | No direct literal found |
| `.scene-gallery-panel` | src/features/gallery/styles-tiles-and-modal.css:70 | No direct literal found |
| `.scene-gallery-placeholder` | src/features/gallery/styles-tiles-and-modal.css:16 | No direct literal found |
| `.scene-gallery-play` | src/features/gallery/styles-tiles-and-modal.css:18 | No direct literal found |
| `.scene-gallery-playbtn` | src/features/gallery/styles-tiles-and-modal.css:147 | No direct literal found |
| `.scene-gallery-player` | src/features/gallery/styles-tiles-and-modal.css:159 | No direct literal found |
| `.scene-gallery-position` | src/features/gallery/styles-tiles-and-modal.css:137 | No direct literal found |
| `.scene-gallery-preview` | src/features/gallery/styles-tiles-and-modal.css:108 | No direct literal found |
| `.scene-gallery-preview-caption` | src/features/gallery/styles-tiles-and-modal.css:212 | No direct literal found |
| `.scene-gallery-preview-none` | src/features/gallery/styles-tiles-and-modal.css:104 | No direct literal found |
| `.scene-gallery-preview-pic` | src/features/gallery/styles-tiles-and-modal.css:123 | No direct literal found |
| `.scene-gallery-remove` | src/features/gallery/styles-tiles-and-modal.css:232 | No direct literal found |
| `.scene-gallery-show-all` | src/features/gallery/styles-tiles-and-modal.css:91 | No direct literal found |
| `.scene-gallery-step` | src/features/gallery/overlay.ts:175, :178, :236; src/features/gallery/styles-tiles-and-modal.css:101 | No direct literal found |
| `.scene-gallery-summary` | src/features/gallery/styles-tiles-and-modal.css:86 | No direct literal found |
| `.scene-gallery-tile` | src/features/gallery/styles-tiles-and-modal.css:6 | No direct literal found |
| `.scene-gallery-zoom` | src/features/gallery/styles-tiles-and-modal.css:175 | No direct literal found |
| `.scene-gallery-zoom-close` | src/features/gallery/styles-tiles-and-modal.css:201 | No direct literal found |
| `.scene-gallery-zoom-dims` | src/features/gallery/styles-tiles-and-modal.css:199 | No direct literal found |
| `.scene-gallery-zoom-img` | src/features/gallery/styles-tiles-and-modal.css:181 | No direct literal found |
| `.scene-gallery-zoom-info` | src/features/gallery/styles-tiles-and-modal.css:191 | No direct literal found |
| `.scene-gallery-zoom-name` | src/features/gallery/styles-tiles-and-modal.css:200 | No direct literal found |
| `.scene-gallery-zoom-stage` | src/features/gallery/styles-tiles-and-modal.css:180 | No direct literal found |
| `.scene-menu` | src/styles/overrides-after-comments-styles-resize-narrow.css:1 | No direct literal found |
| `.scene-menu-keys` | src/styles/components.css:422 | No direct literal found |
| `.section-drop-after` | src/styles/components.css:807 | No direct literal found |
| `.section-drop-before` | src/styles/components.css:806 | No direct literal found |
| `.section-fold` | src/styles/components.css:781 | src/test/scenes-app.test.mjs:191 |
| `.section-grip` | src/styles/components.css:780 | No direct literal found |
| `.section-header` | src/styles/components.css:757 | tests/features/rows/scene-controls.test.ts:15 |
| `.section-hint` | src/styles/components.css:802 | src/test/scenes-app.test.mjs:50 |
| `.section-hint-live` | src/styles/components.css:803 | src/test/scenes-app.test.mjs:171 |
| `.section-menu` | src/styles/components.css:788 | No direct literal found |
| `.section-more` | src/styles/components.css:769 | No direct literal found |
| `.section-name` | src/styles/components.css:783 | tests/features/rows/scene-controls.test.ts:15 |
| `.section-rename` | src/styles/components.css:808 | tests/features/rows/scene-controls.test.ts:36 |
| `.section-stats` | src/styles/components.css:784 | src/test/scenes-app.test.mjs:189 |
| `.settings-section` | src/features/settings/styles-panel.css:8 | No direct literal found |
| `.settings-section-title` | src/features/settings/styles-panel.css:10 | No direct literal found |
| `.tag-scene` | src/features/tags/styles.css:138 | src/test/split-join-app.test.mjs:399 |
| `.tag-scene-group` | src/features/tags/styles.css:80 | No direct literal found |
| `.tag-scene-group-head` | src/features/tags/styles.css:96 | No direct literal found |
| `.tag-scene-sep` | src/features/tags/styles.css:139 | No direct literal found |
| `.tag-scene-tick` | src/features/tags/styles-scenes.css:12 | No direct literal found |
| `.tag-scene-unit` | src/features/tags/styles.css:140 | No direct literal found |
| `.tag-scenes` | src/features/tags/styles-scenes.css:11 | No direct literal found |
| `.target-section` | src/features/settings/styles-anchor-targets.css:57 | src/test/target-length.test.mjs:15, tests/features/title/target.test.ts:7 |
| `data-scene-action` | src/features/clipboard/beat-select.ts:392 | No direct literal found |
| `data-section-action` | src/features/rows/scene-controls.ts:90 | No direct literal found |
| `data-section-id` | src/features/rows/row-motion.ts:6 | src/test/scenes-app.test.mjs:50, tests/features/rows/scene-controls.test.ts:15 |
| `data-section-total` | src/features/rows/render.ts:249 | src/test/scenes-app.test.mjs:190 |
| `data-splitpage-scenes` | src/features/clipboard/beat-clip.ts:47 | src/test/beat-clip.test.mjs:139 |

### Generated markup, class operations and IDs

These additional literal names occur in generated markup, DOM class operations, element IDs or action attributes. They can change together with all producers, consumers and tests, except the action ID `toggle-hide-shot`, which stays as specified above. `restore-snapshot` is unrelated to the terminology change and stays. A test listed here contains the literal; inspect it to distinguish assertions from fixtures.

| Name | First source occurrence | Tests with a literal occurrence |
| --- | --- | --- |
| `add-section` | src/features/rows/scene-controls.ts:89 | tests/features/rows/scene-controls.test.ts:17 |
| `broll-bulk-shot` | src/features/broll/panel.ts:509 | No direct literal found |
| `broll-page-c-scene` | src/features/broll/panel.ts:1210 | No direct literal found |
| `broll-scene-n` | src/features/broll/panel.ts:408 | No direct literal found |
| `broll-shot-list` | src/adapters/formats/list-print.ts:92 | tests/adapters/formats/fixtures/inspect-script-print.mjs:589, tests/adapters/formats/list-print.test.mjs:123 |
| `expand-hidden-shot` | src/features/rows/hide-shot.ts:22 | src/test/remaining-rows-app.test.mjs:209, tests/features/rows/routes.test.ts:19, tests/features/writer/mount.test.ts:59 |
| `.has-scene-selection` | src/features/clipboard/beat-select.ts:69 | tests/features/clipboard/copy-paste.test.ts:69 |
| `hidden-shot-label` | src/features/rows/hide-shot.ts:24 | No direct literal found |
| `i-scene-mode` | src/page.html:509 | No direct literal found |
| `menu-hide-shot` | src/bootstrap/wiring/hide-shot.ts:25 | tests/features/rows/hide-shot.test.ts:9 |
| `pp-scene-mode` | src/features/prompter/prompter.ts:416 | tests/features/prompter/mount.test.ts:76 |
| `pp-scene-next` | src/page.html:513 | tests/features/prompter/mount.test.ts:84 |
| `pp-scene-pos-sr` | src/features/prompter/prompter.ts:314 | No direct literal found |
| `pp-scene-prev` | src/page.html:511 | tests/features/prompter/mount.test.ts:80 |
| `pp-scene-step` | src/page.html:510 | No direct literal found |
| `pp-skip-shot` | src/features/prompter/prompter.ts:235 | src/test/find-present-app.test.mjs:99, tests/features/prompter/mount.test.ts:64 |
| `restore-snapshot` | src/features/gallery/mount.ts:11 | src/test/views-mount-app.test.mjs:42, tests/features/gallery/mount.test.ts:25, tests/features/history/panel.test.ts:50, desktop/test/smoke.mjs:2683 |
| `scene-gallery-overlay` | src/page.html:656 | No direct literal found |
| `scene-meta` | src/adapters/formats/list-print.ts:37 | tests/adapters/formats/list-print.test.mjs:31, tests/adapters/formats/script-print.test.mjs:23 |
| `scene-number` | src/adapters/formats/script-print.ts:65 | src/test/scene-outputs.test.mjs:42, tests/adapters/formats/fixtures/inspect-script-print.mjs:548, tests/adapters/formats/script-print.test.mjs:22 |
| `scene-selection-style` | src/features/clipboard/beat-select.ts:65 | tests/features/clipboard/copy-paste.test.ts:66 |
| `script-section` | src/adapters/formats/script-print.ts:77 | src/test/scene-outputs.test.mjs:37 |
| `script-section-total` | src/adapters/formats/script-print.ts:77 | No direct literal found |
| `shot-done` | src/adapters/formats/list-print.ts:87 | src/test/scene-outputs.test.mjs:43, tests/adapters/formats/list-print.test.mjs:65, tests/adapters/formats/script-print.test.mjs:45 |
| `shot-flag` | src/adapters/formats/list-print.ts:90 | tests/adapters/formats/list-print.test.mjs:115 |
| `shot-list` | src/adapters/formats/list-print.ts:92 | src/test/browser-pdf-app.test.mjs:34, tests/adapters/formats/fixtures/inspect-script-print.mjs:547, tests/adapters/formats/list-print.test.mjs:123, tests/features/broll/mount.test.ts:64, tests/legacy/overlay-availability.test.ts:147, desktop/test/smoke.mjs:1204 |
| `shot-table` | src/adapters/formats/list-print.ts:84 | tests/adapters/formats/list-print.test.mjs:101 |
| `toggle-hide-shot` | src/page.html:147 | tests/bootstrap/action-order.test.ts:17, tests/bootstrap/start-actions.test.ts:47, tests/legacy/chords.test.ts:88, tests/legacy/overlay-availability.test.ts:141 |
| `wr-scenes` | src/features/writer/writer.ts:135 | src/test/panels-listen-app.test.mjs:89 |
