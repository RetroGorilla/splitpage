# Milestone 5: formats consume captured data and one registry

The working notes for milestone 5 of [the implementation plan](../IMPLEMENTATION-PLAN.md#5--make-formats-consume-captured-data-and-one-registry), as amended by the [external review of the plan](milestones-4-7-rescope.md#external-review-of-milestone-5-2026-10-14). This file records what each step built. The steps themselves, their models and the gate are in the plan.

## As built

### Step 1: the remaining writers take the captured document

Merged as PR #576. Described in [saving.md](saving.md) section 6.

### Step 2, helper-move PR (PR #577): the byte helpers

The plan splits step 2 into small PRs in this order: capture and projection changes, mechanical helper moves, registry integration. This is the helper-move PR. It left the writers in the import cycle; the projection PR below closed step 2.

`zipWrite`, `zipRead`, `strBytes`, `latin1Bytes`, `concatBytes`, `xmlEscape` and `htmlToRuns` left `14-export.js` for `src/adapters/formats/`, one file per concern:

| File | Exports |
| --- | --- |
| `bytes.ts` | `strBytes`, `latin1Bytes`, `concatBytes` |
| `zip.ts` | `zipWrite`, `zipRead` |
| `xml.ts` | `xmlEscape` |
| `html-runs.ts` | `htmlToRuns` |

Behaviour is unchanged. Four details differ from a plain copy:

- `htmlToRuns` takes the HTML parser as its second argument, because an adapter may not import the legacy rich-text bridge. Only tests call it; production code reads runs through `toDocxRuns`.
- `xmlEscape` builds its control-character pattern from character codes, so the lint suppression that sat on the old regex is gone and `tools/comment-baseline.json` drops that entry.
- `zipWrite` with no day still writes 1980-01-01 and never reads the clock.
- `zipRead().get` checks for an own entry name, so a name such as `toString` or `__proto__` returns `null` where it used to reach `Object.prototype` and throw.

Importers: `15-docx.js`, `16b-xlsx.js`, `17-pdf.js`, `18-local-files.js`, `20f-desktop.js` and seven test files. `14-export.js` keeps `htmlToPlainText`, `tagPrintColor` and `TAG_PRINT_COLORS`, which are the next cut.

#### Cycle result

`node tools/dep-report.mjs --metrics`, before (`3e37ede`) and after:

| | Before | After |
| --- | --- | --- |
| Frontend modules | 178 | 182 |
| Largest frontend runtime cycle | 53 | 53 |
| Runtime cycle edges | 413 | 413 |
| Baseline exceptions | 619 | 619 |

The helper move alone does not take any writer out of the cycle, and the plan says it would not be enough. Each writer's remaining path back to itself, by the shortest route through the cycle:

| Writer | Imports that keep it in the cycle | Shortest path back |
| --- | --- | --- |
| `14b-export-kit.js` | `01-scene-status`, `07-production-tags`, `08-production-panels`, `08c-broll`, `08d-broll-panel`, `10-comments`, `14-export` | through `08-production-panels` (which imports `14b`) |
| `15-docx.js` | `01-scene-status`, `14-export`, `14b-export-kit` | `14-export` then `18-local-files`; `14b` then `08d-broll-panel` then `18-local-files` |
| `16-csv.js` | `08-production-panels`, `10-comments`, `14b-export-kit` | `08-production-panels` imports `16-csv` back; `14b` imports `08-production-panels` |
| `16b-xlsx.js` | `08-production-panels`, `08d-broll-panel`, `14-export`, `14b-export-kit`, `16-csv` | `14-export` then `18-local-files`; `08d-broll-panel` then `18-local-files` |
| `17-pdf.js` | `05-render`, `07-production-tags`, `08d-broll-panel`, `10-comments`, `14-export`, `14b-export-kit`, `15-docx` | `14-export` then `18-local-files`; `05-render` then `03-sync` then `18-local-files` |

### Step 2, projection PR: the writers read the captured document

Step 2 is done. The writers no longer import the production, comment or b-roll modules, `01-scene-status.js` or `14-export.js`; every fact they print comes from the `ExportDocument` or from a module outside the cycle. Output bytes are unchanged for unchanged inputs: the existing byte fixtures, goldens and the gated race matrix pass untouched.

What moved, and where it went:

| Moved | From | To |
| --- | --- | --- |
| `htmlToPlainText` | `14-export.js` | `src/legacy/plain-text.ts` (it parses through the rich-text bridge, so it stays in the legacy layer) |
| `tagPrintColor`, `TAG_PRINT_COLORS` | `14-export.js` | `src/adapters/formats/print-colors.ts` |
| `videoHostLabel` | `05-render.js` | `src/adapters/formats/video-host.ts` |
| `ROW_STATUSES`, `rowStatus` | `01-scene-status.js` | `src/core/production/looks.ts` |
| `TAG_CATEGORIES`, `TAG_STATUSES`, `tagCategory`, `tagStatus`, and the sorting half of `tagsByCategory` (now `groupTagsByCategory`) | `07-production-tags.js` | `src/core/production/looks.ts` |
| `sceneFacts` | `14b-export-kit.js` | `14c-export-projections.js` |
| `breakdownRows`, `breakdownTable` | `08-production-panels.js` | `14c-export-projections.js` |
| `shotRecordForFile`, `brollTable`, `brollShotListForPrint`, `brollGroups` and the filter and group tables they read | `08d-broll-panel.js` | `14c-export-projections.js` |
| `commentEntries`, `commentBodyText` and the body-piece helpers | `10-comments.js` | `14c-export-projections.js` |

`14c-export-projections.js` is the reusable projection half that the plan separates from capture: every function in it takes an `ExportDocument` (or rows and people taken from one) and imports nothing from the cycle. `14b-export-kit.js` keeps capture, the read-model derivation, asset glue and the document facts. The old homes re-export the names the panels, the dialog, `18-local-files.js` and the tests still import (`breakdownRows`, `breakdownTable`, `brollTable`, `brollShotListForPrint`, `shotRecordForFile`, `commentEntries`, `commentBodyText`, `sceneFacts`, and the looks tables), so those importers did not change. `htmlToPlainText`, `tagPrintColor` and `videoHostLabel` are not re-exported: their importers (`05e`, `08c`, `10`, `15`, `16b`, `17`, `18a`, `18c`, `19` and the tests that read them from `14-export.js`) import them from the new homes. The writers import the projections from `14c-export-projections.js`.

Three behaviours differ from a plain move:

- `brollGroups` no longer falls back to `S.state` in the projection module. Callers outside the writers use a one-line wrapper in `08d-broll-panel.js` that supplies the open document's rows and people.
- `commentEntries` takes the clock (`clockMode`) as an explicit option. `exportComments` reads the stored clock preference once and passes it, so a writer formats every comment time with one clock. With no option the old behaviour (read the preference per call) is unchanged for the Markdown and menu callers.
- `wordCount` in the writers is `productionReaders.wordCount`, the same function `01-scene-status.js` exported.

#### Cycle result

`node tools/dep-report.mjs --metrics`, before (the helper-move PR, `3d7bc81`) and after:

| | Before | After |
| --- | --- | --- |
| Frontend modules | 182 | 187 |
| Largest frontend runtime cycle | 53 | 48 |
| Runtime cycle edges | 413 | 370 |
| Baseline exceptions | 619 | 576 |

`14b-export-kit.js`, `15-docx.js`, `16-csv.js`, `16b-xlsx.js` and `17-pdf.js` are out of the cycle, and so is the new `14c-export-projections.js`. None of the six has an outgoing edge into it any more, and the 43 cycle-edge exceptions that described those edges are pruned from `tools/dep-baseline.json`. `tools/test-dep-report.mjs` now fails if any of the six returns to a runtime cycle.

Each writer's remaining imports, all outside the cycle:

| Writer | Imports that remain |
| --- | --- |
| `14b-export-kit.js` | `00p-prefs` (clock preference, read once by `exportComments`), `02-state`, `02c-blobs` (the asset ports passed to `application/export/assets.ts`), `14c-export-projections`, and core, adapter and legacy-bridge modules |
| `14c-export-projections.js` | `00p-prefs` (`formatDateClock`, only when the caller names no clock), and core, adapter and legacy-bridge modules |
| `15-docx.js` | `00p-prefs` (`narrationIncludesDirections` and its setter, read by dispatch and the dialog, not by the narration builders, which take `opts.directions`), `02c-blobs` (stored pictures, DOCX import) and `02d-gallery` (picture links), `14b`, `14c` |
| `16-csv.js` | `14b`, `14c` |
| `16b-xlsx.js` | `14b`, `14c`, `16-csv` |
| `17-pdf.js` | `02d-gallery` (picture links), `14b`, `14c`, `15-docx` (`jpegSize`, `safeAspect`) |

What is left of the plan's list for step 2 is step 4's: the `14-export.js` dispatch edges (`18-local-files.js`, the hosted and desktop modules) stay until the registry owns dispatch, and the preference accessors above move with it.

Tests: `export-projections.test.mjs` captures a demo document, empties and renames everything live, and asserts every projection (scenes, breakdown, breakdown table, b-roll table, shot list, comments) returns the same answer; asserts the comment clock comes from the caller, not the stored preference; and pins `brollGroups` to the rows and people it is given. The existing unit tests that imported the moved names now import them from their new homes.

### Step 3: import

Decoding is unchanged and stays in `11-import.js`, `15-docx.js` and `16-csv.js`; it adopts nothing and marks nothing unsaved until the user confirms. What changed is what a confirm does, and which decode results the modal accepts.

**Append and replace are a session command.** `importRowsCommand` (`src/application/commands/import-rows.ts`) inserts the decoded scenes after the existing ones, or in place of all of them, as one transaction: `rowsInserted`, `rowsRemoved` for a replace, `derive` `production` and `broll`. It stamps copies of the decoded rows with one clock read, runs the import scans (the b-roll scan, `anchorBrollInRows`, now given the document it plans against) on the live document with the scenes already in place, and the session reconciles comment anchors because rows were inserted or removed. A scan that throws rolls the whole import back. The document keeps its identity, destination and baseline; undo takes the import and its scan back in one step, as before. A replace still keeps the "Before replacing rows on import" history version first, now only when the session will let the edit through. The command needs edit capability, so a reviewer's confirm is refused with the "Viewing only" toast; the menu item was already disabled for reviewers.

**Import as a new document stays an adoption.** The new-tab "paste one" link hands its rows to `adoptNewDocument`, which goes through the transition API's `startNew`. The scans now run on that document before it is handed over, so the adopted document is the scanned one. Measured on `74f6ecd`: the scan ran after the adoption as a legacy edit, so the first Ctrl+Z after the import took the b-roll tracking back out; now that undo leaves the imported document as it was.

**Decoding is bound to its modal and document.** The modal has an epoch, bumped when it opens and when it closes, and each file choice has a sequence number; an append or replace import also captures the operation (`captureOperation`) when it opens. A decode that finishes after the modal changed, after a later file was chosen, or, for an append or replace, after the document stopped owning the operation, fills nothing and shows no error. A confirm after the document was replaced closes the modal, imports nothing and says so ("The script changed while the import was open…"). A new-document import belongs to no open document, so only the modal epoch and the file sequence bind it.

Tests: `src/test/import-rows.test.mjs` characterizes append, replace, an empty replace, a confirm with nothing to import, the b-roll scan on and off, a decoded file waiting in the modal, and import as new, and covers the later-file-wins and new-document cases; on `74f6ecd` every case passed except two, measured: the import-as-new undo assertion (changed as described above) and the later-file-wins case (the earlier file overwrote the later one). `tests/application/import-rows.test.ts` runs the command through a fake session under `runConfined`: the change set, one clock read, the scan inside the transaction, rollback when the scan throws, the no-op and refusals, and identity. Matrix cases I3 to I6 (milestone-4.md) cover the import writeback's stored bytes with its picture loads held and the decode and confirm bindings.

### Step 4: the format registry

Step 4 is done. One registry, `src/application/export/registry.ts` (an instance at `src/legacy/export-formats.ts`), declares every export. The dialog, the File menu's export entries, the command palette, Export Again, the native-menu check and `buildFileData`'s dispatch read it. Output bytes are unchanged: the byte fixtures, the goldens, the browser suite `98-export-dialog.txt` (every card against its old button, byte for byte) and the gated race matrix pass without edits to what they assert.

**What a declaration holds.** A *card* is what the dialog shows (id, group, name, extension, icon, purpose, the heading over its choices, whether it carries pictures or a tail, and an optional toggle). An *exporter* is one provider under one stable id:

| Field | Meaning |
| --- | --- |
| `id` | The old kind string (`pdf`, `md-table`, `b-roll csv`, `txt`, ...). `buildFileData` and import writeback look providers up by it. |
| `action`, `card`, `choice`, `name`, `menuLabel`, `words` | Present only for a user-facing format: the action id (`export-pdf`, unchanged, and what Export Again stores), the card and the choice that picks it, its name in "Export as ...", its menu text and its palette search words. |
| `reason`, `refusal` | Availability. `reason(doc)` gives the text the dialog, the palette and Export Again show when nothing can be exported; `refusal` is the toast when the action runs anyway, where it differs. Both read the captured document. |
| `defaults` | Request options the action implies (the b-roll PDF prints the whole list by scene). |
| `writeback`, `bundlesPictures` | `writeback` marks the providers import writeback may use (`docx`, `csv`, `md`, `txt`). `bundlesPictures` marks the one whose file name changes to a zip when pictures are included. |
| `fileName`, `build` | The file name and the provider. `build({ doc, options, assets, ports }, baseName)` returns the bytes and may report `diagnostics.imagesLeftOut` and `imageBundle`. A provider does not toast, save, adopt or retarget; `buildFileData` raises the "images could not be included" warning from the diagnostics. |

`txt` has an id and no action: it is the plain-text writeback for imported `.txt` files and appears nowhere. Project Markdown, presentation Markdown and imported-file writeback stay separate: project Markdown is `buildMarkdownProject` on the save path and is not registered; presentation Markdown is `md`/`md-table`; writeback uses the providers flagged `writeback`. The registry refuses a duplicate id or action, an action on a card that does not exist, a card with several exporters when any lacks a choice, and a repeated choice.

**Where it lives.** `14e-export-formats.js` holds the nine cards and the seventeen providers (sixteen user-facing, `txt`), each a few lines over the existing builder; `14d-export-text.js` holds the Markdown and plain-text builders that left `14-export.js` and `18-local-files.js` (`toMarkdownDoc`, `toMarkdownTableDoc`, `markdownExportImages`, `mdSceneCellSource`, `exportMetaLine`, `htmlToPlainScript`); `buildBreakdownCsv` and `buildBrollCsv` moved from the two panels to `16-csv.js`. Importers (twelve test files, `20d-formats.js`, the dialog) import from the new homes. `18-local-files.js` keeps the request and the dispatch: `exportRequest` captures once, `buildFileData` resolves the assets, calls the provider and warns from its diagnostics, `runExport` checks the exporter's reason and runs it, `runExportAction` is the one entry for the dialog, the palette and the menu.

**Menu, palette, dialog.** The File menu's sixteen buttons in `page.html` are gone; `syncExportMenu` in `18c-export-dialog.js` draws them into the hidden group from the registry, so `#file-menu [data-file-action="export-pdf"]` and the native menu's `isFileMenuItem` check still find them. The dialog no longer finds and clicks one of them: it calls `runExportAction`. The cards, choices and toggle are drawn from the registry and rebuilt when it changes. The palette's list and its order come from the registry. The desktop's own menu is built in the main process (`desktop/main.js`) and still lists the sixteen built-in actions; this step does not change preload or IPC, so a new exporter reaches the desktop's native menu when that list names it, and the File menu, the palette, the dialog and Export Again need nothing.

**Captured at capture.** Two reads that happened at export time now happen once, with the document:

- The 12-hour or 24-hour clock setting: `ExportDocument` carries `clockMode` (`system`, `12` or `24`), read in `captureExportDocument`. `exportComments` formats every comment time from it, so a writer never reads `00p-prefs.js`.
- The narration stage-directions preference: the accessor and its setter moved from `15-docx.js` to `14e-export-formats.js`, where the narration card's toggle declares them. `exportRequest` resolves the toggle once (`exportToggleOptions`), and the dialog's preview, summary and execution call the same function.

The HTML provider takes `ports.standaloneHtml` (`standaloneHtmlFor`) from `buildFileData` instead of importing `02b-doc-id.js`, which keeps the format declarations out of the cycle.

**Dispatch edges.** `14-export.js` no longer imports the panels, the production module, the comment module or the b-roll module for export work, and `18c-export-dialog.js` no longer imports `14-export.js`. Six cycle-edge exceptions left `tools/dep-baseline.json`.

#### Cycle result

`node tools/dep-report.mjs --metrics`, before (`ab9e301`, step 3) and after:

| | Before | After |
| --- | --- | --- |
| Frontend modules | 188 | 192 |
| Largest frontend runtime cycle | 48 | 48 |
| Runtime cycle edges | 370 | 364 |
| Baseline exceptions | 575 | 569 |

`14d-export-text.js` and `14e-export-formats.js` are outside the cycle; `tools/test-dep-report.mjs` fails if either returns.

#### Tests

- `tests/application/export-registry.test.ts`: the registry's rules (ordering, choices, duplicates, provider-only exporters, unregistering, frozen declarations).
- `src/test/export-registry-app.test.mjs`: the gate. A throwaway card and provider registered through `exportFormats` appear as a menu entry, a palette item, a dialog card and an Export Again target with no edit to routing or save code; each runs and delivers its file; the document and the dirty flag are untouched; a reason greys it out in all four; a second exporter joins an existing card as a choice; unregistering removes it everywhere.
- `src/test/export-capture-app.test.mjs`: the captured document's key list gains `clockMode`. That is an explained correction of an exact key list, not a loosened assertion.
- The existing export suites follow the moved builders to their new homes (`m4-matrix-exports`, `text-exports`, `broll-model`, `markdown-table` and the others), asserting what they asserted before.
