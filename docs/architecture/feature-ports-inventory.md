# Numbered files: imports, importers and bridges

Generated on `a1615c0` by the script in [feature-ports.md](feature-ports.md#appendix-regenerating-the-inventory). It lists, for each file left in `src/js`, what it imports from numbered files, bridges, adapters and feature folders, and who imports it. Imports from `src/core`, `shared` and `src/application` are left out, since a feature may import those. `_entry.js` calling a file's `__init` is left out too.

| File | Lines | In the loop | Numbered files it imports | Bridges it reaches | Adapters and features it imports | Imported by |
| --- | --- | --- | --- | --- | --- | --- |
| `00-prelude` | 61 |  | 0 | none | 1 | 6 numbered, 1 wiring, 1 tests |
| `01-scene-status` | 114 |  | 2 | document-ports, effects-bridge, preferences-bridge, session-bridge | 0 | 1 numbered, 2 wiring, 26 tests, 1 tools |
| `01b-hide-shot` | 125 |  | 0 | effects-bridge, preferences-bridge, session-bridge | 0 | 9 numbered, 1 bridges, 4 wiring, 4 tests |
| `02-state` | 48 |  | 1 | document-ports | 1 | 12 numbered, 1 bridges, 1 other src/js, 125 tests, 1 tools |
| `02b-doc-id` | 234 | yes | 3 | document-guard, document-ports, effects-bridge, location-bridge, session-bridge, transition-bridge | 2 | 10 numbered, 1 wiring, 1 other src/js, 18 tests |
| `03-sync` | 781 | yes | 9 | document-ports, editor-bridge, location-bridge, preferences-bridge, production-editing-bridge, recovery-bridge, richtext, save-bridge, session-bridge | 2 | 15 numbered, 2 bridges, 5 wiring, 1 other src/js, 45 tests |
| `03a-history-store` | 1403 | yes | 2 | location-bridge, recovery-bridge, save-bridge, seed-check, session-bridge | 4 | 4 numbered, 2 wiring, 5 tests |
| `03b-side-panels` | 122 | yes | 4 | preferences-bridge | 1 | 6 numbered, 1 wiring |
| `04-richtext` | 36 |  | 0 | richtext | 1 | 18 numbered, 3 wiring, 15 tests |
| `04c-doc-model` | 69 |  | 0 | richtext | 0 | 2 numbered, 31 tests |
| `05-render` | 1286 | yes | 7 | document-ports, editor-bridge, effects-bridge, location-bridge, preferences-bridge, production-editing-bridge, richtext, session-bridge | 8 | 4 numbered, 6 wiring, 22 tests |
| `05c-clipboard` | 379 |  | 3 | editor-bridge, richtext, session-bridge | 3 | 1 numbered, 1 wiring, 6 tests |
| `05d-draft-edit` | 317 |  | 0 | richtext | 2 | 2 numbered, 2 wiring, 1 tests |
| `05e-gallery-overlay` | 701 |  | 6 | editor-bridge, effects-bridge, location-bridge, preferences-bridge, session-bridge, transition-bridge | 2 | 3 wiring, 3 tests |
| `05f-rundown` | 1061 |  | 3 | app-actions, cache-freeze, document-ports, editor-bridge, location-bridge, preferences-bridge, richtext, session-bridge | 0 | 3 numbered, 1 bridges, 1 wiring, 3 tests |
| `05g-scene-clip` | 405 |  | 5 | richtext, session-bridge | 1 | 2 numbered, 3 tests |
| `05h-scene-select` | 527 |  | 8 | editor-bridge, effects-bridge, location-bridge, preferences-bridge, review-wording, save-bridge, session-bridge | 3 | 1 wiring, 2 tests |
| `05p-rundown-presence` | 196 |  | 2 | session-bridge | 0 | 1 wiring, 1 tests |
| `05r-read-time` | 155 |  | 2 | document-ports, editor-bridge, effects-bridge, location-bridge, session-bridge | 0 | 4 tests |
| `05s-script-zoom` | 218 |  | 0 | app-actions, preferences-bridge, session-bridge | 0 | 1 bridges, 2 tests |
| `05t-target` | 128 |  | 1 | effects-bridge, location-bridge, session-bridge | 0 | 1 numbered, 1 wiring, 3 tests |
| `05v-video` | 135 |  | 1 | preferences-bridge, session-bridge, transition-bridge | 2 | 1 numbered, 1 wiring, 2 tests |
| `05w-annotate` | 836 |  | 1 | editor-bridge, effects-bridge, location-bridge, session-bridge, transition-bridge | 1 | 1 numbered, 1 wiring, 2 tests |
| `06-rows` | 448 |  | 3 | editor-bridge, effects-bridge, production-editing-bridge, review-wording, session-bridge, transition-bridge | 6 | 5 numbered, 3 wiring, 5 tests |
| `07-production-tags` | 664 | yes | 4 | document-ports, editor-bridge, effects-bridge, preferences-bridge, production-index-bridge, richtext, session-bridge | 2 | 8 numbered, 4 wiring, 1 other src/js, 47 tests, 1 tools |
| `07b-plain-tags` | 259 | yes | 1 | editor-bridge, richtext, session-bridge | 2 | 1 numbered, 3 wiring, 4 tests |
| `08-production-panels` | 1106 | yes | 6 | document-ports, effects-bridge, location-bridge, production-editing-bridge, production-index-bridge, session-bridge, tag-rewrites | 2 | 2 numbered, 1 bridges, 4 wiring, 10 tests |
| `08c-broll` | 282 |  | 2 | document-ports, editor-bridge, plain-text, production-index-bridge, richtext, session-bridge | 3 | 4 numbered, 2 wiring, 1 other src/js, 15 tests, 1 tools |
| `08d-broll-panel` | 1360 | yes | 9 | app-actions, document-ports, effects-bridge, location-bridge, production-index-bridge, session-bridge | 3 | 2 numbered, 2 bridges, 2 wiring, 11 tests |
| `09-find-replace` | 518 |  | 3 | effects-bridge, location-bridge, preferences-bridge, richtext, session-bridge | 0 | 2 numbered, 1 bridges, 1 wiring, 5 tests |
| `10-comments` | 1036 | yes | 6 | editor-bridge, effects-bridge, location-bridge, preferences-bridge, production-editing-bridge, save-bridge, session-bridge, transition-bridge | 3 | 8 numbered, 2 bridges, 4 wiring, 16 tests |
| `11-import` | 574 | yes | 3 | document-ports, effects-bridge, richtext, session-bridge, transition-bridge | 6 | 3 numbered, 1 bridges, 1 wiring, 6 tests |
| `12-dirty-toast` | 182 | yes | 4 | effects-bridge, location-bridge, preferences-bridge, save-bridge | 0 | 6 numbered, 4 wiring, 1 other src/js, 3 tests |
| `12a-undo` | 981 |  | 1 | richtext, session-bridge | 0 | 13 numbered, 1 bridges, 1 wiring, 67 tests |
| `13-hosted` | 2522 | yes | 11 | file-delivery, location-bridge, preferences-bridge, production-editing-bridge, recovery-bridge, review-wording, save-bridge, session-bridge, transition-bridge | 7 | 13 numbered, 2 bridges, 2 wiring, 1 other src/js, 15 tests |
| `13a-presence` | 343 | yes | 3 | location-bridge, preferences-bridge, session-bridge, transition-bridge | 0 | 7 numbered, 3 wiring, 2 tests |
| `13b-collaborate` | 906 | yes | 4 | app-actions, effects-bridge, location-bridge, preferences-bridge, session-bridge | 2 | 2 numbered, 1 bridges, 5 tests |
| `14-export` | 332 | yes | 6 | effects-bridge, file-delivery, location-bridge, preferences-bridge, recovery-bridge, save-bridge, session-bridge | 5 | 2 numbered, 1 wiring, 1 other src/js, 4 tests |
| `14b-export-kit` | 94 |  | 1 | preferences-bridge, session-bridge | 2 | 4 numbered, 60 tests |
| `18-local-files` | 694 | yes | 14 | app-actions, effects-bridge, export-formats, file-delivery, location-bridge, production-editing-bridge, richtext, save-bridge, session-bridge, transition-bridge | 9 | 11 numbered, 3 bridges, 5 wiring, 1 other src/js, 38 tests |
| `18a-local-merge` | 386 | yes | 4 | location-bridge, plain-text, save-bridge, session-bridge | 2 | 1 numbered, 1 wiring, 1 tests |
| `18b-file-menu` | 430 | yes | 8 | effects-bridge, location-bridge, preferences-bridge, production-editing-bridge, save-bridge, session-bridge, transition-bridge | 2 | 5 numbered, 4 bridges, 2 wiring, 8 tests |
| `18c-export-dialog` | 650 | yes | 3 | effects-bridge, export-formats, richtext, session-bridge | 5 | 2 numbered, 2 bridges, 2 tests |
| `18d-command-menu` | 337 |  | 3 | app-actions, editor-bridge, export-formats, screen | 1 | 1 bridges, 3 tests |
| `19-writer` | 383 | yes | 9 | document-ports, editor-bridge, effects-bridge, plain-text, preferences-bridge, review-wording, session-bridge | 2 | 2 numbered, 1 bridges, 4 wiring, 21 tests |
| `20-teleprompter` | 1061 | yes | 6 | document-ports, editor-bridge, effects-bridge, location-bridge, preferences-bridge, richtext, save-bridge, session-bridge, startup-bridge | 2 | 1 numbered, 1 bridges, 2 wiring, 4 tests |
| `20a-update` | 384 | yes | 1 | preferences-bridge | 1 | 3 numbered, 1 bridges, 1 wiring, 1 tests |
| `20b-onboarding` | 337 |  | 5 | app-actions, effects-bridge, file-delivery, location-bridge, preferences-bridge, recovery-bridge, seed-check | 1 | 1 bridges, 1 tests |
| `20c-help` | 351 |  | 1 | app-actions, effects-bridge, preferences-bridge, session-bridge, tour-pause | 0 | 2 bridges, 1 tests |
| `20d-formats` | 263 | yes | 7 | location-bridge, richtext, save-bridge, session-bridge | 5 | 2 numbered, 1 wiring, 44 tests |
| `20e-connect` | 511 | yes | 2 | app-actions, effects-bridge, file-delivery, location-bridge, tour-pause | 2 | 4 numbered, 1 bridges, 1 tests |
| `20f-desktop` | 1009 | yes | 8 | location-bridge, recovery-bridge, save-bridge, session-bridge, startup-bridge | 5 | 4 numbered, 2 bridges, 4 wiring, 1 tests |
| `20g-drafts` | 1011 | yes | 7 | location-bridge, production-editing-bridge, recovery-bridge, save-bridge, session-bridge, transition-bridge | 4 | 3 numbered, 1 wiring, 1 other src/js, 8 tests |
| `20h-appdata` | 445 |  | 5 | file-delivery, location-bridge, preferences-bridge | 3 | 1 bridges |
| `20j-newtab` | 379 | yes | 8 | app-actions, document-ports, effects-bridge, location-bridge, preferences-bridge, production-editing-bridge, recovery-bridge, save-bridge, seed-check, session-bridge, startup-bridge, transition-bridge | 2 | 4 numbered |
| `20s-settings` | 393 | yes | 7 | app-actions, effects-bridge, preferences-bridge, save-bridge | 1 | 1 numbered, 1 bridges, 2 tests |

### `00-prelude`

61 lines.

- Imports from adapters (a feature may not): `adapters/desktop/desktop-port` (attachDesktop)
- Imported by numbered files: `02-state` (PAGE_SHELL); `14-export` (rememberLastFileHandle); `18-local-files` (SCHEMA_VERSION, loadLastFileHandle, rememberLastFileHandle); `20-teleprompter` (SpeechRecognitionCtor); `20b-onboarding` (loadLastFileHandle); `20j-newtab` (SCHEMA_VERSION, loadLastFileHandle)
- Imported by the wiring: `bootstrap/wiring/startup` (suppressUnloadWarning)
- Imported by tests: 1 file

### `01-scene-status`

114 lines.

- Imports from numbered files: `01b-hide-shot` (armShotHideGrace, clearShotHideGrace); `05f-rundown` (setRundownExtraSeconds)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/session-bridge` (REVIEW_ONLY, currentDocument, readSession, runCommand, sessionStamps); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (viewFlags)
- Imported by numbered files: `19-writer` (totalSeconds)
- Imported by the wiring: `bootstrap/wiring/editor` (cycleRowStatus); `bootstrap/wiring/panels` (onScriptStats, statsFollowChange, updateScriptStats)
- Imported by tests: 26 files; by tools: 1 file

### `01b-hide-shot`

125 lines.

- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (preferences, viewFlags)
- Imported by numbered files: `01-scene-status` (armShotHideGrace, clearShotHideGrace); `05-render` (hiddenShotStripHtml, rowGroupItems); `05f-rundown` (revealRow); `08-production-panels` (revealRow); `08d-broll-panel` (revealRow); `09-find-replace` (revealRow); `10-comments` (revealRow); `19-writer` (renderRowGroups); `20s-settings` (setHideShotScenes)
- Imported by bridges: `legacy/this-document-actions` (toggleHideShotScenes)
- Imported by the wiring: `bootstrap/wiring/editor` (expandHiddenShotStrip, revealRow); `bootstrap/wiring/screen` (onShotHiding); `bootstrap/wiring/startup` (updateHideShotMenu); `bootstrap/wiring/views` (expandHiddenShotStrip)
- Imported by tests: 4 files

### `02-state`

48 lines.

- Imports from numbered files: `00-prelude` (PAGE_SHELL)
- Reaches through bridges: `legacy/document-ports` (withDocumentPorts)
- Imports from adapters (a feature may not): `adapters/identity/ids` (makeId)
- Imported by numbered files: `02b-doc-id` (STATE_FIELDS, buildPublishHtml, defaultState, migrateRows); `03-sync` (STATE_FIELDS, escapeHtml, migrateRows); `05g-scene-clip` (makeId, migrateRows); `12a-undo` (STATE_FIELDS); `13-hosted` (escapeHtml, migrateRows); `14-export` (migrateRows); `14b-export-kit` (migrateRows); `18a-local-merge` (escapeHtml, migrateRows); `18b-file-menu` (escapeHtml, makeId, migrateRows); `20d-formats` (legacyMdToHtml, makeId, migrateRows); `20g-drafts` (migrateRows); `20j-newtab` (escapeHtml, makeId, migrateRows)
- Imported by other `src/js` files: `_entry` (migrateRows)
- Imported by bridges: `legacy/transition-bridge` (migrateRows)
- Imported by tests: 125 files; by tools: 1 file

### `02b-doc-id`

234 lines, in the import loop.

- Imports from numbered files: `02-state` (STATE_FIELDS, buildPublishHtml, defaultState, migrateRows); `03a-history-store` (copyHistory, historyDocumentChanged); `13-hosted` (onServerDoc)
- Reaches through bridges: `legacy/location-bridge` (currentHome, documentLocation); `legacy/session-bridge` (currentDocument, heldDocument, stampDocument); `legacy/document-guard` (documentGuardOn, documentView, quietly); `legacy/document-ports` (withDocumentPorts); `legacy/transition-bridge` (documentTransitions); `legacy/effects-bridge` (showToast)
- Imports from adapters (a feature may not): `adapters/identity/ids` (mintDocId, randomHexBytes); `adapters/storage/02c-blobs` (inlineStateImages)
- Imported by numbered files: `03-sync` (adoptRestoredState, noteMergedDocId); `12-dirty-toast` (syncDocIdentity); `13-hosted` (copyDocHistorySafe, migrateDocument); `14-export` (copyDocHistorySafe, syncDocIdentity); `18-local-files` (migrateDocument, standaloneHtmlFor, syncDocIdentity); `18b-file-menu` (syncDocIdentity); `20d-formats` (adoptRestoredState, docIdEvents, initDocIdentityChannel, migrateDocument, reassignDocId, standaloneHtmlFor); `20f-desktop` (reassignDocId); `20g-drafts` (copyDocHistorySafe, syncDocIdentity); `20j-newtab` (syncDocIdentity)
- Imported by other `src/js` files: `_entry` (documentIdentityPort)
- Imported by the wiring: `bootstrap/wiring/startup` (initDocIdentityChannel, loadInitialState, syncDocIdentity)
- Imported by tests: 18 files

### `03-sync`

781 lines, in the import loop.

- Imports from numbered files: `02-state` (STATE_FIELDS, escapeHtml, migrateRows); `02b-doc-id` (adoptRestoredState, noteMergedDocId); `03a-history-store` (captureSnapshot, getHistorySnapshot, listDocHistory, protectHistorySnapshot); `03b-side-panels` (applySidePanelWidth, holdScriptPlace, sidePanelOpening); `04-richtext` (safeId); `05t-target` (targetSectionHtml, wireTargetSection); `10-comments` (formatTimestamp, getSavedAuthorName); `12-dirty-toast` (showToast); `13a-presence` (personColor)
- Reaches through bridges: `legacy/location-bridge` (reviewMode, setHome); `legacy/session-bridge` (currentDocument, heldDocument, holdMergeBase, mergeBase, noteAbsorbedDirty, noteMerged, noteRecovery, noteServerUpdate, runDocumentEdit); `legacy/document-ports` (withDocumentPorts); `legacy/preferences-bridge` (panelWidths, preferences); `legacy/richtext` (fromHtml); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/save-bridge` (autoSavePolicy, confirmBaseline, haltAutoSave, saveChanges); `legacy/recovery-bridge` (captureRestore, conflictStash, stillRestoring); `legacy/editor-bridge` (mergeUndo)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (dataUrlForSync, isDurableSync); `adapters/identity/ids` (nowIso, randomIds, systemClock)
- Imported by numbered files: `03a-history-store` (getEditorName); `03b-side-panels` (closeHistoryPanel, syncPanelClass); `05h-scene-select` (stampRow); `08-production-panels` (openSidePanel, syncPanelClass); `08d-broll-panel` (openSidePanel, syncPanelClass); `10-comments` (openSidePanel, pushSnapshot, syncPanelClass); `11-import` (pushSnapshot, stampRow); `13-hosted` (applyMerge, getEditorName, mergeStates, pushSnapshot, reportMerge, setBaseState, stashLocalWork); `13b-collaborate` (personSwatchesHtml); `14-export` (applyMerge, getEditorName, setBaseState); `18-local-files` (pushSnapshot, stampRow); `18a-local-merge` (textMergeContext); `18b-file-menu` (pushSnapshot); `20d-formats` (setBaseState, stashLocalWork); `20s-settings` (personSwatchesHtml)
- Imported by other `src/js` files: `_entry` (documentDestinationPort, getEditorName, stampRow)
- Imported by bridges: `legacy/share-actions` (promptForTarget); `legacy/this-document-actions` (openHistoryPanel)
- Imported by the wiring: `bootstrap/wiring/document-chrome` (identityChipListeners); `bootstrap/wiring/editor` (installMergeBanner, restoreMergeSnapshot); `bootstrap/wiring/panels` (renderHistory); `bootstrap/wiring/startup` (reportMerge, toastLastEditor); `bootstrap/wiring/views` (closeHistoryPanel, promptForName, promptForWpm, restoreSnapshotFromCard)
- Imported by tests: 45 files

### `03a-history-store`

1403 lines, in the import loop.

- Imports from numbered files: `03-sync` (getEditorName); `12-dirty-toast` (showToast)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/location-bridge` (currentHome); `legacy/recovery-bridge` (legacySnapshots); `legacy/save-bridge` (saveChanges, unsavedChanges); `legacy/seed-check` (seedCheckPasses)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (dataUrlForSync, ensureBytes, inlineStateJson, intern, persist, recordFor); `adapters/storage/03c-history-idb` (createIdbHistoryBackend, hashText); `adapters/identity/ids` (makeId, mintDocId); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `02b-doc-id` (copyHistory, historyDocumentChanged); `03-sync` (captureSnapshot, getHistorySnapshot, listDocHistory, protectHistorySnapshot); `20f-desktop` (isPristineSeedDocument); `20h-appdata` (exportHistoryAll, importHistoryBundle, normalizeLegacySnapshots)
- Imported by the wiring: `bootstrap/wiring/panels` (onHistoryChange); `bootstrap/wiring/startup` (startHistoryMigration)
- Imported by tests: 5 files

### `03b-side-panels`

122 lines, in the import loop.

- Imports from numbered files: `03-sync` (closeHistoryPanel, syncPanelClass); `08-production-panels` (closeGearPanel, closeProductionPanel); `08d-broll-panel` (closeBrollPanel); `10-comments` (closeCommentsPanel)
- Reaches through bridges: `legacy/preferences-bridge` (panelWidths)
- Imports from feature folders (a feature may not import another feature): `features/panels/mount` (mountPanels)
- Imported by numbered files: `03-sync` (applySidePanelWidth, holdScriptPlace, sidePanelOpening); `08d-broll-panel` (closeAllSidePanels); `19-writer` (closeAllSidePanels); `20-teleprompter` (closeAllSidePanels); `20b-onboarding` (closeAllSidePanels); `20c-help` (closeAllSidePanels)
- Imported by the wiring: `bootstrap/wiring/views` (initSidePanelResizeHandles)

### `04-richtext`

36 lines.

- Reaches through bridges: `legacy/richtext` (buildVideoCardEl, htmlToMarkdown, imageRefOf, inertBody, sanitizeHtml, storedHtmlFromDom)
- Imports from adapters (a feature may not): `adapters/identity/ids` (randomIds)
- Imported by numbered files: `03-sync` (safeId); `05-render` (buildVideoCardEl, cssAttr, ensureTrailingCaretSpot, safeHref, sanitizeHtml, storedHtmlFromDom); `05e-gallery-overlay` (cssAttr); `05f-rundown` (cssAttr); `05h-scene-select` (cssAttr); `05r-read-time` (cssAttr); `06-rows` (safeHref, safeId, storedHtmlFromDom); `07-production-tags` (inertBody, safeId, sanitizeHtml); `08-production-panels` (cssAttr, plainText, safeId); `08c-broll` (ensureTrailingCaretSpot, inertBody, sanitizeHtml); `08d-broll-panel` (cssAttr, plainText); `09-find-replace` (cssAttr, inertBody, sanitizeHtml); `10-comments` (cssAttr, inertBody, plainText, safeId, sanitizeHtml); `11-import` (cssAttr, sanitizeHtml); `13-hosted` (cssAttr, inertBody); `13a-presence` (cssAttr); `19-writer` (cssAttr, ensureTrailingCaretSpot, sanitizeHtml, storedHtmlFromDom); `20f-desktop` (cssAttr)
- Imported by the wiring: `bootstrap/wiring/comments` (storedImageHtml); `bootstrap/wiring/editor` (cssAttr, ensureTrailingCaretSpot, safeId, sanitizeHtml, storedHtmlFromDom); `bootstrap/wiring/production` (cssAttr)
- Imported by tests: 15 files

### `04c-doc-model`

69 lines.

- Reaches through bridges: `legacy/richtext` (cellOf, fromHtml)
- Imported by numbered files: `05c-clipboard` (cellLength, cellOf, commentIds, flattenDirections, fromHtml, normalizeCell, projection, sliceCell, toHtml); `05g-scene-clip` (cellOf, commentIds, fromHtml, normalizeCell, syncCommentAnchors, toHtml, toPlainText)
- Imported by tests: 31 files

### `05-render`

1286 lines, in the import loop.

- Imports from numbered files: `01b-hide-shot` (hiddenShotStripHtml, rowGroupItems); `04-richtext` (buildVideoCardEl, cssAttr, ensureTrailingCaretSpot, safeHref, sanitizeHtml, storedHtmlFromDom); `05d-draft-edit` (appendDraftMedia, draftModel, editDraft); `12a-undo` (trackDocument); `07-production-tags` (openTagComposer, productionIndexStats, resetProductionIndexStats, scheduleUntaggedScan, tagFieldOccurrences); `10-comments` (formatTimestamp, openCommentComposer); `13a-presence` (personColor)
- Reaches through bridges: `legacy/production-editing-bridge` (deleteConfirmation); `legacy/session-bridge` (currentDocument, editAllowed, readSession); `legacy/document-ports` (productionReaders); `legacy/richtext` (fromHtml); `legacy/editor-bridge` (cellEditing, editorSelection, paintGuard, undoGuard); `legacy/effects-bridge` (showActionToast, showToast); `legacy/preferences-bridge` (viewFlags); `legacy/location-bridge` (reviewMode)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (blobImgHtml); `adapters/storage/02d-gallery` (rowSlots, videoLinkKey, videoLinkLabel); `adapters/formats/video-host` (videoHostLabel); `adapters/identity/ids` (makeId)
- Imports from feature folders (a feature may not import another feature): `features/rows/delete-button` (disarmDeleteButton); `features/editing/cell-page` (isDraftBox, isScriptCell); `features/rows/row-motion` (rowMotionKey, withRowMotion); `features/editing/cell-selection` (cellSelection, placeEditorSelection, rememberCellSelection)
- Imported by numbered files: `05e-gallery-overlay` (galleryBadgeHtml, gallerySlotPictureHtml, slotPoster); `05w-annotate` (slotPoster); `10-comments` (editableCellHtml); `19-writer` (cellFormatState, editableCellHtml, toggleCellDirection, toggleCellFormat)
- Imported by the wiring: `bootstrap/wiring/comments` (typePendingMarks); `bootstrap/wiring/editor` (cancelLink, cancelVideo, confirmLink, confirmVideo, forgetStalePendingMarks, handleToolbarCmd, insertLineBreak, maybeCueShortcut, maybeDirectionShortcut, noteFieldPainted, paintingScreen, screenIsStale, syncPageTitle, toggleCellFormat, typeAtDirectionEdge, typePendingMarks, updateToolbarState); `bootstrap/wiring/overlay` (paintingScreen); `bootstrap/wiring/panels` (onPainted); `bootstrap/wiring/screen` (screenListeners); `bootstrap/wiring/startup` (renderFirstDraw)
- Imported by tests: 22 files

### `05c-clipboard`

379 lines.

- Imports from numbered files: `04c-doc-model` (cellLength, cellOf, commentIds, flattenDirections, fromHtml, normalizeCell, projection, sliceCell, toHtml); `08c-broll` (brollSeedOf); `12a-undo` (breakUndoCoalescing, flushEdits)
- Reaches through bridges: `legacy/editor-bridge` (cellEditing, paintGuard); `legacy/richtext` (imageRefOf, inertBody, storedHtmlFromDom); `legacy/session-bridge` (readSession, runCommand, sessionTextPorts)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (internDataUrl, persist); `adapters/identity/ids` (makeId, randomHexBytes, randomIds)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-selection` (cellSelection)
- Imported by numbered files: `05g-scene-clip` (brollIdsTaken, clipboardOfCell, freshBrollIds)
- Imported by the wiring: `bootstrap/wiring/editor` (copyFromCell, hasMediaFiles, pasteIntoCell, readClipboardFiles)
- Imported by tests: 6 files

### `05d-draft-edit`

317 lines.

- Reaches through bridges: `legacy/richtext` (fromHtml, inertBody, sanitizeHtml, storedHtmlFromDom)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-selection` (cellSelection, setCellSelection); `features/editing/cell-page` (isDraftBox)
- Imported by numbered files: `05-render` (appendDraftMedia, draftModel, editDraft); `10-comments` (resetDraftHistory)
- Imported by the wiring: `bootstrap/wiring/comments` (appendDraftMedia, draftRedo, draftUndo, noteDraftBeforeInput, noteDraftComposition, noteDraftFocus, pasteIntoDraft); `bootstrap/wiring/editor` (draftRedo, draftUndo, noteDraftInput, pasteIntoDraft)
- Imported by tests: 1 file

### `05e-gallery-overlay`

701 lines.

- Imports from numbered files: `04-richtext` (cssAttr); `05-render` (galleryBadgeHtml, gallerySlotPictureHtml, slotPoster); `05v-video` (embedRefusal, fetchThumbnailRecord, playerSrc, thumbnailsAllowed); `05w-annotate` (openAnnotator); `06-rows` (hasSessionVideo, openGalleryLink, sessionVideoUrl); `12a-undo` (breakUndoCoalescing, lastUndoEntry, undo)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/editor-bridge` (cellEditing, pickPictureFor); `legacy/effects-bridge` (showActionToast, showToast); `legacy/preferences-bridge` (PREF_EVENT, preferences); `legacy/location-bridge` (reviewMode)
- Imports from adapters (a feature may not): `adapters/storage/02d-gallery` (annotateGallerySlot, moveGallerySlot, removeGallerySlot, rowSlots, setVideoThumbnail, videoLinkKey, videoLinkLabel); `adapters/formats/video-host` (videoHostLabel)
- Imported by the wiring: `bootstrap/wiring/editor` (announceGalleryEdit); `bootstrap/wiring/panels` (refreshGalleryOverlay); `bootstrap/wiring/views` (openGalleryOverlay)
- Imported by tests: 3 files

### `05f-rundown`

1061 lines.

- Imports from numbered files: `01b-hide-shot` (revealRow); `04-richtext` (cssAttr); `06-rows` (clearDropMarkers)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession); `legacy/app-actions` (appActions); `legacy/cache-freeze` (cacheSeal); `legacy/richtext` (cellOf); `legacy/editor-bridge` (cellEditing, rowDrag); `legacy/preferences-bridge` (PREF_EVENT, preferences); `legacy/document-ports` (productionReaders); `legacy/location-bridge` (reviewMode)
- Imported by numbered files: `01-scene-status` (setRundownExtraSeconds); `05p-rundown-presence` (goToScene, rundownEdge); `05t-target` (onRundownPaint, rundownLayout)
- Imported by bridges: `legacy/this-document-actions` (isRundownMinimized, toggleRundownMinimized)
- Imported by the wiring: `bootstrap/wiring/panels` (renderRundown)
- Imported by tests: 3 files

### `05g-scene-clip`

405 lines.

- Imports from numbered files: `02-state` (makeId, migrateRows); `04c-doc-model` (cellOf, commentIds, fromHtml, normalizeCell, syncCommentAnchors, toHtml, toPlainText); `05c-clipboard` (brollIdsTaken, clipboardOfCell, freshBrollIds); `07-production-tags` (collectTagsFromRows); `08c-broll` (recordPastedBroll)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/richtext` (inertBody)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (dataUrlForSync, internDataUrl, queuePersist)
- Imported by numbered files: `05h-scene-select` (SCENES_MIME, buildScenePayload, parseScenePayload, scenePaste, scenesOnClipboard, setLiveCut); `06-rows` (isBlankScene)
- Imported by tests: 3 files

### `05h-scene-select`

527 lines.

- Imports from numbered files: `03-sync` (stampRow); `04-richtext` (cssAttr); `05g-scene-clip` (SCENES_MIME, buildScenePayload, parseScenePayload, scenePaste, scenesOnClipboard, setLiveCut); `06-rows` (closeRowMenus); `07-production-tags` (scheduleProductionRefresh); `12a-undo` (breakUndoCoalescing, flushEdits, lastUndoEntry, undo); `13-hosted` (onServerDoc); `18b-file-menu` (startNewScript)
- Reaches through bridges: `legacy/save-bridge` (autoSavePolicy); `legacy/session-bridge` (REVIEW_ONLY, currentDocument, runCommand); `legacy/review-wording` (VIEWING_ONLY); `legacy/editor-bridge` (cellEditing, rowDrag); `legacy/effects-bridge` (showActionToast, showToast); `legacy/preferences-bridge` (viewFlags); `legacy/location-bridge` (reviewMode)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (ensureBytes); `adapters/identity/ids` (randomHexBytes)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-page` (isScriptCell)
- Imported by the wiring: `bootstrap/wiring/editor` (pasteScenesAt)
- Imported by tests: 2 files

### `05p-rundown-presence`

196 lines.

- Imports from numbered files: `05f-rundown` (goToScene, rundownEdge); `13a-presence` (presenceShown)
- Reaches through bridges: `legacy/session-bridge` (currentDocument)
- Imported by the wiring: `bootstrap/wiring/panels` (paintRundownPresence)
- Imported by tests: 1 file

### `05r-read-time`

155 lines.

- Imports from numbered files: `04-richtext` (cssAttr); `12a-undo` (redo, undo)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/editor-bridge` (paintGuard); `legacy/session-bridge` (REVIEW_ONLY, currentDocument, readSession, runCommand, sessionStamps); `legacy/effects-bridge` (showToast); `legacy/location-bridge` (reviewMode)
- Imported by tests: 4 files

### `05s-script-zoom`

218 lines.

- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/app-actions` (appActions); `legacy/preferences-bridge` (PREF_EVENT, preferences, viewFlags)
- Imported by bridges: `legacy/zoom-actions` (resetScriptScale, scriptViewActive, stepScriptScale)
- Imported by tests: 2 files

### `05t-target`

128 lines.

- Imports from numbered files: `05f-rundown` (onRundownPaint, rundownLayout)
- Reaches through bridges: `legacy/effects-bridge` (showToast); `legacy/session-bridge` (currentDocument, runDocumentEdit); `legacy/location-bridge` (reviewMode)
- Imported by numbered files: `03-sync` (targetSectionHtml, wireTargetSection)
- Imported by the wiring: `bootstrap/wiring/panels` (paintTargetOverlay)
- Imported by tests: 3 files

### `05v-video`

135 lines.

- Imports from numbered files: `12a-undo` (foldIntoEdit)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/preferences-bridge` (preferences)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (intern, persist); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `05e-gallery-overlay` (embedRefusal, fetchThumbnailRecord, playerSrc, thumbnailsAllowed)
- Imported by the wiring: `bootstrap/wiring/editor` (thumbnailsAfterPaste)
- Imported by tests: 2 files

### `05w-annotate`

836 lines.

- Imports from numbered files: `05-render` (slotPoster)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession); `legacy/editor-bridge` (cellEditing); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/effects-bridge` (showToast); `legacy/location-bridge` (reviewMode)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (ensureBytes, intern, persist, urlForSync)
- Imported by numbered files: `05e-gallery-overlay` (openAnnotator)
- Imported by the wiring: `bootstrap/wiring/panels` (refreshAnnotator)
- Imported by tests: 2 files

### `06-rows`

448 lines.

- Imports from numbered files: `04-richtext` (safeHref, safeId, storedHtmlFromDom); `05g-scene-clip` (isBlankScene); `12a-undo` (breakUndoCoalescing)
- Reaches through bridges: `legacy/production-editing-bridge` (deleteConfirmation); `legacy/session-bridge` (REVIEW_ONLY, currentDocument, onDocumentReplaced, readSession, runCommand, sessionStamps, sessionTextPorts); `legacy/review-wording` (VIEWING_ONLY); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/editor-bridge` (cellEditing, rowDrag); `legacy/effects-bridge` (showToast)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (internDataUrl, persist); `adapters/identity/ids` (makeId); `adapters/desktop/desktop-port` (desktopPort)
- Imports from feature folders (a feature may not import another feature): `features/rows/delete-button` (armDeleteButton, disarmDeleteButton); `features/editing/cell-selection` (cellSelection, setCellSelection); `features/editing/caret` (placeCaretAtTextOffset)
- Imported by numbered files: `05e-gallery-overlay` (hasSessionVideo, openGalleryLink, sessionVideoUrl); `05f-rundown` (clearDropMarkers); `05h-scene-select` (closeRowMenus); `08d-broll-panel` (focusRowField); `19-writer` (splitRowFieldCore)
- Imported by the wiring: `bootstrap/wiring/comments` (compressImageFile); `bootstrap/wiring/editor` (addRow, addRowAndFocus, armDelete, capturePastePlace, clearDropMarkers, closeRowMenus, compressImageFile, focusRowField, grantVideoFile, handleImageFile, moveRow, openGalleryLink, removeImage, removeImageLink, restorePastePlace, rowMenuKeydown, setDropMarkerForRow, showPictureNotAdded, splitCellField, stopDragScroll, swapAdjacentRows, toggleRowMenu, updateDragScroll, videoFirstFrame); `bootstrap/wiring/overlay` (closeRowMenus)
- Imported by tests: 5 files

### `07-production-tags`

664 lines, in the import loop.

- Imports from numbered files: `04-richtext` (inertBody, safeId, sanitizeHtml); `07b-plain-tags` (plainTagOpen); `09-find-replace` (domRangeFor); `12a-undo` (breakUndoCoalescing)
- Reaches through bridges: `legacy/production-index-bridge` (productionIndex); `legacy/document-ports` (productionReaders); `legacy/richtext` (cellOf); `legacy/session-bridge` (currentDocument, readSession, requestRefresh, runDocumentEdit, sessionStamps, stampDocument); `legacy/editor-bridge` (cellEditing, focusMemory); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (viewFlags)
- Imports from adapters (a feature may not): `adapters/identity/ids` (randomIds)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-dom` (domToPos)
- Imported by numbered files: `05-render` (openTagComposer, productionIndexStats, resetProductionIndexStats, scheduleUntaggedScan, tagFieldOccurrences); `05g-scene-clip` (collectTagsFromRows); `05h-scene-select` (scheduleProductionRefresh); `07b-plain-tags` (isInsideTagOrLink); `08-production-panels` (tagStatusLampHtml); `08c-broll` (isInsideTagOrLink, scheduleIdleRefresh); `19-writer` (hideTagGhost, scheduleIdleRefresh); `20d-formats` (tagFieldOccurrences)
- Imported by other `src/js` files: `_entry` (bulkTagCell, runIdleRefresh)
- Imported by the wiring: `bootstrap/wiring/editor` (acceptTagGhost, acceptUntaggedMention, hideTagGhost, hideUntaggedPrompt, maybeAutoTagShortcut, scheduleProductionRefresh, scheduleUntaggedScan, tagGhost, untaggedSuggestion, updateTagGhost, updateUntaggedPrompt); `bootstrap/wiring/overlay` (hideTagGhost, tagGhost); `bootstrap/wiring/panels` (onTagged); `bootstrap/wiring/production` (acceptTagGhost, acceptUntaggedMention, applyTag, closeTagComposer, hideTagGhost, hideUntaggedPrompt, renderTagCategories, tagKey)
- Imported by tests: 47 files; by tools: 1 file

### `07b-plain-tags`

259 lines, in the import loop.

- Imports from numbered files: `07-production-tags` (isInsideTagOrLink)
- Reaches through bridges: `legacy/editor-bridge` (cellEditing); `legacy/richtext` (fromHtml, storedHtmlFromDom); `legacy/session-bridge` (currentDocument)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-dom` (domToPos); `features/editing/cell-selection` (cellSelection, setCellSelection)
- Imported by numbered files: `07-production-tags` (plainTagOpen)
- Imported by the wiring: `bootstrap/wiring/editor` (cancelPlainTag, closePlainTag, maybeOpenPlainTag, plainTagEmptyAtCaret, plainTagOpen, refreshPlainTag); `bootstrap/wiring/panels` (onPlainTagged); `bootstrap/wiring/production` (closePlainTag, plainTagOpen, refreshPlainTag)
- Imported by tests: 4 files

### `08-production-panels`

1106 lines, in the import loop.

- Imports from numbered files: `01b-hide-shot` (revealRow); `03-sync` (openSidePanel, syncPanelClass); `04-richtext` (cssAttr, plainText, safeId); `07-production-tags` (tagStatusLampHtml); `12a-undo` (breakUndoCoalescing); `13a-presence` (personColor)
- Reaches through bridges: `legacy/production-editing-bridge` (bulkDeleteArmed, clearProductionSelection, deleteConfirmation, disarmBulkDelete, productionSelection, pruneProductionSelection, selectedKeys); `legacy/document-ports` (productionReaders); `legacy/effects-bridge` (showToast); `legacy/production-index-bridge` (productionIndex); `legacy/session-bridge` (currentDocument, readSession, runDocumentEdit, sessionStamps); `legacy/tag-rewrites` (retagMentions, retagRewrites); `legacy/location-bridge` (reviewBlocked, reviewMode)
- Imports from adapters (a feature may not): `adapters/formats/export-projections` (breakdownRows, breakdownTable); `adapters/identity/ids` (randomIds)
- Imported by numbered files: `03b-side-panels` (closeGearPanel, closeProductionPanel); `20-teleprompter` (addPersonForTag, renderProduction, saveTagRename, setTagNotes, setTagOwner)
- Imported by bridges: `legacy/view-actions` (closeGearPanel, closeProductionPanel, openGearPanel, openProductionPanel)
- Imported by the wiring: `bootstrap/wiring/editor` (renderProduction); `bootstrap/wiring/overlay` (renderProduction); `bootstrap/wiring/panels` (productionPanelsOpen, renderProduction, updateGearCount, updateProductionCount); `bootstrap/wiring/production` (IS_TOUCH, addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, armRemoveTag, bulkAddPerson, bulkDeleteSelected, bulkSetOwner, bulkSetStatus, closeGearPanel, closeProductionPanel, handleSelectionClick, jumpToTag, openProductionPanel, renderGearList, renderProduction, saveTagRename, setTagNotes, setTagOwner, setTagStatus, tagAllMentions, toggleCardSelection)
- Imported by tests: 10 files

### `08c-broll`

282 lines.

- Imports from numbered files: `04-richtext` (ensureTrailingCaretSpot, inertBody, sanitizeHtml); `07-production-tags` (isInsideTagOrLink, scheduleIdleRefresh)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/editor-bridge` (cellEditing, paintGuard); `legacy/plain-text` (htmlToPlainText); `legacy/richtext` (cellOf, scriptCellOf); `legacy/session-bridge` (currentDocument, heldDocument, readSession, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts); `legacy/production-index-bridge` (productionIndex)
- Imports from adapters (a feature may not): `adapters/identity/ids` (makeId, randomIds); `adapters/production/broll-anchors` (anchorBrollInRows, brollHtmlLines, brollKeyHtml)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-dom` (domToPos)
- Imported by numbered files: `05c-clipboard` (brollSeedOf); `05g-scene-clip` (recordPastedBroll); `08d-broll-panel` (addBrollProp, brollEntries, renameBrollInScript, updateBrollBadge); `11-import` (declineBrollAnchoring)
- Imported by other `src/js` files: `_entry` (derivedRecordsPlan)
- Imported by the wiring: `bootstrap/wiring/editor` (anchorBrollInLeftCell, maybeCaptureBroll, scheduleBrollRefresh); `bootstrap/wiring/panels` (scheduleBrollRefresh, updateBrollBadge)
- Imported by tests: 15 files; by tools: 1 file

### `08d-broll-panel`

1360 lines, in the import loop.

- Imports from numbered files: `01b-hide-shot` (revealRow); `03-sync` (openSidePanel, syncPanelClass); `03b-side-panels` (closeAllSidePanels); `04-richtext` (cssAttr, plainText); `06-rows` (focusRowField); `08c-broll` (addBrollProp, brollEntries, renameBrollInScript, updateBrollBadge); `12a-undo` (breakUndoCoalescing); `13a-presence` (personColor); `18-local-files` (exportAs)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/production-index-bridge` (productionIndex); `legacy/app-actions` (appActions); `legacy/effects-bridge` (showToast); `legacy/location-bridge` (reviewBlocked, reviewMode); `legacy/session-bridge` (currentDocument, readSession, runDocumentEdit)
- Imports from adapters (a feature may not): `adapters/formats/export-projections` (FILTERS, PAGE_GROUPS, brollGroups, brollShotListForPrint, brollTable, filterCounts, matchesFilter, oneOf, pageSummaryText, sceneLabel, shotRecordForFile, startOf); `adapters/identity/ids` (randomIds)
- Imports from feature folders (a feature may not import another feature): `features/broll/mount` (mountBroll)
- Imported by numbered files: `03b-side-panels` (closeBrollPanel); `18-local-files` (brollPrintView)
- Imported by bridges: `legacy/screen-state` (brollPageOpen); `legacy/view-actions` (closeBrollPanel, openBrollPanel)
- Imported by the wiring: `bootstrap/app` (mountBrollFeature, stopBrollFeature); `bootstrap/wiring/panels` (runBrollRefresh)
- Imported by tests: 11 files

### `09-find-replace`

518 lines.

- Imports from numbered files: `01b-hide-shot` (revealRow); `04-richtext` (cssAttr, inertBody, sanitizeHtml); `12a-undo` (breakUndoCoalescing)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, readSession, runDocumentEdit, sessionStamps); `legacy/richtext` (cellOf); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (viewFlags); `legacy/location-bridge` (reviewBlocked)
- Imported by numbered files: `07-production-tags` (domRangeFor); `19-writer` (closeFindBar)
- Imported by bridges: `legacy/this-document-actions` (openFindBar)
- Imported by the wiring: `bootstrap/wiring/production` (bulkTagOpen, closeBulkTag, closeFindBar, findQueryChanged, leaveFindAtMatch, pickBulkTagCat, replaceAll, replaceCurrent, runBulkTag, stepFind, toggleBulkTag)
- Imported by tests: 5 files

### `10-comments`

1036 lines, in the import loop.

- Imports from numbered files: `01b-hide-shot` (revealRow); `03-sync` (openSidePanel, pushSnapshot, syncPanelClass); `04-richtext` (cssAttr, inertBody, plainText, safeId, sanitizeHtml); `05-render` (editableCellHtml); `05d-draft-edit` (resetDraftHistory); `13a-presence` (personColor)
- Reaches through bridges: `legacy/production-editing-bridge` (deleteConfirmation); `legacy/session-bridge` (currentDocument, readSession, runDocumentEdit, sessionStamps); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/editor-bridge` (editorSelection); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (preferences); `legacy/save-bridge` (autoSavePolicy, resumeAutoSave); `legacy/location-bridge` (reviewBlocked, reviewMode)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (blobImgHtml); `adapters/formats/export-projections` (commentBodyText, commentEntries, formatTimestampAbsolute); `adapters/identity/ids` (makeId, nowIso)
- Imported by numbered files: `03-sync` (formatTimestamp, getSavedAuthorName); `03b-side-panels` (closeCommentsPanel); `05-render` (formatTimestamp, openCommentComposer); `13-hosted` (captureReplyDrafts, formatTimestamp, getSavedAuthorName, renderComments); `13a-presence` (getSavedAuthorName); `13b-collaborate` (getSavedAuthorName); `18-local-files` (formatTimestamp); `20s-settings` (getSavedAuthorName)
- Imported by bridges: `legacy/help-actions` (showTaggingHelp); `legacy/view-actions` (closeCommentsPanel, openCommentsPanel)
- Imported by the wiring: `bootstrap/wiring/comments` (AUTHOR_NAME_FIELDS, armDeleteComment, captureCommentComposer, captureReplyDrafts, closeCommentComposer, closeCommentsPanel, jumpToAnchor, limitAuthorNameField, postComment, postReply, resetCommentBindings, restoreConflictValue, setCommentAssignee, setCommentAssigneeFilter, setCommentFilterMode, setCommentSortMode, toggleCommentMenu, toggleReplyComposer, toggleResolve); `bootstrap/wiring/editor` (captureReplyDrafts, jumpToComment, openCommentsPanel, renderComments, syncAnchorResolvedClasses); `bootstrap/wiring/overlay` (closeCommentComposer, closeCommentsPanel); `bootstrap/wiring/panels` (captureReplyDrafts, commentsChanged, renderComments, syncAnchorResolvedClasses)
- Imported by tests: 16 files

### `11-import`

574 lines, in the import loop.

- Imports from numbered files: `03-sync` (pushSnapshot, stampRow); `04-richtext` (cssAttr, sanitizeHtml); `08c-broll` (declineBrollAnchoring)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/richtext` (cellOf, inertBody); `legacy/session-bridge` (REVIEW_ONLY, editAllowed, noteSessionEdit, readSession, runCommand, sessionStamps); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/effects-bridge` (showToast)
- Imports from adapters (a feature may not): `adapters/formats/import-rows` (normalizeImportedRows); `adapters/production/broll-anchors` (anchorBrollInRows); `adapters/identity/ids` (randomIds); `adapters/formats/docx` (docxToRows); `adapters/formats/csv` (csvToRows); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `18-local-files` (detectTwoColumnFormat, parseImportRows); `20d-formats` (handleImportFile, parseMarkdownTable); `20j-newtab` (openGdocModal, openImportModal)
- Imported by bridges: `legacy/share-actions` (openGdocModal, openImportModal)
- Imported by the wiring: `bootstrap/wiring/views` (captureImportPreview, clearPendingFileRows, closeGdocModal, closeImportModal, confirmGdocImport, confirmImport, handleImportFile, maybeAutoDetectTwoColumn, updateImportPreview)
- Imported by tests: 6 files

### `12-dirty-toast`

182 lines, in the import loop.

- Imports from numbered files: `02b-doc-id` (syncDocIdentity); `13-hosted` (onServerDoc); `13a-presence` (personColorsWithMine); `20g-drafts` (noteDraftChange)
- Reaches through bridges: `legacy/location-bridge` (amendHome, currentHome, homeConn, reviewMode, serverStatus); `legacy/save-bridge` (autoSavePolicy, autoSaveTarget, noteSaveChange, saveBusy, scheduleAutoSave, unsavedChanges); `legacy/effects-bridge` (showActionToast, showToast); `legacy/preferences-bridge` (preferences)
- Imported by numbered files: `03-sync` (showToast); `03a-history-store` (showToast); `13-hosted` (showActionToast, showToast); `20f-desktop` (showToast); `20g-drafts` (showToast); `20h-appdata` (showToast)
- Imported by other `src/js` files: `_entry` (legacySessionEffects)
- Imported by the wiring: `bootstrap/actions` (showRefusal); `bootstrap/wiring/document-chrome` (saveStatusListeners); `bootstrap/wiring/startup` (hasUnsavedChanges, updateSaveStatus); `bootstrap/wiring/views` (updateSaveStatus)
- Imported by tests: 3 files

### `12a-undo`

981 lines.

- Imports from numbered files: `02-state` (STATE_FIELDS)
- Reaches through bridges: `legacy/richtext` (fromHtml); `legacy/session-bridge` (heldDocument)
- Imported by numbered files: `05-render` (trackDocument); `05c-clipboard` (breakUndoCoalescing, flushEdits); `05e-gallery-overlay` (breakUndoCoalescing, lastUndoEntry, undo); `05h-scene-select` (breakUndoCoalescing, flushEdits, lastUndoEntry, undo); `05r-read-time` (redo, undo); `05v-video` (foldIntoEdit); `06-rows` (breakUndoCoalescing); `07-production-tags` (breakUndoCoalescing); `08-production-panels` (breakUndoCoalescing); `08d-broll-panel` (breakUndoCoalescing); `09-find-replace` (breakUndoCoalescing); `18-local-files` (flushEdits); `19-writer` (breakUndoCoalescing, lastUndoEntry, nextRedoEntry, undoLifetime, undoMark, undoSerial)
- Imported by bridges: `legacy/undo-adapter` (absorbRemoteChange, adoptDocument, noteEdit, noteRemoteChange, routeUndoReplays)
- Imported by the wiring: `bootstrap/wiring/editor` (breakUndoCoalescing, caretAfterStep, compositionUndoMark, configureUndo, dropEmptyStepsSince, flushEdits, lastUndoEntry, redo, settleAfterApply, undo)
- Imported by tests: 67 files

### `13-hosted`

2522 lines, in the import loop.

- Imports from numbered files: `02-state` (escapeHtml, migrateRows); `02b-doc-id` (copyDocHistorySafe, migrateDocument); `03-sync` (applyMerge, getEditorName, mergeStates, pushSnapshot, reportMerge, setBaseState, stashLocalWork); `04-richtext` (cssAttr, inertBody); `10-comments` (captureReplyDrafts, formatTimestamp, getSavedAuthorName, renderComments); `12-dirty-toast` (showActionToast, showToast); `13b-collaborate` (maybeAskGuestName); `20e-connect` (openPinDialog, openServersDialog); `18b-file-menu` (setMenuItemReason); `20j-newtab` (closeNewTabPage); `20g-drafts` (armBrowserServerDraft, offerBrowserDraftAfterLinkOff)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, mergeBase, stampDocument); `legacy/location-bridge` (amendHome, currentConn, currentHome, documentLocation, handServerCheckTo, reviewMode, serverHomeId, serverStatus, setHome, stillOnServer); `legacy/preferences-bridge` (preferences); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/save-bridge` (confirmSavedNow, haltAutoSave, requestSave, resumeAutoSave, saveBusy, saveChanges, saveDoc, scheduleAutoSave, unsavedChanges); `legacy/recovery-bridge` (conflictStash, draftResume); `legacy/transition-bridge` (captureOperation, documentTransitions, stillOwns); `legacy/file-delivery` (deliverFile); `legacy/review-wording` (VIEWING_ONLY)
- Imports from adapters (a feature may not): `adapters/identity/ids` (mintDocId, nowIso); `adapters/transport/server-address` (shortHost); `adapters/storage/02c-blobs` (bytesForSync, ensureBytes, forgetRemoteMisses, inlineStateImages, intern, recordFor, setRemoteSource); `adapters/transport/server-transport` (CLIENT_GENERATION, CLIENT_HEADER, apiError, createServerTransport); `adapters/transport/server-join` (joinServer); `adapters/desktop/desktop-port` (desktopDrive, desktopPort)
- Imports from feature folders (a feature may not import another feature): `features/notices/busy` (withBusyBar)
- Imported by numbered files: `02b-doc-id` (onServerDoc); `05h-scene-select` (onServerDoc); `12-dirty-toast` (onServerDoc); `13a-presence` (apiUrl, notePresenceRev, onServerDoc, serverTransport); `13b-collaborate` (apiFetch, applyHealth, applyReviewMode, clearServerToken, finishServerDetect, isLinkGuest, onServerDoc, pointTabAt, publishToServer, rememberTokenForServer, rememberedTokenForServer, serverDocShareUrl, setServerToken, shareAccessNote); `18-local-files` (blobSourceNow, onServerDoc); `18b-file-menu` (applyReviewMode); `20a-update` (arrivingOnLink); `20b-onboarding` (arrivingOnLink, launcherFetch); `20e-connect` (applyReviewMode, fetchReviewLink, finishServerDetect, pointTabAt, setServerToken); `20f-desktop` (openServerDoc, pointTabAt); `20g-drafts` (onServerDoc); `20j-newtab` (arrivingOnLink)
- Imported by other `src/js` files: `_entry` (serverSaveDestination)
- Imported by bridges: `legacy/share-actions` (openDriveModal, openServerPicker, publishToServer, serverOpenItemState, serverPublishItemState); `legacy/view-actions` (VIEWING_ONLY)
- Imported by the wiring: `bootstrap/wiring/editor` (onServerDoc); `bootstrap/wiring/views` (armDriveDelete, armServerDelete, captureServerPicker, closeDriveModal, closeServerPicker, driveCancelRename, driveConnect, driveCreateFolder, driveCrumbTo, driveItemById, driveListCurrent, driveOpenItem, driveSaveCredsFromForm, driveSaveRename, driveShowCredsForm, driveSignIn, driveSignOut, driveStartRename, driveUploadFiles, openServerDoc, toggleDriveNewFolder)
- Imported by tests: 15 files

### `13a-presence`

343 lines, in the import loop.

- Imports from numbered files: `04-richtext` (cssAttr); `10-comments` (getSavedAuthorName); `13-hosted` (apiUrl, notePresenceRev, onServerDoc, serverTransport)
- Reaches through bridges: `legacy/location-bridge` (homeConn, serverHomeId, serverStatus); `legacy/session-bridge` (currentDocument); `legacy/transition-bridge` (captureOperation, stillOwns); `legacy/preferences-bridge` (preferences)
- Imported by numbered files: `03-sync` (personColor); `05-render` (personColor); `05p-rundown-presence` (presenceShown); `08-production-panels` (personColor); `08d-broll-panel` (personColor); `10-comments` (personColor); `12-dirty-toast` (personColorsWithMine)
- Imported by the wiring: `bootstrap/wiring/document-chrome` (onPresenceRecolor); `bootstrap/wiring/panels` (onPresencePaint, paintPresence); `bootstrap/wiring/screen` (onPresenceRecolor)
- Imported by tests: 2 files

### `13b-collaborate`

906 lines, in the import loop.

- Imports from numbered files: `03-sync` (personSwatchesHtml); `10-comments` (getSavedAuthorName); `13-hosted` (apiFetch, applyHealth, applyReviewMode, clearServerToken, finishServerDetect, isLinkGuest, onServerDoc, pointTabAt, publishToServer, rememberTokenForServer, rememberedTokenForServer, serverDocShareUrl, setServerToken, shareAccessNote); `20s-settings` (openSettings)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/location-bridge` (currentConn, currentHome, documentLocation, reviewMode, serverHomeId, serverStatus); `legacy/app-actions` (appActions); `legacy/preferences-bridge` (onPreferenceChange, preferences, preferencesStarted); `legacy/effects-bridge` (copyShareText, setMenuItemReason, showToast)
- Imports from adapters (a feature may not): `adapters/desktop/desktop-port` (desktopPort); `adapters/transport/server-join` (joinServer)
- Imported by numbered files: `13-hosted` (maybeAskGuestName); `20s-settings` (DEFAULT_COLLAB_SERVER, collabServerView, normalizeCollabServer, readCollabServer, signOutCollab)
- Imported by bridges: `legacy/share-actions` (collaborateBlockedReason, openCollaborate)
- Imported by tests: 5 files

### `14-export`

332 lines, in the import loop.

- Imports from numbered files: `00-prelude` (rememberLastFileHandle); `02-state` (migrateRows); `02b-doc-id` (copyDocHistorySafe, syncDocIdentity); `03-sync` (applyMerge, getEditorName, setBaseState); `14b-export-kit` (captureExportDocument); `20d-formats` (buildMarkdownProject, buildSplitpageFile, fileImagesMissing)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, stampDocument); `legacy/location-bridge` (amendHome, currentHome, documentLocation, fileHome, serverStatus, setHome); `legacy/file-delivery` (deliverFile); `legacy/save-bridge` (autoSavePolicy, confirmSavedNow, flushAutoSave, haltAutoSave, resumeAutoSave, saveChanges); `legacy/effects-bridge` (showToast, warnImagesLeftOut); `legacy/preferences-bridge` (preferences); `legacy/recovery-bridge` (conflictStash)
- Imports from adapters (a feature may not): `adapters/identity/ids` (mintDocId, nowIso); `adapters/storage/02c-blobs` (ensureBytes); `adapters/desktop/desktop-handle` (makeDesktopHandle); `adapters/files/file-target` (checkFileConflict, existingTarget, isAbort, pickTarget, writeToHandle); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `18a-local-merge` (applyStashedWork); `20g-drafts` (applyStashedWork)
- Imported by other `src/js` files: `_entry` (legacyFileDestination, legacySavePorts)
- Imported by the wiring: `bootstrap/wiring/startup` (applyStashedWork, updateAutoSaveMenu)
- Imported by tests: 4 files

### `14b-export-kit`

94 lines.

- Imports from numbered files: `02-state` (migrateRows)
- Reaches through bridges: `legacy/session-bridge` (readSession); `legacy/preferences-bridge` (preferences)
- Imports from adapters (a feature may not): `adapters/identity/ids` (randomIds, systemClock); `adapters/formats/export-assets` (assetPorts)
- Imported by numbered files: `14-export` (captureExportDocument); `18-local-files` (captureExportDocument, loadExportAssets); `18c-export-dialog` (captureExportDocument); `20d-formats` (captureExportDocument, exportDocumentOf)
- Imported by tests: 60 files

### `18-local-files`

694 lines, in the import loop.

- Imports from numbered files: `12a-undo` (flushEdits); `00-prelude` (SCHEMA_VERSION, loadLastFileHandle, rememberLastFileHandle); `02b-doc-id` (migrateDocument, standaloneHtmlFor, syncDocIdentity); `03-sync` (pushSnapshot, stampRow); `08d-broll-panel` (brollPrintView); `10-comments` (formatTimestamp); `14b-export-kit` (captureExportDocument, loadExportAssets); `11-import` (detectTwoColumnFormat, parseImportRows); `13-hosted` (blobSourceNow, onServerDoc); `18a-local-merge` (offerFileMerge, resetMergeOffer); `18b-file-menu` (toggleFileMenu); `18c-export-dialog` (isExportAction, rememberExport); `20d-formats` (applyMarkdownProject, parseMarkdownProject); `20j-newtab` (closeNewTabPage)
- Reaches through bridges: `legacy/richtext` (inertBody, sanitizeHtml); `legacy/session-bridge` (currentDocument, noteAbsorbedDirty, noteReload); `legacy/transition-bridge` (documentTransitions); `legacy/save-bridge` (autoSavePolicy, confirmSavedNow, fileConflicts, requestSave, unsavedChanges, unsavedFor); `legacy/file-delivery` (deliverFile); `legacy/location-bridge` (amendHome, currentHome, fileHome, importHome, serverStatus, setHome); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/app-actions` (appActions); `legacy/export-formats` (exportFormats); `legacy/effects-bridge` (setMenuItemLabel, showToast, warnImagesLeftOut)
- Imports from adapters (a feature may not): `adapters/files/file-target` (checkFileConflict); `adapters/formats/export-assets` (exportAssetsRequest); `adapters/formats/docx` (docxToRows); `adapters/formats/csv` (csvToRows); `adapters/formats/import-rows` (normalizeImportedRows); `adapters/desktop/desktop-handle` (makeDesktopHandle); `adapters/formats/splitpage-file` (parseSplitpageFile); `adapters/desktop/desktop-port` (desktopPort)
- Imports from feature folders (a feature may not import another feature): `features/notices/busy` (beginBusy, endBusy, withBusyBar)
- Imported by numbered files: `08d-broll-panel` (exportAs); `18a-local-merge` (parseProjectFileState); `18b-file-menu` (openProjectFile); `18c-export-dialog` (exportBaseName, exportFileName, handleFileMenuAction, runExportAction); `18d-command-menu` (runExportAction); `20-teleprompter` (adoptProjectState, parseProjectFileState); `20b-onboarding` (onFileMenuChoice); `20d-formats` (openProjectFile); `20f-desktop` (openProjectFile); `20g-drafts` (adoptProjectState, parseProjectFileState); `20j-newtab` (openLocalFile, openProjectFile)
- Imported by other `src/js` files: `_entry` (importSaveDestination)
- Imported by bridges: `legacy/file-actions` (openLocalFile); `legacy/native-menu` (handleFileMenuAction, noteFileMenuChoice); `legacy/share-actions` (saveBackItemState, saveBackToFile)
- Imported by the wiring: `bootstrap/wiring/document-chrome` (fileChipListeners, mirrorFileChipToWriter, updateFileChip); `bootstrap/wiring/editor` (runExport); `bootstrap/wiring/production` (exportAs, runExport); `bootstrap/wiring/startup` (tryResumeLastProject); `bootstrap/wiring/views` (buildFileData, exportAs, handleFileMenuAction, hideResumeBanner, openProjectFile, pendingResumeHandle, reloadFileFromDisk, reloadProjectFromDisk, resumeFromHandle, saveBackToFile, showFileConflictView)
- Imported by tests: 38 files

### `18a-local-merge`

386 lines, in the import loop.

- Imports from numbered files: `02-state` (escapeHtml, migrateRows); `03-sync` (textMergeContext); `14-export` (applyStashedWork); `18-local-files` (parseProjectFileState)
- Reaches through bridges: `legacy/location-bridge` (amendHome, fileHome); `legacy/save-bridge` (fileConflicts); `legacy/plain-text` (htmlToPlainText); `legacy/session-bridge` (currentDocument, mergeBase)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (blobImgHtml, rowImage, rowImageKey); `adapters/storage/02d-gallery` (videoLinkLabel)
- Imported by numbered files: `18-local-files` (offerFileMerge, resetMergeOffer)
- Imported by the wiring: `bootstrap/wiring/views` (cancelMergeReview, confirmFileMerge, openMergeReview)
- Imported by tests: 1 file

### `18b-file-menu`

430 lines, in the import loop.

- Imports from numbered files: `02-state` (escapeHtml, makeId, migrateRows); `02b-doc-id` (syncDocIdentity); `03-sync` (pushSnapshot); `13-hosted` (applyReviewMode); `18-local-files` (openProjectFile); `20f-desktop` (canOpenPrompterInBrowser, canOpenPrompterInChromium); `20j-newtab` (closeNewTabPage)
- Imports from other `src/js` files: `_starters` (LONG_DEMO)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/location-bridge` (currentHome, reviewMode, serverStatus); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/transition-bridge` (NO_DESTINATION, documentTransitions); `legacy/effects-bridge` (setMenuItemLabel, setMenuItemReason, showToast); `legacy/save-bridge` (confirmSavedNow, saveBusy, unsavedChanges); `legacy/preferences-bridge` (preferences)
- Imports from adapters (a feature may not): `adapters/desktop/desktop-handle` (makeDesktopHandle); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `05h-scene-select` (startNewScript); `13-hosted` (setMenuItemReason); `18-local-files` (toggleFileMenu); `18c-export-dialog` (onFileMenuRefresh); `18d-command-menu` (IS_MAC, fileMenuOpen, keyChipWords, keyChipsHtml, refreshFileMenu, toggleFileMenu)
- Imported by bridges: `legacy/file-actions` (fileMenuOpen, toggleFileMenu); `legacy/help-actions` (openLongDemo); `legacy/native-menu` (toggleFileMenu); `legacy/share-actions` (pasteItemState, startNewScript)
- Imported by the wiring: `bootstrap/wiring/document-chrome` (refreshOpenFileMenu); `bootstrap/wiring/views` (toggleFileMenu, toggleSubmenu)
- Imported by tests: 8 files

### `18c-export-dialog`

650 lines, in the import loop.

- Imports from numbered files: `14b-export-kit` (captureExportDocument); `18-local-files` (exportBaseName, exportFileName, handleFileMenuAction, runExportAction); `18b-file-menu` (onFileMenuRefresh)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/export-formats` (exportFormats); `legacy/richtext` (cellOf); `legacy/effects-bridge` (setMenuItemLabel, setMenuItemReason, showToast)
- Imports from adapters (a feature may not): `adapters/formats/export-kit` (brollSummaryText, exportBrollScenes, exportComments, exportFacts, exportRuns); `adapters/formats/export-projections` (breakdownRows, sceneFacts); `adapters/formats/export-text` (exportMetaLine, toMarkdownDoc, toMarkdownTableDoc); `adapters/formats/docx` (narrationRows); `adapters/formats/print-colors` (tagPrintColor)
- Imported by numbered files: `18-local-files` (isExportAction, rememberExport); `18d-command-menu` (exportActionName, exportActionReason)
- Imported by bridges: `legacy/file-actions` (openExportDialog); `legacy/share-actions` (exportAgain, exportAgainItemState)
- Imported by tests: 2 files

### `18d-command-menu`

337 lines.

- Imports from numbered files: `18b-file-menu` (IS_MAC, fileMenuOpen, keyChipWords, keyChipsHtml, refreshFileMenu, toggleFileMenu); `18c-export-dialog` (exportActionName, exportActionReason); `18-local-files` (runExportAction)
- Reaches through bridges: `legacy/editor-bridge` (editorSelection); `legacy/app-actions` (appActions); `legacy/export-formats` (exportFormats); `legacy/screen` (askingFromLauncher, launcherShown)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-selection` (placeEditorSelection, rememberCellSelection)
- Imported by bridges: `legacy/file-actions` (closeCommandMenu, commandMenuOpen, openCommandMenu)
- Imported by tests: 3 files

### `19-writer`

383 lines, in the import loop.

- Imports from numbered files: `01-scene-status` (totalSeconds); `01b-hide-shot` (renderRowGroups); `03b-side-panels` (closeAllSidePanels); `04-richtext` (cssAttr, ensureTrailingCaretSpot, sanitizeHtml, storedHtmlFromDom); `05-render` (cellFormatState, editableCellHtml, toggleCellDirection, toggleCellFormat); `06-rows` (splitRowFieldCore); `07-production-tags` (hideTagGhost, scheduleIdleRefresh); `09-find-replace` (closeFindBar); `12a-undo` (breakUndoCoalescing, lastUndoEntry, nextRedoEntry, undoLifetime, undoMark, undoSerial)
- Reaches through bridges: `legacy/document-ports` (productionReaders); `legacy/plain-text` (htmlToPlainText); `legacy/review-wording` (VIEWING_ONLY); `legacy/session-bridge` (currentDocument, editAllowed, readSession, runCommand, sessionTextPorts); `legacy/editor-bridge` (cellEditing, editorSelection, focusMemory, paintGuard); `legacy/preferences-bridge` (preferences, viewFlags); `legacy/effects-bridge` (showToast)
- Imports from feature folders (a feature may not import another feature): `features/editing/cell-selection` (placeEditorSelection, rememberCellSelection); `features/editing/caret` (placeCaretAtTextOffset)
- Imported by numbered files: `20h-appdata` (applyWriterSize, readWriterSize); `20s-settings` (applyWriterSize, readWriterSize)
- Imported by bridges: `legacy/view-actions` (openWriter)
- Imported by the wiring: `bootstrap/wiring/editor` (cycleWriterGutter, onWriterFormat, onWriterKeydown, scheduleWriterStats, updateWriterFormatState, writerUndoStep); `bootstrap/wiring/overlay` (closeWriter); `bootstrap/wiring/panels` (drawWriter, paintWriterDraw, updateWriterStats); `bootstrap/wiring/views` (applyWriterSize, closeWriter, jumpFromWriterToRow)
- Imported by tests: 21 files

### `20-teleprompter`

1061 lines, in the import loop.

- Imports from numbered files: `00-prelude` (SpeechRecognitionCtor); `03b-side-panels` (closeAllSidePanels); `08-production-panels` (addPersonForTag, renderProduction, saveTagRename, setTagNotes, setTagOwner); `18-local-files` (adoptProjectState, parseProjectFileState); `20f-desktop` (canOpenPrompterInBrowser, createDesktopRecognition, desktopVoiceAvailable, desktopVoiceKnown, loadDesktopVoice, openPrompterInBrowser); `20j-newtab` (closeNewTabPage)
- Reaches through bridges: `legacy/location-bridge` (reviewBlocked, reviewMode, serverHomeId); `legacy/save-bridge` (autoSavePolicy); `legacy/document-ports` (productionReaders); `legacy/richtext` (cellOf); `legacy/editor-bridge` (focusMemory); `legacy/session-bridge` (currentDocument); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (preferences, viewFlags); `legacy/startup-bridge` (startupReady)
- Imports from adapters (a feature may not): `adapters/desktop/voice-relay` (createRelayRecognition, hasVoiceRelay, setVoiceRelay)
- Imports from feature folders (a feature may not import another feature): `features/tags/mount` (mountTagEntityContainer)
- Imported by numbered files: `20s-settings` (setPrompterFlip, setPrompterMirror, setPrompterSceneMode)
- Imported by bridges: `legacy/view-actions` (openPrompter)
- Imported by the wiring: `bootstrap/wiring/production` (wireTagEntityContainer); `bootstrap/wiring/views` (acquireWakeLock, applyPrompterSize, buildPrompterContent, closePrompter, cueSceneForCurrentPosition, disposePrompterView, promptSceneMode, prompterFlip, prompterMirror, setPrompterFlip, setPrompterMirror, setPrompterPlaying, setPrompterSceneMode, setPrompterSpeed, startVoiceFollow, stepPrompterSize, stepPrompterSpeed, stepScene, stopVoiceFollow, updatePrompterStatus, updateSceneReadout, updateVoiceAvailability)
- Imported by tests: 4 files

### `20a-update`

384 lines, in the import loop.

- Imports from numbered files: `13-hosted` (arrivingOnLink)
- Reaches through bridges: `legacy/preferences-bridge` (preferences)
- Imports from adapters (a feature may not): `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `20h-appdata` (readEmbeddedVersion); `20j-newtab` (desktopAppOffered, desktopAppUrl); `20s-settings` (renderDesktopAppNotice)
- Imported by bridges: `legacy/help-actions` (showAbout)
- Imported by the wiring: `bootstrap/wiring/views` (dismissDesktopAppNotice, dismissUpdateNotice, loadUpdateStatus, renderDesktopAppNotice)
- Imported by tests: 1 file

### `20b-onboarding`

337 lines.

- Imports from numbered files: `00-prelude` (loadLastFileHandle); `03b-side-panels` (closeAllSidePanels); `13-hosted` (arrivingOnLink, launcherFetch); `18-local-files` (onFileMenuChoice); `20e-connect` (addServerBookmark)
- Reaches through bridges: `legacy/location-bridge` (currentHome); `legacy/file-delivery` (deliverFile); `legacy/app-actions` (appActions); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (preferences); `legacy/recovery-bridge` (draftResume); `legacy/seed-check` (seedCheckPasses)
- Imports from adapters (a feature may not): `adapters/desktop/desktop-port` (desktopPort)
- Imported by bridges: `legacy/help-actions` (openOnboarding)
- Imported by tests: 1 file

### `20c-help`

351 lines.

- Imports from numbered files: `03b-side-panels` (closeAllSidePanels)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/app-actions` (appActions); `legacy/tour-pause` (handTourPauseTo); `legacy/effects-bridge` (showActionToast, showToast); `legacy/preferences-bridge` (preferences)
- Imported by bridges: `legacy/help-actions` (openHelp, startTour); `legacy/screen-state` (tourShowing)
- Imported by tests: 1 file

### `20d-formats`

263 lines, in the import loop.

- Imports from numbered files: `02-state` (legacyMdToHtml, makeId, migrateRows); `02b-doc-id` (adoptRestoredState, docIdEvents, initDocIdentityChannel, migrateDocument, reassignDocId, standaloneHtmlFor); `03-sync` (setBaseState, stashLocalWork); `07-production-tags` (tagFieldOccurrences); `11-import` (handleImportFile, parseMarkdownTable); `14b-export-kit` (captureExportDocument, exportDocumentOf); `18-local-files` (openProjectFile)
- Reaches through bridges: `legacy/location-bridge` (amendHome, documentLocation, fileHome); `legacy/richtext` (sanitizeHtml); `legacy/save-bridge` (autoSavePolicy, autoSaveTarget, flushAutoSave, saveDoc, toggleAutoSave); `legacy/session-bridge` (currentDocument, heldDocument)
- Imports from adapters (a feature may not): `adapters/formats/markdown-image` (MD_IMAGE_PREFIX_RE); `adapters/storage/02c-blobs` (inlineStateImages, internDataUrl, missingInlineImages, queuePersist, rowImageDataUrl); `adapters/formats/docx` (audioDirectionsHtml); `adapters/formats/export-text` (mdSceneCellSource, toMarkdownTableDoc); `adapters/formats/splitpage-file` (parseSplitpageFile)
- Imported by numbered files: `14-export` (buildMarkdownProject, buildSplitpageFile, fileImagesMissing); `18-local-files` (applyMarkdownProject, parseMarkdownProject)
- Imported by the wiring: `bootstrap/wiring/views` (finishMarkdownRowChoice)
- Imported by tests: 44 files

### `20e-connect`

511 lines, in the import loop.

- Imports from numbered files: `13-hosted` (applyReviewMode, fetchReviewLink, finishServerDetect, pointTabAt, setServerToken); `20f-desktop` (renderDesktopShareInfo)
- Reaches through bridges: `legacy/location-bridge` (checkServer, currentConn, currentHome, documentLocation, serverStatus, setHome); `legacy/file-delivery` (deliverFile); `legacy/app-actions` (appActions); `legacy/tour-pause` (interruptTourForDialog, offerTourResumeAfterDialog); `legacy/effects-bridge` (setMenuItemLabel, showToast)
- Imports from adapters (a feature may not): `adapters/transport/server-join` (joinServer); `adapters/transport/server-address` (shortHost)
- Imported by numbered files: `13-hosted` (openPinDialog, openServersDialog); `20b-onboarding` (addServerBookmark); `20f-desktop` (openServersDialog); `20h-appdata` (connectPortOr, newBookmarkId, renderConnect, saveBookmarks)
- Imported by bridges: `legacy/help-actions` (openServersDialog, serversMenuLabel)
- Imported by tests: 1 file

### `20f-desktop`

1009 lines, in the import loop.

- Imports from numbered files: `02b-doc-id` (reassignDocId); `03a-history-store` (isPristineSeedDocument); `04-richtext` (cssAttr); `12-dirty-toast` (showToast); `13-hosted` (openServerDoc, pointTabAt); `18-local-files` (openProjectFile); `20e-connect` (openServersDialog); `20g-drafts` (flushDraftNow)
- Reaches through bridges: `legacy/session-bridge` (currentDocument, noteSessionEdit); `legacy/location-bridge` (checkServer, currentConn, currentHome, fileHome, homeConn, serverHomeId, serverStatus, setHome); `legacy/recovery-bridge` (draftResume, recoveryStarted); `legacy/save-bridge` (saveDoc, unsavedChanges); `legacy/startup-bridge` (startupReady)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (setBackend); `adapters/storage/03c-history-idb` (hashText); `adapters/formats/bytes` (strBytes); `adapters/desktop/desktop-port` (desktopPort, restoreDesktop, useDesktopForTest); `adapters/desktop/desktop-handle` (makeDesktopHandle)
- Imported by numbered files: `18b-file-menu` (canOpenPrompterInBrowser, canOpenPrompterInChromium); `20-teleprompter` (canOpenPrompterInBrowser, createDesktopRecognition, desktopVoiceAvailable, desktopVoiceKnown, loadDesktopVoice, openPrompterInBrowser); `20e-connect` (renderDesktopShareInfo); `20g-drafts` (notifyDesktopDocumentState)
- Imported by bridges: `legacy/help-actions` (appDataImportShown); `legacy/share-actions` (canOpenPrompterInBrowser, canOpenPrompterInChromium, driveOpenShown, openPrompterInBrowser, openPrompterInChromium)
- Imported by the wiring: `bootstrap/actions` (runMenuCommandsWith); `bootstrap/wiring/document-chrome` (desktopDocumentListeners); `bootstrap/wiring/startup` (desktopBridge, initDesktop, notifyDesktopDocumentState); `bootstrap/wiring/views` (routeServerOpen)
- Imported by tests: 1 file

### `20g-drafts`

1011 lines, in the import loop.

- Imports from numbered files: `02-state` (migrateRows); `02b-doc-id` (copyDocHistorySafe, syncDocIdentity); `12-dirty-toast` (showToast); `13-hosted` (onServerDoc); `14-export` (applyStashedWork); `18-local-files` (adoptProjectState, parseProjectFileState); `20f-desktop` (notifyDesktopDocumentState)
- Reaches through bridges: `legacy/location-bridge` (currentConn, currentHome, documentLocation, fileHome, importHome, reviewMode, serverStatus, stillOnServer); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/recovery-bridge` (browserDrafts, captureRestore, desktopDrafts, draftResume, recoveryStarted, stillRestoring, useBrowserDraftFactory); `legacy/transition-bridge` (NO_DESTINATION, documentTransitions); `legacy/save-bridge` (saveChanges, unsavedChanges); `legacy/session-bridge` (currentDocument, mergeBase, noteAbsorbedDirty)
- Imports from adapters (a feature may not): `adapters/storage/02c-blobs` (inlineStateJson, internDataUrl, persist); `adapters/storage/draft-store-idb` (DRAFT_LIMITS, browserDraftKey, draftBaseOf); `adapters/desktop/desktop-handle` (makeDesktopHandle); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `12-dirty-toast` (noteDraftChange); `13-hosted` (armBrowserServerDraft, offerBrowserDraftAfterLinkOff); `20f-desktop` (flushDraftNow)
- Imported by other `src/js` files: `_entry` (draftRecoveryPorts)
- Imported by the wiring: `bootstrap/wiring/startup` (applyTakenDraft, armServerDraftResume, desktopDraftTaker)
- Imported by tests: 8 files

### `20h-appdata`

445 lines.

- Imports from numbered files: `03a-history-store` (exportHistoryAll, importHistoryBundle, normalizeLegacySnapshots); `12-dirty-toast` (showToast); `19-writer` (applyWriterSize, readWriterSize); `20a-update` (readEmbeddedVersion); `20e-connect` (connectPortOr, newBookmarkId, renderConnect, saveBookmarks)
- Reaches through bridges: `legacy/file-delivery` (deliverFile); `legacy/preferences-bridge` (preferences); `legacy/location-bridge` (serverStatus)
- Imports from adapters (a feature may not): `adapters/transport/server-address` (shortHost); `adapters/storage/02c-blobs` (setBackend); `adapters/desktop/desktop-port` (desktopPort)
- Imported by bridges: `legacy/help-actions` (exportAppData, openImportAppData)

### `20j-newtab`

379 lines, in the import loop.

- Imports from numbered files: `00-prelude` (SCHEMA_VERSION, loadLastFileHandle); `02-state` (escapeHtml, makeId, migrateRows); `02b-doc-id` (syncDocIdentity); `11-import` (openGdocModal, openImportModal); `13-hosted` (arrivingOnLink); `18-local-files` (openLocalFile, openProjectFile); `20a-update` (desktopAppOffered, desktopAppUrl)
- Imports from other `src/js` files: `_starters` (STARTERS, starterById)
- Reaches through bridges: `legacy/session-bridge` (currentDocument); `legacy/location-bridge` (currentHome); `legacy/production-editing-bridge` (resetProductionPanelState); `legacy/seed-check` (seedCheckPasses); `legacy/app-actions` (appActions); `legacy/document-ports` (productionReaders); `legacy/transition-bridge` (NO_DESTINATION, documentTransitions); `legacy/effects-bridge` (showToast); `legacy/recovery-bridge` (draftResume); `legacy/save-bridge` (confirmSavedNow); `legacy/startup-bridge` (startupReady); `legacy/preferences-bridge` (preferences)
- Imports from adapters (a feature may not): `adapters/desktop/desktop-handle` (makeDesktopHandle); `adapters/desktop/desktop-port` (desktopPort)
- Imported by numbered files: `13-hosted` (closeNewTabPage); `18-local-files` (closeNewTabPage); `18b-file-menu` (closeNewTabPage); `20-teleprompter` (closeNewTabPage)

### `20s-settings`

393 lines, in the import loop.

- Imports from numbered files: `01b-hide-shot` (setHideShotScenes); `03-sync` (personSwatchesHtml); `10-comments` (getSavedAuthorName); `13b-collaborate` (DEFAULT_COLLAB_SERVER, collabServerView, normalizeCollabServer, readCollabServer, signOutCollab); `19-writer` (applyWriterSize, readWriterSize); `20-teleprompter` (setPrompterFlip, setPrompterMirror, setPrompterSceneMode); `20a-update` (renderDesktopAppNotice)
- Reaches through bridges: `legacy/save-bridge` (setAutoSaveEnabled); `legacy/app-actions` (appActions); `legacy/effects-bridge` (showToast); `legacy/preferences-bridge` (PREF_EVENT, preferences)
- Imports from feature folders (a feature may not import another feature): `features/settings/appearance` (applyTagIcons, applyTheme)
- Imported by numbered files: `13b-collaborate` (openSettings)
- Imported by bridges: `legacy/help-actions` (openSettings)
- Imported by tests: 2 files
