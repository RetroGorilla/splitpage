# Document entry relocation

The entry responsibilities from `00-prelude.js` and `02-state.js` retain their behavior. The page-entry mount runs at the old prelude position: capture the shell, promote font CSS, attach desktop, then capture speech recognition. The empty state initializer is removed. The shell is captured before any other mount or initializer mutates the page.

## Entry calls

| Function or value | Old location | New location | Production importers or internal caller |
| --- | --- | --- | --- |
| `STATE_FIELDS` | `src/js/02-state.js` | `src/core/merge/state-fields.ts` | `src/js/02b-doc-id.js`, `src/js/03-sync.js`, `src/legacy/document-ports.ts` |
| `missingStateFields` | `src/js/02-state.js` | `src/core/merge/state-fields.ts` | No production importer |
| `migrateRows` | `src/js/02-state.js` | `src/legacy/document-ports.ts` | `src/bootstrap/wiring/clipboard.ts`, `src/bootstrap/wiring/drafts.ts`, `src/bootstrap/wiring/file-menu.ts`, `src/bootstrap/wiring/newtab.ts`, `src/js/02b-doc-id.js`, `src/js/03-sync.js`, `src/js/13-hosted.js`, `src/js/18a-local-merge.js`, `src/js/20d-formats.js`, `src/js/_entry.js`, `src/legacy/recovery-bridge.ts`, `src/legacy/transition-bridge.ts`, `tools/make-long-demo.mjs` |
| `makeId` | `src/js/02-state.js` | `src/adapters/identity/ids.ts` | No production importer |
| `escapeHtml` | `src/js/02-state.js` | `src/core/document/text-policy.ts` | `src/js/03-sync.js`, `src/js/13-hosted.js`, `src/js/18a-local-merge.js` |
| `legacyMdToHtml` | `src/js/02-state.js` | `src/core/document/text-policy.ts` | No production importer |
| `mediaCommentId` | `src/js/02-state.js` | `src/core/document/ids.ts` | No production importer |
| `buildPublishHtml` | `src/js/02-state.js` | `src/adapters/page/page-shell.ts` | `src/js/02b-doc-id.js` |
| `defaultState` | `src/js/02-state.js` | `src/adapters/page/page-shell.ts` | `src/js/02b-doc-id.js` |
| `SCHEMA_VERSION` | `src/js/00-prelude.js` | `src/core/document/fields.ts` | `src/js/18-local-files.js` |
| `loadLastFileHandle` | `src/js/00-prelude.js` | `src/adapters/files/last-file.ts` | `src/bootstrap/wiring/ports/files.ts`, `src/js/18-local-files.js` |
| `rememberLastFileHandle` | `src/js/00-prelude.js` | `src/adapters/files/last-file.ts` | `src/js/14-export.js`, `src/js/18-local-files.js` |
| `suppressUnloadWarning` | `src/js/00-prelude.js` | `src/bootstrap/startup/page-entry.ts` | `src/bootstrap/wiring/startup.ts` |
| `SpeechRecognitionCtor` | `src/js/00-prelude.js` | `src/adapters/page/speech-recognition.js` | `src/js/20-teleprompter.js` |
| `__init` | `src/js/00-prelude.js` | `mountPageEntry` in `src/bootstrap/startup/page-entry.ts` | `src/js/_entry.js` through the mount export in `src/bootstrap/wiring.ts` |
| `openHandleDb` | `src/js/00-prelude.js` | `src/adapters/files/last-file.ts` | `rememberLastFileHandle`, `loadLastFileHandle` in the same adapter |
| `promoteFontCss` | IIFE in `src/js/00-prelude.js:__init` | IIFE in `src/bootstrap/startup/page-entry.ts:mountPageEntry` | `mountPageEntry` |
| `PAGE_SHELL` capture | assignment in `src/js/00-prelude.js:__init` | `capturePageShell` in `src/adapters/page/page-shell.ts` | `mountPageEntry`; read only by `buildPublishHtml` in the same adapter |
| Speech constructor capture | assignment in `src/js/00-prelude.js:__init` | `captureSpeechRecognition` in `src/adapters/page/speech-recognition.js` | `mountPageEntry`; live binding read by `src/js/20-teleprompter.js` |
| `attachDesktop` call | `src/js/00-prelude.js:__init` | `src/bootstrap/startup/page-entry.ts:mountPageEntry` | Implementation remains in `src/adapters/desktop/desktop-port.ts` |
| `__init` | `src/js/02-state.js` | Deleted empty initializer | No callers remain |

The four former re-exports (`makeId`, `escapeHtml`, `legacyMdToHtml`, `mediaCommentId`) and `SCHEMA_VERSION` keep their existing implementations; their consumers now import those real homes directly. The state-field table remains a mutable copy of the frozen policies with the same list mergers attached; the document entry and its consumers share that exact table. The unload flag remains false and startup reads it from its new home. P25 reads the last-file adapter directly. No feature or bridge now imports either deleted file.

## All importers, including tests and tools

### STATE_FIELDS

- `src/js/02b-doc-id.js`
- `src/js/03-sync.js`
- `src/test/long-demo.test.mjs`
- `src/test/merge-golden.test.mjs`
- `src/test/person-colors.test.mjs`
- `src/test/starters.test.mjs`
- `src/test/state-field-tables.test.mjs`
- `src/test/state-fields.test.mjs`
- `src/test/undo-golden.test.mjs`
- `tests/legacy/document-ports.test.ts`

### missingStateFields

- `src/test/long-demo.test.mjs`
- `src/test/starters.test.mjs`
- `src/test/state-field-tables.test.mjs`
- `src/test/state-fields.test.mjs`

### migrateRows

- `src/bootstrap/wiring/clipboard.ts`
- `src/bootstrap/wiring/drafts.ts`
- `src/bootstrap/wiring/file-menu.ts`
- `src/bootstrap/wiring/newtab.ts`
- `src/js/02b-doc-id.js`
- `src/js/03-sync.js`
- `src/js/13-hosted.js`
- `src/js/18a-local-merge.js`
- `src/js/20d-formats.js`
- `src/js/_entry.js`
- `src/legacy/recovery-bridge.ts`
- `src/legacy/transition-bridge.ts`
- `src/test/_app-boot.mjs`
- `src/test/_export-kit-started.mjs`
- `src/test/_heal-rounds.mjs`
- `src/test/_session.mjs`
- `src/test/apply-merge-options-app.test.mjs`
- `src/test/apply-merge.test.mjs`
- `src/test/broll-id-sequence.test.mjs`
- `src/test/broll-model.test.mjs`
- `src/test/bulk-tag-find-app.test.mjs`
- `src/test/cell-edit-command-app.test.mjs`
- `src/test/cell-text-app.test.mjs`
- `src/test/comment-anchors.test.mjs`
- `src/test/comment-images-export.test.mjs`
- `src/test/cues.test.mjs`
- `src/test/cut-paste-app.test.mjs`
- `src/test/dialog-open-actions-app.test.mjs`
- `src/test/directions.test.mjs`
- `src/test/doc-id.test.mjs`
- `src/test/document-chrome-listens-app.test.mjs`
- `src/test/document-edits-app.test.mjs`
- `src/test/document-guard.test.mjs`
- `src/test/document-sources-app.test.mjs`
- `src/test/docx-reimport.test.mjs`
- `src/test/draft-keep-app.test.mjs`
- `src/test/editor-open-actions-app.test.mjs`
- `src/test/entry-fuzz-app.test.mjs`
- `src/test/export-capture-app.test.mjs`
- `src/test/export-colours.test.mjs`
- `src/test/export-kit-services.test.mjs`
- `src/test/export-kit.test.mjs`
- `src/test/export-projections.test.mjs`
- `src/test/export-text-captures.test.mjs`
- `src/test/exports-golden.test.mjs`
- `src/test/file-destinations-app.test.mjs`
- `src/test/fold-into-edit-app.test.mjs`
- `src/test/formats.test.mjs`
- `src/test/gallery-annotate.test.mjs`
- `src/test/gallery.test.mjs`
- `src/test/hosted-save-reopen-app.test.mjs`
- `src/test/hosted-save-teardown-app.test.mjs`
- `src/test/html-images.test.mjs`
- `src/test/import-rows.test.mjs`
- `src/test/last-edited-by-boot-app.test.mjs`
- `src/test/last-edited-by.test.mjs`
- `src/test/leading-break-app.test.mjs`
- `src/test/list-pdfs.test.mjs`
- `src/test/local-merge-ids.test.mjs`
- `src/test/long-demo.test.mjs`
- `src/test/m4-lifecycle.test.mjs`
- `src/test/m4-matrix-continuations.test.mjs`
- `src/test/m4-matrix-exports.test.mjs`
- `src/test/m4-matrix-files.test.mjs`
- `src/test/m4-matrix-hosted.test.mjs`
- `src/test/m4-matrix-recovery.test.mjs`
- `src/test/m4-matrix-session.test.mjs`
- `src/test/markdown-table.test.mjs`
- `src/test/media-cell-app.test.mjs`
- `src/test/media-routes-app.test.mjs`
- `src/test/menus-listen-app.test.mjs`
- `src/test/merge-golden.test.mjs`
- `src/test/merge-states.test.mjs`
- `src/test/migrate-golden.test.mjs`
- `src/test/migrate-rows.test.mjs`
- `src/test/name-cuts-app.test.mjs`
- `src/test/name-limit-caret-app.test.mjs`
- `src/test/normalisers-golden.test.mjs`
- `src/test/orphan-records-app.test.mjs`
- `src/test/panels-listen-app.test.mjs`
- `src/test/paste-html-fuzz.test.mjs`
- `src/test/pdf-layout.test.mjs`
- `src/test/pdf-script.test.mjs`
- `src/test/person-colors.test.mjs`
- `src/test/production-frozen.test.mjs`
- `src/test/production-golden.test.mjs`
- `src/test/production-index.test.mjs`
- `src/test/production-shims.test.mjs`
- `src/test/remaining-rows-app.test.mjs`
- `src/test/render-focus-app.test.mjs`
- `src/test/render-guard-app.test.mjs`
- `src/test/render-no-edit-app.test.mjs`
- `src/test/repair-on-read-app.test.mjs`
- `src/test/reserved-ids.test.mjs`
- `src/test/rows-commands-app.test.mjs`
- `src/test/save-coordinator-app.test.mjs`
- `src/test/save-destinations-app.test.mjs`
- `src/test/save-status-listens-app.test.mjs`
- `src/test/scene-clip.test.mjs`
- `src/test/scene-clipboard-app.test.mjs`
- `src/test/scene-effects-app.test.mjs`
- `src/test/scene-effects-order.test.mjs`
- `src/test/scene-effects-undo.test.mjs`
- `src/test/scene-length.test.mjs`
- `src/test/screen-listens-app.test.mjs`
- `src/test/selection-model-app.test.mjs`
- `src/test/session-bridge-app.test.mjs`
- `src/test/session-bridge-unwired.test.mjs`
- `src/test/session-change-listeners.test.mjs`
- `src/test/session-commit-app.test.mjs`
- `src/test/session-recovery-boot.test.mjs`
- `src/test/split-join-app.test.mjs`
- `src/test/starters.test.mjs`
- `src/test/state-assignments-saved-boot.test.mjs`
- `src/test/state-assignments.test.mjs`
- `src/test/state-field-tables.test.mjs`
- `src/test/state-fields.test.mjs`
- `src/test/tag-ids.test.mjs`
- `src/test/tag-name-suggestions-app.test.mjs`
- `src/test/target-length.test.mjs`
- `src/test/text-cuts-app.test.mjs`
- `src/test/text-editing-app.test.mjs`
- `src/test/text-exports.test.mjs`
- `src/test/transition-bridge-unwired.test.mjs`
- `src/test/undo-adapter-differential.test.mjs`
- `src/test/undo-golden.test.mjs`
- `src/test/undo-lifetime.test.mjs`
- `src/test/undo-media-app.test.mjs`
- `src/test/undo-owner-crew-merge.test.mjs`
- `src/test/undo-owner-fold-forget.test.mjs`
- `src/test/undo-owner-merge-fold.test.mjs`
- `src/test/undo-replay-app.test.mjs`
- `src/test/undo-replay-owners.test.mjs`
- `src/test/video-commands-app.test.mjs`
- `src/test/video-embed.test.mjs`
- `src/test/writer-commands-app.test.mjs`
- `src/test/writer-review-app.test.mjs`
- `src/test/xlsx-export.test.mjs`
- `tests/adapters/formats/project-file.test.ts`
- `tests/application/document-merge.test.ts`
- `tests/application/editing/undo-control.test.ts`
- `tests/application/editing/undo/undo.test.ts`
- `tests/application/project-file-services.test.ts`
- `tests/bootstrap/shared-ports-document.test.ts`
- `tests/bootstrap/shared-ports-transitions.test.ts`
- `tests/bootstrap/shared-ports.test.ts`
- `tests/bootstrap/wiring.test.ts`
- `tests/legacy/document-ports.test.ts`
- `tools/make-long-demo.mjs`

### makeId

- `src/test/broll-id-sequence.test.mjs`

### escapeHtml

- `src/js/03-sync.js`
- `src/js/13-hosted.js`
- `src/js/18a-local-merge.js`
- `src/test/broll-model.test.mjs`
- `src/test/text-exports.test.mjs`

### legacyMdToHtml

- `src/test/migrate-rows.test.mjs`

### mediaCommentId

- `src/test/migrate-rows.test.mjs`

### buildPublishHtml

- `src/js/02b-doc-id.js`
- `src/test/open-html-bound.test.mjs`

### defaultState

- `src/js/02b-doc-id.js`

### SCHEMA_VERSION

- `src/js/18-local-files.js`
- `src/test/merge-golden.test.mjs`

### loadLastFileHandle

- `src/application/files/last-file.test.ts`
- `src/bootstrap/wiring/ports/files.ts`
- `src/js/18-local-files.js`

### rememberLastFileHandle

- `src/js/14-export.js`
- `src/js/18-local-files.js`
- `tests/application/files/last-file.test.ts`

### suppressUnloadWarning

- `src/bootstrap/wiring/startup.ts`

### SpeechRecognitionCtor

- `src/js/20-teleprompter.js`

The namespace import in `tests/legacy/document-ports.test.ts` now targets `src/legacy/document-ports.ts` and retains its negative assertion that the entry does not expose `loadInitialState`. The frozen shim catalog replaces the retired state import with the explicit document-entry import; it still admits only the existing two bootstrap paths. The load-only catalog covers all six new or expanded modules. The core environment catalog also imports the relocated pure table to verify it adds no globals.

## Dependency reduction

The two legacy-file exceptions, every importer edge to the two deleted files, and the recovery/transition bridge edges to `src/js/02-state.js` disappear. The baseline is pruned only, removing 20 exceptions (119 to 99), with no additions.

| Legacy metric | Before | After |
| --- | ---: | ---: |
| Numbered files | 20 | 18 |
| Numbered lines | 12,191 | 12,091 |
| Loop modules and links | 0 | 0 |
| State modules, fields, references, importers, assigners and direct writes | 0 | 0 |

Metrics are from `node tools/dep-report.mjs --legacy-metrics`. The line reduction includes the additional direct import lines left in the surviving numbered files.
