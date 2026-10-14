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
