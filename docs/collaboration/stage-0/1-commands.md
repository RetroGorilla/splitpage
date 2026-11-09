# Stage 0: command inventory

Every way a user action changes the document today, one row per command or input path, tagged with the Stage 1 trace it serves ([plan section 12, item 1](../../COLLABORATION-PLAN.md#12-audit-deliverables)).

Audited against `0ca1929177ffc84bced412ad2be3aa99690761d0`.

## Reading this file

- **Reach** says how the edit gets into the document. `cmd X` is an explicit command or flow operation, which the slice can hook by name. `DOM → Y` means the browser mutates the DOM natively and `Y` decodes the whole element back into runs afterwards; the intent is gone by then.
- Every row ends in the same trunk. It is described once, below, and a detail block only names what differs.
- `S2` rows are name and location only.
- Shorthand: `fs` = `src/features/writer/flow-surface.ts`, `fw` = `src/features/writer/flow-writer.ts`, `ww` = `src/bootstrap/wiring/writer.ts`, `ed` = `src/bootstrap/wiring/editor.ts`, `ce` = `src/application/editing/cell-editing.ts`, `rr` = `src/features/rows/render.ts`, `core` = `src/core/flow/flow.ts`.

### The trunk every edit ends in

1. A `Command` reaches `DocumentSession.run` (`src/application/session/document-session.ts`). `needs: "edit"` commands are refused when `capability.edit()` says no; `cellTextCommand` has `needs: "nothing"` and refuses inside its own plan unless only comment anchors moved.
2. `plan(doc)` runs against the live document at that moment. Nothing carries an editor base version: positions come from the DOM or the held selection, captured in the same task.
3. `transact` applies the plan to the plain object, then three writers that are not the user's edit: `attribution.attribute` (edit stamps), `reconcile.records` (tag and shot records minted from text) and, when the change set needs it, `reconcile.anchors` (comment anchor repair). A throw rolls all of it back.
4. `commit("edit")` bumps `generation`, calls `undo.record` (wired in `src/bootstrap/wiring/undo.ts` to `Undo.noteEdit`), runs the effect scheduler (`dirty`, `draft`, `save`, and the debounced `production`/`broll` derive jobs, 180 ms idle, 1 s max) and publishes the change to listeners.
5. Undo is a snapshot diff, not an operation log. `Undo.noteEdit` queues a microtask `flush` (immediately when the command carries a selection pair) that runs `diffStates(base, live)` in `src/application/editing/undo/history.ts` and records whole-field `rowField` steps plus index-based `insertRow`, `deleteRow`, `moveRow` and `docField` steps. Typing groups: same cell, under 1000 ms, no selection pair on either entry, not starting a new word after a space (`record`). 200 entries max. `breakCoalescing` ends a group.
6. Listeners repaint: `paintSessionChange` in `rr`. Edits made inside `paintGuard().whileShown` (every surface sync and flow commit) skip repainting the text fields already on screen.

Undo replay re-enters through `DocumentSession.replay` (kind `replay`: no undo record, but save and derive run). `planSteps` re-checks every step against the live document and refuses with "has changed since" when a whole field or row index no longer matches; text fields go through `resolveCell`, which can rebase.

## 1 Writer: narration and headings (flow surface)

| # | Command or input | Surface | Location (handler → command) | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Typing, native delete, word delete, spellcheck replacement inside one beat (`beforeinput` not prevented, then `input`) | flow | `fs` `onInput` → `syncBeatEl` → `fw` `syncBeat` → `cellTextCommand` (`src/application/commands/cell-text.ts`) | insert text, delete observed content | DOM → `syncBeatEl` (whole beat) | T01, T02, T03, SLICE |
| F2 | IME composition in a beat or heading (`compositionstart`/`compositionend`) | flow | `fs` `onCompositionStart`, `onInput` (collects `compositionTargets`), `onCompositionEnd` → `syncComposition` | insert text, delete observed content | DOM → `syncComposition` → `syncBeatEl` / `renameHeading` | T04, SLICE |
| F3 | Typing at a caret with toggled marks (`pending` set by Ctrl+B with no selection) | flow | `fs` `onBeforeInput` → `apply("type")` → `core` `typeWithMarks` → `flowCommand` (`src/application/commands/flow.ts`) | insert text | cmd `typeWithMarks` | SLICE |
| F4 | Typing where the DOM caret and the target range disagree (gap typing "here") | flow | `fs` `onBeforeInput` → `typeWithMarks` result painted with `beat.innerHTML =`, then `syncBeatEl` | insert text | cmd result, then DOM → `syncBeatEl` | T02, SLICE |
| F5 | Typing at a stage-direction edge | flow | `fs` `onBeforeInput` → `ww` `typeAtBeatEdge` → `rr` `typeAtDirectionEdge` → `ce` `edit` → `cellTextCommand` | insert text | cmd via `ce.edit` (whole cell), then `syncBeatEl` | SLICE |
| F6 | Shortcuts fired by input: `))` direction, `sfx:`/`music:` cue, auto tag | flow | `fs` `onInput` → `ww` `beatInput` → `rr` `maybeDirectionShortcut`, `maybeCueShortcut`, `maybeAutoTagShortcut` (`src/features/tags/production-tags.ts`) → `ce` `edit` | mark/format | cmd via `ce.edit` (whole cell) | T20, SLICE |
| F7 | Inline markdown on `*`/`~` | flow | `fs` `maybeInlineMarkdown` → `apply("inline-markdown")` (writes the whole `audioText`) | mark/format | cmd (row result) | S2 |
| F8 | Enter (`insertParagraph` or keydown) | flow | `fs` `onEnter` / `onBeforeInput` → `core` `enterAt`, `startParagraph`, `enterInHeading`, `finalizeHeading` | boundary change (split, paragraph, header create) | cmd `flowCommand` | T05, T08, SLICE |
| F9 | Shift+Enter (`insertLineBreak`) | flow | `fs` `onEnter` / `onBeforeInput` → `core` `lineBreakAt` | insert text | cmd `lineBreakAt` | S2 |
| F10 | Backspace at offset 0 (beat or heading) | flow | `fs` `onBeforeInput` → `core` `backspaceAt` (tick setting `delete`) | boundary change, delete observed content | cmd `backspaceAt` | T06, T08 |
| F11 | Delete at end of beat | flow | `fs` `onBeforeInput` → `core` `deleteForwardAt` | boundary change, delete observed content | cmd `deleteForwardAt` | T06 |
| F12 | Join: Alt+Backspace, tick menu "Join back/next" | flow | `fs` `onKeydown`, `createFlowBeatMenu` handlers → `core` `joinWithPrevious` | boundary change (join) | cmd `joinWithPrevious` | T06, T07 |
| F13 | Delete a selection that crosses beats or headings, or covers a whole beat, or that Chromium aimed at the next beat | flow | `fs` `onBeforeInput` → `apply("delete-selection")` → `core` `replaceRange` | delete observed content, boundary change | cmd `replaceRange` | T01, T09, T10 |
| F14 | Type over a cross-beat selection | flow | `fs` `onBeforeInput` → `apply("replace-selection")` → `replaceRange(…, removeWholeStart)` | delete observed content, insert text | cmd `replaceRange` | T09 |
| F15 | Typing in a heading | flow | `fs` `onInput` → `apply("rename-scene")` → `core` `renameHeading` (whole name from `textContent`) | insert text, delete observed content | DOM → `renameHeading` (whole name) | T03, T04, T08 |
| F16 | Heading emptied, then Enter, Backspace or caret leaves | flow | `fs` `removeEmptyHeading` (from `onEnter`, `onBeforeInput`, `leaveEmptyHeadings`) → `replaceRange` over the heading | boundary change (header remove) | cmd `replaceRange` | T08 |
| F17 | `# name` line promoted on Enter, caret leaving the line, opening the visual box, or blur | flow | `fs` `onEnter`, `leavePendingHeading`, `prepareVisual` → `core` `finalizeHeading` | boundary change (header create) | cmd `finalizeHeading` | T08 |
| F18 | Bold/italic/underline/strike (keys, `format*` input types, toolbar) | flow | `fs` `format` → `core` `setMarkAcross`, or `pending` at a caret | mark/format | cmd `setMarkAcross` | T21 |
| F19 | Toolbar tag and link in the writer | flow | `src/features/writer/writer.ts` `onWriterFormat` → `rr` `handleToolbarCmd` on the beat span | mark/format | as S10, P8 | T20, T21 |
| F20 | Comment on selection | flow | `fw` `comment` → `src/core/text/edits.ts` `addComment` on the beat's runs → `syncBeat` (`cellTextCommand`), then P1 on Post | mark/format, record change | anchor: whole-beat `cellTextCommand`; record: P1 | T11, T20, T21 |
| F21 | Alt+Up/Down moves the caret's beat | flow | `fs` `onKeydown` (syncs first) → `fw` `moveBeat` → `swapBeatsCommand` (`src/application/commands/rows.ts`) | movement | cmd `swapBeatsCommand` | MOVE |
| F22 | Caret leaves a beat (selection change, focusout, close) | flow | `fs` `transitionBeat` → `ww` `leaveBeat` (sanitize, `cells().sync`, `anchorBrollInLeftCell`) → `syncBeatEl` | none intended; repairs | DOM → `ce.sync`, `syncBeatEl` | T02, SLICE |
| F23 | Writer opens | flow | `ww` `create` → `DocumentSession.amend(initializeFlowParagraphs)` | record change (`paragraphStart`, `paragraphsDecided`) | cmd (amend, no undo entry) | SLICE |

## 2 Writer: visual box

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Typing in the visual box | flow | `src/features/writer/flow-visual-box.ts` `onInput` → `save` → `fw` `save` → `cellTextCommand("visualText")` | insert text, delete observed content | DOM → whole `visualText` from `cell.innerHTML` | T07, SLICE |
| V2 | Composition in the visual box | flow | `flow-visual-box.ts` `onCompositionStart`, `onCompositionEnd` → `save` | insert text | DOM → whole field at end | T04 |
| V3 | Enter, paste in the visual box | flow | `flow-visual-box.ts` `onKeydown`, `onBeforeInput`, `onPaste` → `fw` `paste` (rewrites `cell.innerHTML` from the model) → `save` | insert text | model edit painted into the box, then DOM → whole field | S2 |
| V4 | First save of a visual typed over a narration selection | flow | `fw` `save(first)` → `commit("visual-selection")` → `src/core/flow/visual.ts` `setVisualForRange` → `selectionToOwnBeat` | boundary change (split), record change | cmd `setVisualForRange` | T05 |
| V5 | Box closes | flow | `flow-visual-box.ts` `close` → `ww` `visualLeave` (sanitize, `cells().sync`, `anchorBrollInLeftCell`) | repairs | DOM → `ce.sync` | S2 |

## 3 Split view cells

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Typing, native delete, spellcheck in a narration or visual cell | Split view | `src/features/rows/editor.ts` `onInput` → `ed` `onRootInput` → `ce` `sync` → `cellTextCommand` | insert text, delete observed content | DOM → `ce.sync` (whole cell) | T01, T02, T03, SLICE |
| S2 | IME composition in a cell | Split view | `ed` `onRootInput` (no composing check) → `ce` `sync`; `src/features/editing/composition.ts` only sets undo marks | insert text | DOM → `ce.sync` on every composition update | T04, SLICE |
| S3 | Typing at pending marks or a direction edge | Split view | `src/features/editing/focus.ts` `onBeforeInput` → `ed` `typeAtMarks` → `rr` `typePendingMarks` / `typeAtDirectionEdge` → `ce` `edit` | insert text | cmd via `ce.edit` (whole cell) | SLICE |
| S4 | Input shortcuts (direction, cue, auto tag, b-roll capture, plain tag and who-list openers) | Split view | `ed` `onRootInput` → `rr` `maybeDirectionShortcut`, `maybeCueShortcut`, `maybeAutoTagShortcut`, `maybeCaptureBroll` (`src/bootstrap/wiring/broll.ts`) | mark/format, record change | cmd via `ce.edit` | T20 |
| S5 | Enter | Split view | `ed` `onRootKeydown` → `rr` `insertLineBreak` → `ce` `edit` | insert text | cmd via `ce.edit` | S2 |
| S6 | Alt+Enter splits the field at the caret | Split view | `ed` `onRootKeydown` (syncs) → `src/features/rows/beats.ts` `splitField` → `splitBeatCommand` (`src/application/commands/split-join.ts`) | boundary change (split) | cmd `splitBeatCommand` | T05 |
| S7 | Ctrl+Enter adds a beat below | Split view | `ed` `onRootKeydown` (syncs) → `beats.ts` `addRowAndFocus` → `addBeatCommand` | boundary change (insert beat) | cmd `addBeatCommand` | S2 |
| S8 | Alt+Up/Down | Split view | `ed` `onRootKeydown` (syncs) → `swapAdjacentRows` → `swapBeatsCommand` | movement | cmd `swapBeatsCommand` | MOVE |
| S9 | Bold/italic/underline/strike/highlight, direction (toolbar or keys) | Split view | `rr` `toggleCellFormat`, `toggleCellDirection` → `ce` `edit` | mark/format | cmd via `ce.edit` | T21 |
| S10 | Link confirm | Split view | `rr` `confirmLink` → `ce` `edit` (`setMark href`) | mark/format | cmd via `ce.edit` | T20, T21 |
| S11 | Comment button | Split view | `rr` `handleToolbarCmd` → `wrapRangeInComment` (native DOM wrap) → `ce` `sync` → action `comment-on-selection`, then P1 on Post | mark/format, record change | DOM → `ce.sync`, then P1 | T11, T20, T21 |
| S12 | Focus leaves a cell | Split view | `focus.ts` `editorBlur` → `ed` `blurredCell` (sanitize, `ce.sync`, `anchorBrollInLeftCell`) | repairs | DOM → `ce.sync` | T02, SLICE |

## 4 Clipboard

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Cut inside one cell | Split view | `src/features/clipboard/routes.ts` `copyOrCut` → `cell-clipboard.ts` `copyFromCell` → `cutShown` → `cutCommand` (`src/application/commands/clipboard.ts`) | delete observed content | cmd `cutCommand` (range from `ce.open`) | T01, MOVE |
| C2 | Paste text or rich text into a cell | Split view | `routes.ts` `paste` → `insert` → `ed` `insertIntoScriptCellNow` → `cell-clipboard.ts` `pasteShown` → `pasteCommand` | insert text | cmd `pasteCommand` | MOVE |
| C3 | Paste or drop files and pictures into a cell | Split view | `routes.ts` `insert` (async `readMedia`, then `stillOwns`) → `pasteCommand` with `attach` | record change (gallery) | cmd `pasteCommand` | T16 |
| C4 | Drop text into a cell | Split view | `rows/editor.ts` `onDrop` → `ports.insert` → as C2 | insert text | cmd `pasteCommand` | S2 |
| C5 | Paste copied beats while a cell is focused | Split view | `routes.ts` `paste` → `beat-select.ts` `pasteBeatsAt` (syncs) → `pasteClip` → `pasteBeatsCommand` (`src/application/commands/beats.ts`) | boundary change (insert beats) | cmd `pasteBeatsCommand` | MOVE |
| C6 | Beat selection: cut, delete (keys or menu) | Split view | `beat-select.ts` `runClipboardCommand` / `deleteSelectedBeats` → `takeOut` → `removeBeatsCommand` | delete observed content (beats) | cmd `removeBeatsCommand` | T10, MOVE |
| C7 | Beat selection: paste | Split view | `beat-select.ts` `onPasteEvent` → `pasteClip` → `beat-clip.ts` `beatPaste` → `pasteBeatsCommand` | boundary change (insert beats) | cmd `pasteBeatsCommand` | MOVE |
| C8 | Beat selection: new script from these beats | Split view | `beat-select.ts` `newScriptFromSelection` → `startNewScript` then `pasteClip` | whole-document replacement, then insert | cmd `pasteBeatsCommand` after replacement | SLICE |
| C9 | Writer cut | flow | `fs` `onCut` → `ww` clipboard `copy` (`flow-clip.ts` `copyFlowClipboard`, sets live-cut nonce) → `apply("cut")` → `replaceRange` | delete observed content | cmd `replaceRange` | T09, MOVE |
| C10 | Writer paste | flow | `fs` `onPaste` (queued while composing) → `pasteData` → `apply("paste")` → `flow-clip.ts` `pasteFlowClipboard` (`pasteFlowRange`) or `core` `pasteText` | insert text, boundary change | cmd `pasteFlowRange` / `pasteText` | T09, MOVE |
| C11 | Copy (any surface) | both | `copyFromCell`, `copyFlowClipboard`, `buildBeatPayload` | none | no change | S2 |

## 5 Structure in Split view

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Drag a beat by its grip | Split view | `src/features/rows/routes.ts` `drop` → `ce` `moveRow` → `moveBeatCommand` | movement | cmd `moveBeatCommand` | MOVE |
| R2 | Row menu move up/down | Split view | `routes.ts` `menuClick` → `ed` `moveBy` (scene-boundary confirm) → `swapBeatsCommand` | movement | cmd `swapBeatsCommand` | MOVE |
| R3 | Add beat (add bar, insert below) | Split view | `routes.ts` `addClick`/`menuClick` → `beats.ts` `addRow` → `addBeatCommand` | boundary change (insert beat) | cmd `addBeatCommand` | S2 |
| R4 | Delete beat (armed delete button) | Split view | `routes.ts` `menuClick` → `armDelete` → `beats.ts` `deleteRow` → `deleteBeatCommand` | delete observed content (beat) | cmd `deleteBeatCommand` | T10 |
| R5 | Add scene header, name the automatic scene | Split view | `src/features/rows/scene-controls.ts` click handler → `addSceneCommand` (`src/application/commands/scenes.ts`) | boundary change (header create) | cmd `addSceneCommand` | T08 |
| R6 | Rename scene | Split view | `scene-controls.ts` `rename` (`nameAt` input, submit or blur) → `renameSceneCommand` | record change (whole name) | cmd `renameSceneCommand` | S2 |
| R7 | Remove scene header | Split view | `scene-controls.ts` action `remove`; `src/bootstrap/wiring/scene-headers.ts` → `removeSceneCommand` | boundary change (header remove) | cmd `removeSceneCommand` | T08 |
| R8 | Move scene (menu up/down, drag), drop a beat on a header | Split view | `scene-controls.ts` → `moveSceneCommand`, `moveBeatCommand(…, intoScene)` | movement | cmd | MOVE |
| R9 | Beat status cycle, hide shot | Split view | P25, P27 | record change | cmd | S2 |

## 6 Panels, records and pictures

Shorthand: `cm` = `src/features/comments/comments.ts`, `tp` = `src/features/tags/panels.ts`, `pt` = `src/features/tags/production-tags.ts`, `pr` = `src/application/commands/production-records.ts`, `bp` = `src/features/broll/panel.ts`. "Rewrite" means `applyRewrites` in `src/application/commands/document-edit.ts`: the command recomputes each touched cell's HTML and assigns it whole; the change set names the cells, not the text.

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Post a comment | panel | `cm` `postComment` → `addCommentCommand` (`src/application/commands/comments.ts`) | record change | cmd; body read whole from the composer once | T11 |
| P2 | Cancel or close the composer | panel | `cm` `closeCommentComposer(true)` → `unwrapCommentAnchorCommand` | mark/format (anchor removed) | cmd, rewrite | T11, T21 |
| P3 | Reply | panel | `cm` `postReply` → `addReplyCommand` | record change | cmd | T11 |
| P4 | Resolve, reopen | panel | `cm` `toggleResolve` → `toggleResolveCommand` | record change | cmd | T11 |
| P5 | Comment assignee | panel | `cm` `setCommentAssignee` → `setCommentAssigneeCommand` | record change | S2 | S2 |
| P6 | Delete a comment | panel | `cm` `deleteComment` → `deleteCommentCommand` (unwraps the anchor) | record change, mark/format | cmd, rewrite | T11, T21 |
| P7 | Restore a conflict card's value | panel | `cm` `restoreConflictValue` → `restoreConflictCommand` | whole-field replacement of one cell | S2 | S2 |
| P8 | Tag a selection (composer: one occurrence, or all) | Split view | `pt` `applyTag` → `ce.sync`, then `pr` `tagCellsCommand("tag-occurrence" / "tag-all-occurrences")` | mark/format, record change | cmd, rewrite + `addRegistryTag` | T20, T21 |
| P9 | Tag at caret, category pick, `keyword:` plain tag, ghost and suggestion accept | Split view | `src/features/tags/plain-tags.ts` `chooseCategory`, `closePlainTag`; `pt` `acceptTagGhost`, `acceptUntaggedMention` → `tagTextRange` → `ce.edit` → `cellTextCommand` with `records.tags` | mark/format | cmd via `ce.edit` (whole cell) | T20, T21 |
| P10 | Edit a finished tag's text | Split view | `src/features/tags/occurrence-editor.ts` `activate`; typing goes through S1; `finish` → `closePlainTag` | insert text inside a tag | DOM → `ce.sync` | T20 |
| P11 | `@` who-list pick | Split view | `src/features/tags/who-list.ts` `pick` → `ce.edit` → `cellTextCommand`; the person record is minted by the records reconciler | insert text | S2 | S2 |
| P12 | Tag status, owner, notes; bulk owner, status, person | panel | `tp` `setTagStatus`, `setTagOwner`, `setTagNotes` (whole notes on every `input` event), `addPersonForTag`, `bulkSetOwner`, `bulkSetStatus` → `pr` `updateTagsCommand` | record change | S2 | S2 |
| P13 | Rename or merge a tag | panel | `tp` `saveTagRename` → `src/application/commands/production-actions.ts` `renameTag` → `pr` `retagCommand` + `src/application/commands/tag-rewrites.ts` `retagRewrites` | record change, mark/format (every mention) | cmd, rewrite + `renameRegistryTag` | T20, T21 |
| P14 | Remove a tag from the script | panel | `tp` `armRemoveTag` → `removeTag` → `retagCommand(null)` | mark/format (unlabel) | cmd, rewrite | T20, T21 |
| P15 | Delete tags (one, bulk) | panel | `tp` `armDeleteTag`, `bulkDeleteSelected` → `pr` `deleteTagsCommand` | record change, mark/format | cmd, rewrite + `removeRegistryTag` | T21 |
| P16 | Tag all mentions | panel | `tp` `tagAllMentions` → `tagCellsCommand("tag-all-mentions")` | mark/format | cmd, rewrite | T20 |
| P17 | Add, delete a person; gear quick add (whole textarea, missing names removed) | panel | `pr` `addPersonCommand`, `deletePersonCommand`, `gearQuickAddCommand` via `tp` | record change | S2 | S2 |
| P18 | Prep "filmed" checkbox | panel | `tp` `changeProductionOutline` → `setBeatFilmedCommand` | record change | S2 | S2 |
| P19 | B-roll panel: add, status, reshoot, owner, notes and location (whole value on focusout), bulk, props, delete | panel | `bp` → `addShotCommand`, `setShotsCommand`, `addShotPropCommand`, `removeShotPropCommand`, `deleteShotCommand` (`src/application/commands/broll-records.ts`) | record change | S2 | S2 |
| P20 | Rename a b-roll shot | panel | `bp` `renameShot` → `src/features/broll/records.ts` `renameBrollInScript` → `rewriteCellsCommand("rename-broll-shot")` | insert text (marker line) | S2 | S2 |
| P21 | Add, replace, remove a picture; remove a link | Split view | `src/features/rows/beat-media.ts` `addPicture`, `removePicture`, `removeLink` → `ce` `editGallery` → `galleryCommand` (`src/application/commands/gallery.ts`) | record change | cmd; add runs after async compression | T16 |
| P22 | Attach a non-image file | Split view | `ed` `attachFile` → `pasteCommand` with `attach` | record change | cmd | T16 |
| P23 | Gallery overlay: cover, reorder, remove, unannotate; annotate | overlay | `src/features/gallery/overlay.ts` `makeCover`, `moveTo`, `removeSelected`, `removeAnnotations`; `src/features/gallery/annotate.ts` `done` → `galleryCommand` | movement, record change | S2 | S2 |
| P24 | Automatic thumbnails, bundle relink | overlay | `overlay.ts` `retryThumbnail`, `src/features/gallery/video.ts` `thumbnailsOnBeatClick`, `src/features/gallery/video-bundles.ts` `relink` → `galleryCommand` or `Undo.foldIntoEdit` (amend) | record change (automatic) | S2 | S2 |
| P25 | Beat status cycle | Split view | `src/features/rows/beat-status.ts` `cycleRowStatus` → `beatStatusCommand` | record change | S2 | S2 |
| P26 | Read time | Split view | `src/features/rows/read-time.ts` `closeReadTimeEditor` → `beatLengthCommand` | record change | S2 | S2 |
| P27 | Hide shot | topbar | `src/features/rows/hide-shot.ts` `toggle`: view flag and preference, no document write | none | S2 | S2 |
| P28 | Title (Split view and writer) | topbar | `src/features/title/routes.ts` `take` → `titleCommand` on every `input` event | record change (whole string) | DOM value → whole field | S2 |
| P29 | Target length, words per minute | popover | `src/features/title/target-section.ts` `setTargetLength`, `src/features/rundown/target.ts` → `targetLengthCommand`; `src/features/title/document-chrome.ts` → `wordsPerMinuteCommand` | record change | S2 | S2 |
| P30 | Name and colour in settings | settings | `src/features/settings/settings.ts` `applyChange`: preferences only; reaches the document as `personColors` through `myColorPlan` (`src/application/save/session-effects.ts`) in every transaction | record change (automatic) | S2 | S2 |

## 7 Find, replace and bulk

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Replace one | Split view | `src/features/find/find.ts` `replaceCurrent` → `rewriteCellsCommand("replace-match")` | delete observed content, insert text | cmd, rewrite (`replaceInHtml`); no `breakCoalescing` | T03 |
| B2 | Replace all | Split view | `find.ts` `replaceAll` → `rewriteCellsCommand("replace-all")` | same, many cells | cmd, rewrite, one undo entry | T03 |
| B3 | Replace one or all in the writer | flow | `find.ts` `replaceWriterMatches` → `fw` `replace` → `flowCommand("writer-find-replace", replaceFlowMatches)` (`src/features/writer/flow-find.ts`) | same | cmd, whole `rows` array | T03 |
| B4 | Bulk tag | find bar | `find.ts` `runBulkTag` → `tagCellsCommand("bulk-tag")` over `rewrittenCopies` + `src/application/commands/bulk-tags.ts` `createBulkTagRows` | mark/format | cmd, rewrite | T20 |
| B5 | Import rows, append | dialog | `src/features/imports/imports.ts` `confirmImport` → `importRowsCommand` (`src/application/commands/import-rows.ts`) | boundary change (rows inserted) | S2 | S2 |

## 8 Undo and redo

| # | Command or input | Surface | Location | Intent | Reach | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, `historyUndo`/`historyRedo` in a script cell | Split view | `src/features/undo/routes.ts` `key`, `onBeforeInput` → `step` → `Undo.undo`/`redo` (`src/application/editing/undo/undo.ts` `run`) → `DocumentSession.replay` | replays recorded steps | snapshot steps through `planSteps`/`writePlanned` | T10, T12 |
| U2 | Same keys in the writer | flow | `fs` `onKeydown`/`onBeforeInput` → `fw` `undo.step` → `writer.ts` `writerUndoStep` (may close or reopen the writer) → as U1 → `fw` `afterReplay` | replays recorded steps | as U1 | T10, T12 |
| U3 | Ctrl+Z inside the visual box | flow | `flow-visual-box.ts` `onKeydown` closes the box (saving it), then as U2 | replays | as U1 | S2 |
| U4 | "Undo" on a toast (beats cut, pasted, picture added) | both | `beat-select.ts` `offerUndo`; `ed` `announceAttached` → `undoIfLatest` | replays only if still latest | as U1 | S2 |
| U5 | Comment and reply drafts | panel | `src/features/editing/draft-edit.ts` `draftUndo`/`draftRedo` (own stack, not the document) | none | none | S2 |

## 9 Whole-document replacement

`adopt` = `src/bootstrap/wiring/session-owner.ts` `adoptReplacement`: a new `DocumentSession`, the old one disposed, `adopt` (undo cleared through `Undo.adopt`), epoch bumped, then `onDocumentReplaced`. Absorbed kinds (`adopt`, `disk`, `recovery`, `reload`) repaint through `rr` `paintSessionChange` → `render()`, focused cell included; the writer repaints through `paintWriterDraw` → `flowWriter.repaint()`.

| # | Entry | Location | Ends in | Undo | Serves |
| --- | --- | --- | --- | --- | --- |
| W1 | Open a `.splitpage` (action `open`, new tab open or drop, recents, desktop `onOpenFile`, resume, prompter) | `src/application/transitions/local-files.ts` `openLocalFile` → `openProjectFile` → `adoptProjectState` → `transitions.open` | adopt; not dirty | cleared; history snapshot "Before opening" | SLICE, T13 |
| W2 | Open `.docx`, `.md`, `.txt`, `.csv` as a new script | `local-files.ts` `loadFileIntoEditor` → `transitions.open({ raw })`, then `settle("adopt")` | adopt; dirty, autosave | cleared | SLICE |
| W3 | Reload project from disk (conflict modal) | `src/features/file-menu/mount.ts` `mountConflicts` → `local-files.ts` `reloadProjectFromDisk` | adopt | cleared | SLICE |
| W4 | Reload an imported file | `local-files.ts` `reloadFileFromDisk` → `loadFileIntoEditor({ reload })` → `noteReload` → `DocumentSession.absorbReload` (same object), `settle("reload")` | reload | overlapping entries forgotten (`Undo.absorbRemote`) | SLICE, T12 |
| W5 | New script, long demo, new tab blank or starter | `src/features/file-menu/file-menu.ts` `startNewScript`, `openLongDemo`; `src/features/newtab/newtab.ts` `startBlankScript`, `startStarterScript` → `transitions.startNew` | adopt | cleared | SLICE |
| W6 | Paste as a new script | `newtab.ts` `openPasteAsNewDocument` → `imports.ts` `confirmImport` → `adoptNewDocument`, then `noteSessionEdit` | adopt, then an edit | cleared | S2 |
| W7 | New script from selected beats | C8 | adopt, then `pasteBeatsCommand` | cleared, then one entry | SLICE |
| W8 | File-conflict merge | `src/features/merge/local-merge.ts` `confirmFileMerge` → `src/application/recovery/stashed-work.ts` `applyStashedWork` → `src/bootstrap/wiring/document-merge.ts` `applyMerge` → `src/application/session/apply-merge.ts` `applyIncomingMerge` → `noteMerged` | `absorbMerged("disk")`; autosave halted | partial (`Undo.noteRemote` → `history.forget`); snapshot for the banner's Undo | SLICE, T12 |
| W9 | Startup document and conflict stash | `src/bootstrap/startup/initial-document.ts` `adopt` → `src/bootstrap/wiring/startup.ts` `applyStash` | `absorbMerged("recovery")`, `absorbRecovery`, or adopt | partial or cleared | SLICE, T17 |
| W10 | History restore; merge banner Undo | `src/features/history/panel.ts` `restoreSnapshotFromCard`, `src/features/merge/banner.ts` `undoMerge` → `src/application/session/session-merge.ts` `restoreSnapshot` → `src/bootstrap/startup/document-entry.ts` `adoptRestoredState` → `transitions.restore` | adopt (keeps docId), `settle("recovery")` | cleared; snapshot "Before restoring" first | SLICE, T12 |
| W11 | Desktop draft recovery | `src/bootstrap/wiring/drafts.ts` `applyTakenDraft` → `src/application/recovery/drafts.ts` `runDraftRestore`: one adopt, a second adopt, or a merge | adopt or `absorbMerged("recovery")` | cleared or partial | SLICE, T17 |
| W12 | Desktop tab restore at launch | `desktop/session-restore.ts` `restoreSessionAtLaunch` → W11 or W1 | as those | as those | T24 |
| W13 | Import rows with "replace" checked | `imports.ts` `confirmImport` → `importRowsCommand`: every row removed, scenes cleared, title kept | edit | one entry; snapshot first | SLICE |
| W14 | Document id reassignment (desktop IPC, other tab) | `src/application/identity/document-identity.ts` `reassignDocId` → `documentIdStamp` via `DocumentSession.stamp` | stamp; no undo, no dirty | none | SLICE |

## 10 Command builders sorted by what they change

This sizes Stage 2. Every builder writes the plain object through `Plan.apply` and declares a change set of cells, rows and doc fields; none declares the text operation.

### Builders in `src/application/commands/`: 49

| Group | Count | Builders |
| --- | --- | --- |
| Fields and records: translatable from the declared fields | 26 | `beatStatusCommand`, `setBeatFilmedCommand`, `beatLengthCommand`, `addCommentCommand`, `addReplyCommand`, `setCommentAssigneeCommand`, `toggleResolveCommand`, `galleryCommand`, `registerTagCommand`, `addPersonCommand`, `deletePersonCommand`, `updateTagsCommand`, `gearQuickAddCommand`, `addShotCommand`, `setShotsCommand`, `deleteShotCommand`, `addShotPropCommand`, `removeShotPropCommand`, `targetLengthCommand`, `wordsPerMinuteCommand`, `editStamp`, `documentIdStamp`, `initializeFlowParagraphs`, and three whole-string fields: `titleCommand`, `fileTitleCommand`, `renameSceneCommand` |
| Text and marks: need explicit intent | 10 | `cellTextCommand`, `pasteCommand`, `cutCommand`, `rewriteCellsCommand`, `tagCellsCommand`, `retagCommand`, `deleteTagsCommand`, `deleteCommentCommand`, `unwrapCommentAnchorCommand`, `restoreConflictCommand` |
| Structure (rows, order, sections): need explicit intent | 13 | `addBeatCommand`, `deleteBeatCommand`, `moveBeatCommand`, `swapBeatsCommand`, `splitBeatCommand`, `joinBeatsCommand` (no app caller), `pasteBeatsCommand`, `removeBeatsCommand`, `addSceneCommand`, `removeSceneCommand`, `moveSceneCommand`, `importRowsCommand`, `flowCommand` |

Notes on the groups:

- The three whole-string fields are translatable only as last writer wins. `titleCommand` runs on every keystroke, so two people typing in the title would replace each other's whole title.
- Every text-group builder ends in a whole-field assignment: `cellTextCommand` from runs, the rest through `applyRewrites` or their own `apply`. The intent, where one existed, sits in the caller: a range in `ce.edit`, a planner in `rewrittenCopies`, a `TextRange` in `cutCommand`.
- In the structure group, `moveBeatCommand`, `swapBeatsCommand` and `moveSceneCommand` know the moved ids and the target, but apply by `live.rows.splice(0, n, ...reordered)` and declare `rowsMoved: true` with no ids. `flowCommand` declares the cells it found by `JSON.stringify` diff and then replaces the whole `rows` array with deep copies.

### Flow operations and `FlowEdit`

The plan proposes an ordered list of operations on `FlowEdit` beside `rows`. "Known" means the operation receives the intent as arguments and could emit operations where it builds `rows`. "Lost" means its input is already a resulting value.

| Operation (`core` unless named) | App caller | Intent when `FlowEdit` is built |
| --- | --- | --- |
| `typeWithMarks` | F3, F4 | known: position, text, marks |
| `replaceRange` | F13, F14, F16, C9 | known: range and inserted runs. Whole beats in the range are dropped with their comments (`removedComments`); with `removeWholeStart` the first beat is replaced by `replacementRow`, a fresh id |
| `setMarkAcross` | F18 | known: range and mark |
| `enterAt` | F8 | known: range; may clear a selection first, then split or start a paragraph |
| `startParagraph` | F8 | known: position |
| `lineBreakAt` | F9 | known |
| `backspaceAt` (and internal `removeHeader`) | F10 | known: position and tick setting. `removeHeader` copies the scene name into a new beat with a fresh id |
| `deleteForwardAt` | F11 | known |
| `joinWithPrevious` | F12 | known: row id. The joined visual is stored as `first + "<br>" + second` |
| `renameHeading` | F15, F2 | lost: receives the heading's whole `textContent` after native input |
| `enterInHeading` | F8 | known: position; the tail of the name becomes a new beat |
| `finalizeHeading` | F17 | known: row and offset; the line's text is copied from the beat into `sections[].name` |
| inline markdown (`inlineMarkdown`, FlowEdit built in `fs` `maybeInlineMarkdown`) | F7 | known in `inlineMarkdown`, but the surface builds `rows` by writing the whole `audioText`; operations would have to come from the surface |
| remove empty heading (`fs` `removeEmptyHeading` around `replaceRange`) | F16 | known |
| `pasteText` (uses `insertBeats`) | C10 | known: range and paragraphs |
| `pasteFlowRange` (uses `insertBeats`), and `src/features/clipboard/flow-clip.ts` `pasteFlowClipboard` | C10 | known: range and clip; a move keeps ids (`isMove`) |
| `replaceFlowMatches` (`flow-find.ts`), `replaceMatch` | B3 | known: ranges and text |
| `setVisualForRange` (`src/core/flow/visual.ts`, uses `selectionToOwnBeat`) | V4 | known: range; the visual HTML is the box's whole `innerHTML` |
| `sentenceParagraphs` (via `initializeFlowParagraphs`) | F23 | known: paragraph flags only |
| `selectionToOwnBeat` (via `fs` `apply("own-beat")`) | none outside V4 | known |
| `insertBeats` | inside `pasteText`, `pasteFlowRange` | known |
| `startBeat`, `moveBeats`, `replaceAll` | none in the app | known; unused |

Counts: 24 operations. 22 know their intent when `FlowEdit` is built (3 of them unused, and `selectionToOwnBeat` reached only through V4), 1 is partly surface-built (inline markdown), 1 has lost it (`renameHeading`). The bigger loss is outside `FlowEdit`: every native-input path (F1, F2, F4's sync, F22, V1, V2, S1, S2) reaches the document as `cellTextCommand` with the whole field, with no `FlowEdit` at all.

## Detail blocks

Grouped by mechanism. Each names the rows it covers; the trunk above is not repeated.

### D1 Native typing in the writer (F1, F4, F22)

- **Base held:** the surface's `rendered` WeakMap holds each beat's last painted or synced HTML. `syncBeatEl` does not read it before writing; it overwrites it after. The held selection is flow offsets plus epoch (`rememberFlow`), no character keys.
- **Path:** `input` → `fs` `onInput` → `repairOrphans` → `syncBeatEl(el, true)` → `ports.storedHtml(innerHTML minus ZWSP)` → `ports.decode` → `fw` `syncBeat` → `ports.shown(run(cellTextCommand(rowId, "audioText", runs)))` → trunk. Then `rendered.set`, `decorate` (adds or removes ZWSP caret spots inside the focused beat).
- `syncBeatEl` returns at once while `editingBlocked()` (`paintGuard().painting()`, `undoGuard().applying()`, `screenIsStale()`). Text typed then stays in the DOM only, until the next sync of that beat.
- **Effects:** `production` and `broll` derive (debounced), dirty, draft, autosave; `ww` `changed` schedules writer stats.
- **Undo grouping:** a typing group per beat: under 1000 ms, no selection pair, a new word after a space breaks it.

### D2 Native typing in Split view (S1, S12)

- **Base held:** none. A selection snapshot with per-character keys (`takeSnapshot`) is kept for restoring the caret only.
- **Path:** `src/features/rows/editor.ts` `input` → `ed` `onRootInput` → input shortcuts → `ce` `sync` → `cellTextCommand` from `page.html(cell)` (whole cell) → trunk → `settleEndedComposition` → `afterScriptCellChange`. Focusout: `ed` `blurredCell` sanitizes, syncs, then `anchorBrollInLeftCell` may rewrite `visualText` again.
- **Undo grouping:** as D1.

### D3 Composition (F2, S2, V2)

- **Writer:** `compositionstart` sets `composing`. `input` during composition only adds the element to `compositionTargets`. `paint`, `repaint` and `refreshBeat` set `repaintOwed` and return; pastes queue in `queuedPastes`.
- `compositionend` → `onCompositionEnd`: `composing = false` → `syncComposition` (`repairOrphans`, `syncBeatEl` per target beat, `renameHeading` per target heading) → `ports.changed` → `repaint()` if owed → queued pastes.
- The sync runs before the owed repaint. An outside change to the composed beat that arrived meanwhile is in the model, the composed DOM never showed it, and the whole-beat sync writes over it.
- **Split view:** `onRootInput` has no composing check; every composition `input` syncs the whole cell. `src/features/editing/composition.ts` only sets undo marks (`Undo.compositionMark`).
- **Visual box:** `onInput` skips `save` while composing; `onCompositionEnd` saves the whole field.
- **Close:** `closeWriter` → `fs` `finish` forces `composing = false` and syncs.

### D4 Explicit flow operations (F3, F8 to F14, F16, F17, C9, C10)

- **Base held:** `ports.doc()` at that moment and the DOM selection or held range, read in the same task as the operation.
- **Path:** `fs` `apply(name, op, before)` → `ports.commit` → `fw` `commit` → `runPlanned(flowCommand(name, op, ports, before))` (calls `breakCoalescing` when the plan is non-null) → `ports.shown(run(...))` → trunk. `flowCommand.plan` runs `op(doc)` against the live document; `apply` replaces every row with a deep copy, writes sections, filters `removedComments`. Back in `fs`: `paint()`, `place(selection)`, `ports.changed`.
- **Undo grouping:** the selection pair makes `noteEdit` flush at once: one entry per operation.

### D5 Heading and boundary copies (F8, F10, F15 to F17, R5, R7)

- Text moves between `rows[].audioText` and `sections[].name` by copy:
  - `finalizeHeading` copies the `# name` line into the scene name, then truncates or removes the beat.
  - `removeHeader` (from `backspaceAt` at a heading start) makes a new beat with a fresh id holding the name.
  - `enterInHeading` splits the name's tail into a new beat.
- A concurrent edit to the source text after the copy does not follow it (T08). Split view's R5 and R7 only add or drop the scene record and set `paragraphStart`; no text moves.
- **Undo:** one entry: a `sections` doc-field step plus row steps.

### D6 Cross-beat delete and replace (F13, F14, C9)

- `replaceRange` takes two endpoints. Whole beats inside are removed with their comments; the endpoint beats stay separate beats with the paragraph flag cleared; with `removeWholeStart` a fully covered first beat becomes `replacementRow` with a fresh id.
- The deletion is defined by positions, not by the identities of the observed characters, so an insertion that lands inside the range before commit would be deleted with it (T01, T09).
- **Undo:** one entry. `deleteRow` steps refuse when the beat at that index differs (`rowsEqualIgnoringStamps`).

### D7 Visual box (V1, V4)

- **Base held:** none; the box's `innerHTML`.
- First save of a box opened over a narration selection: `fw` `save` → `commit("visual-selection", setVisualForRange)`, which splits the selection into its own beat and sets `visualText` (T05). Later saves: `cellTextCommand("visualText")` with the whole box.
- `flow-visual-box.ts` `refresh` repaints the open box from the model when it is not composing, dirty or saving, keeping the selection.

### D8 Moves and structural cut and paste (F21, S8, R1, R2, R8, C5 to C10)

- **Base held:** ids. `swapBeatsCommand` → `moveBeatCommand` → `reorderTo(order)`: the same row objects in a new order, applied as a whole-array splice; the change set says `rowsMoved: true` without ids.
- Beat cut is `removeBeatsCommand`; paste is a later `pasteBeatsCommand`. `beat-clip.ts` `isMove` (live-cut nonce matches, same docId, beats absent) reuses the original ids and comments. The writer's structural paste goes through `flow-clip.ts` `pasteFlowClipboard` with the same `isMove`.
- Between cut and paste the beats do not exist in the document (T10).
- **Undo:** two entries, one per command. `moveRow` steps are index-based; `planSteps` only checks that both indexes exist, not which beat is at `from` (T12).

### D9 Tags, comments and links (F6, F18 to F20, S4, S9 to S11, P2, P6, P8 to P16, B4)

- **Model:** marks on runs (`tag`, `cmt`, `href`, `b`...), stored as HTML. A comment record holds `rowId` and `field`; its anchor is the `cmt` mark in the text.
- **Nesting (INV-03):** `normalizeCell` (`src/core/text/runs.ts`) widens a comment or link that covers part of a tag to the whole tag. It runs on every decode, so today nesting is a normalization of the result, not a check on an operation.
- **Three apply shapes:**
  1. A run transform in the caller, then a whole-cell `cellTextCommand` (P9, S9, S10, F6, and the writer comment through `addComment` + `syncBeat`).
  2. A planner that rescans the live document at plan time and rewrites each cell whole, plus the registry: `tagCellsCommand`, `retagCommand`, `deleteTagsCommand` (P8, P13 to P16, B4).
  3. A native DOM wrap, then a sync (S11 `wrapRangeInComment` → `ce.sync`).
- **Base held:** the caller's range (`ce.open` reads the DOM selection) for shapes 1 and 3; none for shape 2.
- **Effects:** the records reconciler mints tag and person records at commit; `syncCommentAnchors` (`src/core/text/anchors.ts`) moves a comment's `rowId`/`field` to wherever its anchor id now is; `production` derive.
- **Undo grouping:** tag panel and bulk operations break coalescing before and after: one entry each. A comment is two commands, the anchor (`cellTextCommand`) and the record (`addCommentCommand` on Post), so two entries; Cancel removes the anchor with a third.
- **Replay after other edits (T21):** text fields go through `resolveCell`, a three-way `mergeCells(before, live, after)` refused on a text or mark conflict ("that beat's text has changed since"). `comments` and `productionTags` doc-field steps refuse when changed, unless `listMergeFor` covers the key.

### D10 Undo and redo (U1, U2)

- **Path:** `src/features/undo/routes.ts` `step` (Split view) or `writer.ts` `writerUndoStep` → `Undo` `run` → `planSteps` → `DocumentSession.replay` → `writePlanned`. `undoGuard.applying` blocks surface syncs meanwhile. The writer runs `beforeReplay`, then `afterReplay` → `fs` `repaint()` + `restoreAfterReplay`.
- **Effects:** save and derive; no new undo record.
- Refusal reasons are whole-field or index checks (D8, D9). Disk and merge absorb (`noteRemote`) forget the overlapping entries; adopt clears all.

### D11 Pictures and files (C3, P21, P22)

- **Base held:** the cell element and a `capture()` owner token. `routes.ts` `insert` awaits `readMedia`, then checks `stillOwns(owner)`, else reports "not added". Otherwise it re-finds the cell by row and field, restores the place and runs `pasteCommand` with `attach`.
- Gallery fields are written as whole arrays (`attachToGallery`, `galleryCommand`). An image added offline is a whole-array write against whatever the array is at commit (T16).

### D12 Slice hooks and automatic writers (F23, W1 to W14)

- `ww` `__writerFlowTest` exposes `outsideEdit`, `outsideVisual` (`cellTextCommand` on a beat) and `outsideRemove` (`deleteBeatCommand`). They run outside `whileShown`, so the writer repaints them like a remote edit: a usable injector for T02 and T07 before a provider exists.
- Opening the writer runs `initializeFlowParagraphs` through `DocumentSession.amend`: a write with no undo entry, once per document (`paragraphsDecided`).
- Every W row replaces or absorbs the whole session. The slice must route or disable each (plan deliverable 4).

## Reconcile paths: DOM content back into runs

Every path decodes the whole element and writes the whole field. None compares with a base first. There is no timer-driven sync and no sync on app close: a composition still open when the window closes never reaches the document.

| Reconcile function | Surface | Trigger | Writes |
| --- | --- | --- | --- |
| `fs` `syncBeatEl` from `onInput` | flow | input, not composing | `audioText` via `cellTextCommand` |
| `fs` `syncBeatEl` from `syncComposition` | flow | composition end; also the start of every `paint()`; `finish()` | same, each target beat |
| `fs` `syncBeatEl` before an explicit op | flow | `onEnter`, Alt+Up/Down, `ww` `beatKeydown` (handled keys), `typeAtBeatEdge`, gap typing (F4) | same |
| `fs` `syncBeatEl` from `transitionBeat` | flow | `selectionchange` into another beat, focusout (`onHostBlur`), `finish()` | same, the beat left |
| `fs` `repairOrphans` | flow | input, composition end: text the browser put outside a beat is moved back into one, then that beat syncs | same |
| `ww` `leaveBeat` → `cells().sync` | flow | caret leaves a beat (after sanitize; then `anchorBrollInLeftCell`) | same |
| `fs` `onInput` → `renameHeading` | flow | input in a heading, not composing; composition end for headings | `sections[].name`, whole `textContent` |
| `flow-visual-box.ts` `save` | flow | input (not composing), composition end, paste, Enter, close | `visualText`, whole box |
| `ww` `visualLeave` → `cells().sync` | flow | visual box closes | `visualText` |
| `fs` `finish` | flow | `closeWriter` | forces `composing = false`, then `syncComposition` and `transitionBeat(null)` |
| `ed` `onRootInput` → `ce.sync` | Split view | every input, composition updates included | the cell's field |
| `ed` `blurredCell` → `ce.sync` | Split view | focusout (after sanitize; then `anchorBrollInLeftCell`) | the cell's field |
| `ce` `open` → sync | Split view | before every `ce.edit`, cut and paste | the cell's field |
| `ed` keydown syncs | Split view | before Alt+Enter, Alt+Up/Down, Ctrl+Enter; `beat-select.ts` `pasteBeatsAt` | the cell's field |
| `rr` `handleToolbarCmd` comment | Split view | after `wrapRangeInComment` | the cell's field |
| `src/features/tags/occurrence-editor.ts` | Split view | typing inside a tag reaches `onRootInput` | the cell's field |
| `src/features/title/routes.ts` `take` | both | every title `input` | `title`, whole string |

## Paints into editable elements

| Painter | Element | While focused | While composing |
| --- | --- | --- | --- |
| `fs` `paint()` | each beat whose model HTML differs from `rendered`; each heading whose `textContent` differs | yes. `paint` itself does not restore the caret; `apply` places the command's selection after it | deferred: sets `repaintOwed` and returns (also while `syncingComposition`) |
| `fs` `repaint()` | same, through `paint()` | yes, and restores the caret: `remapForRepaint` maps the selection by character keys (`takeSnapshot` over the DOM, `resolveSelection` against the model), re-places it, re-remembers it | deferred, as `paint` |
| `fs` `refreshBeat` | decorations of one beat (`decorate`) | yes | deferred |
| `fs` `decorate` / `syncSpots` | ZWSP caret spots inside the beat, `data-visual` | yes, on every `syncBeatEl` | not called by the composing `input` path |
| `fs` gap typing (F4) | `beat.innerHTML =` the operation's result | yes | no: `onBeforeInput` does not take this path while composing |
| `ce` `close` → `src/features/editing/cell-page.ts` `write` | the cell or beat's `innerHTML` after `ce.edit` (shortcuts, direction edge, marks) | yes, then refocuses | writer: not while composing (`fs` `onInput` returns first). Split view: `ed` `onRootInput` runs the shortcuts with no composing check; whether each shortcut ignores `insertCompositionText` was not traced |
| `ww` `leaveBeat`, `ed` `blurredCell`, `ww` `visualLeave` sanitize | the element being left | at blur | at blur |
| `flow-visual-box.ts` `open`, `refresh`, `rejected`, `paste` | the box | `refresh` repaints a focused box when it is not composing, dirty or saving, and keeps the selection | `refresh` skips |
| `rr` `commitRowPatch` / `paintOneRow` | the whole row element, focused cell included, when its signature differs | yes; `rememberCellSelection` / `placeEditorSelection` restore the caret. Edits under `whileShown` skip text fields (`ON_SCREEN_ALREADY`) | no guard |
| `rr` `render` → `paintAll` → `commitRows` | all rows | yes; `captureRenderFocus` / `restoreRenderFocus`, not while the writer is open | no guard |
| `rr` `ensureTrailingCaretSpot` | a trailing caret spot in a cell | yes | no guard |
| `rr` `paintAll` title | `#doc-title` | skipped while focused | n/a |
| `rr` `paintSessionChange` title | `#doc-title`, `#writer-title` | written even when focused, on `title` + `titleVersion` or on replay | no guard |

What `repaint()` does today, against the plan's section 4:

- **Confirmed:** `repaint()` paints into a focused beat and keeps each beat's last HTML in `rendered`.
- **But `rendered` is a paint cache, not yet a base:** `syncBeatEl` overwrites it after every sync and never reads it, and `paint` uses it only to skip beats whose model HTML is unchanged.
- **Who calls it from outside:** `src/bootstrap/wiring/panels.ts` (`onPainted("screen")`) → `writer.ts` `paintWriterDraw` → `fw` `repaint`. "screen" is announced at the end of every `rr` `render()`, which runs for replay, absorbed kinds and any edit `paintsWhole` accepts, including a text edit not made under `whileShown`. So an outside edit is painted into the focused beat through the session's change listener, not by a later poll.
- **An owed repaint during composition:** `paint`, `repaint` and `refreshBeat` set `repaintOwed`. At `compositionend`, `onCompositionEnd` first runs `syncComposition`, which writes the composed beat whole over the model, and only then `repaint()`. The outside change to that beat is lost; changes to other beats are painted.

## Open questions

1. Does an outside edit to the composed beat survive composition end? The code says no (D3). Experiment: in the writer, start a composition, call `__writerFlowTest.outsideEdit` on the same beat, end the composition, compare the model. This is the T04 baseline.
2. Can a Split view cell be replaced mid-composition? `commitRowPatch` has no composing guard. Experiment: compose in a narration cell, commit a `cellTextCommand` to the same row's visual field from a test hook, check that the IME text and the composition survive.
3. Is text typed while `editingBlocked()` is true ever written? `syncBeatEl` drops the sync; the next sync of that beat would pick the DOM up, unless a paint replaces it first. Experiment: dispatch `input` inside `paintGuard().whilePainting`, then trigger a repaint, and compare DOM and model.
4. Can undo of a move move the wrong beat? `planSteps` checks only that a `moveRow` step's indexes exist. Experiment: a unit test on `src/application/editing/undo/history.ts`: record a move, insert a beat above it in the live document, undo, check which id moved (T12).
5. Does "replace one" fold into a typing undo group? `replaceCurrent` does not call `breakCoalescing`. Experiment: type in a cell, replace a match in the same cell within one second, undo once.
6. Do the Split view input shortcuts ignore composition input? Experiment: a unit test per shortcut with `inputType: "insertCompositionText"`.

## Decisions for Adam

1. Title and scene names are whole strings today, the title written on every keystroke. Should two people be able to type in them at once with both edits kept, or does the last writer win? Assumed meanwhile: last writer wins.
2. A comment is two undo entries today (the anchor, then the record on Post). Should one undo remove both? Assumed meanwhile: keep two.
3. Cutting beats removes them at once and pasting re-inserts them later, so collaborators see the beats disappear between the two steps. Is that acceptable, or should a cut-then-paste become one move? Assumed meanwhile: keep two commands; T10 covers it.

## Doc mismatches

- [WRITER-FLOW-PLAN.md](../../WRITER-FLOW-PLAN.md) says the old writer depends on `joinBeatsCommand`; it has no app caller, only tests.
- WRITER-FLOW-PLAN.md says `paintWriterDraw` replaces all of `#writer-doc`; it calls `flowWriter.repaint()`, which patches only changed beats.
- [HANDOFF.md](../../HANDOFF.md) section 3.10 and [DOCUMENT-MODEL.md](../../DOCUMENT-MODEL.md) name `splitRowFieldCore(cellEl)`; the code has `splitField` in `src/features/rows/beats.ts`.
- [COLLABORATION-PLAN.md](../../COLLABORATION-PLAN.md) section 4 calls the surface's last painted HTML "already an editor base"; `syncBeatEl` overwrites it after every sync and never reads it, so today it is a paint cache.
