# Captured HTML print layout

AQ-40 and AQ-41 implement roadmap C6 P1 and P2. AQ-43 wires these layouts to
browser PDF actions through a separate print-dialog adapter, and AQ-42 (P3)
prints the same pages to PDF files on desktop with Electron's `printToPDF`.
No live path calls the old PDF builders any more; that generator and its unit
tests remain until P5. The layout modules themselves do not open a window,
print, register an exporter, resolve assets, or read a session or preference.

## Existing PDF content inventory

| Output in `buildPdf` | Captured input and existing projection | P1 destination |
| --- | --- | --- |
| Title, scene count, runtime, target/delta, shot count, calendar date | `ExportDocument`, `exportFacts`, `exportSummaryParts` | Script heading and facts line |
| Rundown and status legend | `sceneFacts` durations/statuses, `exportFacts` status counts and target | Proportional scene strip, status counts, target in facts line |
| Scene number, start, status, read time and explicit-duration border | `sceneFacts` | Scene and Read columns |
| Visual/audio words, bold, italic, underline, strike, highlight, links | Captured scene HTML decoded by `ExportServices`, `exportRuns` | Escaped semantic HTML in fixed-width columns |
| Tags, B-roll keys, stage directions, audio cues, thread anchors/numbers | `exportRuns`, captured `commentNumbers`, print palette | Category underline, chip, brackets, cue styling and numbered markers |
| Main and gallery pictures; video references | Captured row/gallery refs, legacy data URLs, held `ExportAssets`, `rowVideoLinks`, `videoHostLabel`, `videoLinkText` | Embedded raster data URLs and safe text links with host labels; unavailable images get an explicit placeholder |
| Production breakdown | Captured production entries and `breakdownGroups` | AQ-41 section renderer |
| B-roll shot list appendix | Captured B-roll/people/scenes and `brollShotListForPrint` | AQ-41 section renderer |
| Comments, quotes, authors, timestamps, assignees, resolution, replies and images | `exportComments({pieces:true})`, captured clock mode and held assets | Comments section, including title/deleted-scene threads |
| Running title, page numbers, bookmarks, viewer title/date | Captured title/date plus pagination metadata | CSS page-margin title/counters and HTML title; desktop PDF metadata/bookmarks belong to P3 |

The existing script PDF has no stage-direction toggle: it includes directions
and cues. P1 preserves that behavior. Narration's separate direction option
and list filter/group options remain with their respective writers. P1 does
not silently select live export-dialog settings.

## Modules and input contract

`src/adapters/formats/script-print.ts` accepts `ScriptPrintInput`: one frozen
`ExportDocument`, its held `ExportAssets`, and the existing `ExportServices`.
The caller captures before any asynchronous asset loading, as described in
[saving.md](saving.md#6-capture-46), and supplies the resolved asset map.
Rendering is synchronous and deterministic for that input; it performs no
asset lookup against the live store. Dates and comment clocks come from the
capture. Missing or unsafe image bytes never become a remote URL.

`scriptPrintSections(input)` returns the script followed by comments, if any.
`buildScriptPrintPage(input)` wraps those sections as a standalone document.
Facts, scene timings/statuses and comment numbering are supplied by the
existing projections, rather than recalculated by the print renderer.

`src/adapters/formats/print-page.ts` owns `buildPrintPage(title, sections)`,
the shared CSS, safe link rendering and raster embedding. `PrintSection`
contains `id`, `title` and renderer-owned `html`. Its HTML is trusted markup
produced by a section renderer, never raw user HTML. The shell escapes section
attributes and document titles; renderers must escape every content value.
`printPicture` inspects the held bytes and permits PNG, JPEG, WebP and GIF;
SVG, arbitrary MIME values and missing bytes produce a placeholder.

`src/adapters/formats/list-print.ts` accepts `ListPrintInput`: the captured
`ExportDocument` and existing `ExportServices`. No list needs assets. The
renderer uses `breakdownGroups`, `brollShotListForPrint`, the category/status
looks and print palette; it does not derive tags, B-roll references, owners,
scene times or shot status from live state. Summary counts only aggregate the
projected rows, as in the old writer. No list fact calculation belongs in the shell.

`packingPrintSection(input, catId)` and `shotListPrintSection(input, options)`
return `PrintSection`s. `buildPackingListPrintPage` and `buildShotListPrintPage`
wrap their respective sections with `buildPrintPage`. `listPrintSections(input)`
returns the nonempty all-category production breakdown and all-shots, by-scene
appendix. `buildScriptWithListsPrintPage(input)` accepts `ScriptPrintInput`
including held assets and composes `[script, ...listSections, ...comments]`.
`buildScriptPrintPage` remains the P1 script/comments builder. The composed
and standalone pages are registered as captured `printPage` providers for
browser PDF exports. The shell supplies fixed-layout tables, repeating
headers, section page breaks, image bounds, list marks and wrapping.

## Existing list content inventory (P2 step 0)

| Old output | Options, filters and grouping | Columns and detail | Marks, counts and captured facts | P2 destination |
| --- | --- | --- | --- | --- |
| `buildPackingListPdf(doc, "gear")` | Gear only, alphabetical by item name, including orphaned tags | Out, Back, Item, Status, Owner, Scenes; item notes and associated B-roll names; orphan label "Not in script" | Two empty boxes per item; four cumulative status steps, Needed/Sourcing/Have it/Returned key and fill-in hint; item count and nonzero status counts in have/sourcing/needed/returned order; category color; captured title/day; Packed by/Returned by and date lines | Standalone gear packing section/page |
| `buildPackingListPdf(doc, "prop")` | Props only, same ordering and orphan handling | Same six columns and details | Same marks, counts, signatures and captured facts; empty message "Nothing tagged Prop yet." (Gear for gear), with no table/signatures | Standalone prop packing section/page |
| `buildPdf` production breakdown | All nonempty tag categories in `breakdownGroups` order, including categories outside gear/prop and orphaned items | Item, Status, Scenes, Assigned to; notes and associated B-roll names; missing owner em dash | Per-category color/count; status marks/labels; total item and nonzero status counts in category-status order; title/day supplied by script | `productionBreakdownPrintSection`, omitted when empty; not replaced by packing checklists |
| `buildShotListPdf` | `all`, `unshot`, `flagged`, `shot`; group by `scene`, `location`, `person`; invalid values fall back to all/scene; added shots and missing location/person groups retained | Done, Scene/start, B-roll shot/name/description/audio reference, Location, Props with status, Assigned, Flagged/note, Notes; grouping field omitted from redundant cells | Done checkbox and dimmed shot names; flag mark; ruled notes space; whole-capture shot/flag summary even when filtered; projected scope and group counts; captured title/day | Standalone landscape shot section/page, including "No shots to list." for empty/filtered-empty results |
| `shotListAppendixPages` from `buildPdf` | All shots by scene, regardless of panel settings; omitted when empty | Same eight columns and row details as standalone shot list | Same marks, counts and notes space; no repeated title/date at appendix heading, since script supplies them | Landscape shot appendix between production breakdown and comments |

No old list output is removed or modified. Standalone packing pages retain
their signatures; the script retains its all-category breakdown rather than
adding standalone-only packing signatures. The standalone shot page preserves
the captured calendar date through `exportDateText(exportDay(doc))`, including
serialization after midnight. There is no clock or preference read.

## Print behavior and deliberate differences

The page uses Letter paper with 0.6-inch margins, the light print palette and
the computer's system fonts. It bundles no fonts and fetches no font, image,
stylesheet or script. A restrictive CSP permits only inline CSS and raster
data images. Links preserve safe HTTP(S)/mailto destinations without fetching
them during rendering. There is no printable-document script.

Table rows use `break-inside: avoid`; a row taller than a page may still split.
Chromium decides page breaks and repeats table headers. Oversized scene rows
can span pages without a hand-drawn pagination algorithm or a `cont.` label.
Long words wrap within their column; text and scene content are not clipped.
Pictures retain their aspect ratio within column and page-height bounds.
Gallery pictures flow vertically rather than the old three-thumbnail strip,
so each remains legible. The rundown target remains in the facts line instead
of a hand-positioned vertical rule. Footer titles can ellipsize; the full title
remains in the heading and document title.

Bookmarks are desktop-only (P3, from the page's headings). Browser users choose
“Save as PDF” from their print dialog through P4. The old generator stays until
P5 and the PC PDF check.

P2 preserves portrait packing/breakdown and landscape Letter shot pages through
a named CSS page. The shared 0.6-inch margins replace the old packing 0.75-inch
and shot 0.5-inch margins. Deliberate content/presentation differences from the
old list PDFs are:

- Full audio references replace the old 84-character opening excerpt and ellipsis.
- Group labels wrap completely instead of keeping only the old first wrapped line.
- Scene groups show their label and done/total count, and every shot repeats its
  scene/start; the old table suppressed duplicate scene cells and scene bands.
- Packing status labels accompany the four filled progress segments. The legend
  uses individually outlined status labels instead of a single empty pill.
- Notes and descriptions retain captured line breaks; packing notes previously
  collapsed whitespace. Associated B-roll names share a wrapped line in breakdowns
  instead of separate chips. Status marks use CSS circles/half fills/rings, and
  flags use colored text rather than PDF drawing operations.
- Chromium repeats column heads and splits oversized rows, with no continued
  group labels or `cont.` markers. Signatures stay together. Notes space uses
  CSS rules with a minimum height rather than manually drawn rows of rules.

These differences now apply to browser PDF exports. Text is escaped at
every insertion, including unknown category fallbacks, group labels, owners,
notes, prop statuses and audio references. The composed script continues to use
P1's `videoHostLabel` and `videoLinkText` helpers for video references.

## Browser print workflow (P4)

The browser entry points all meet at `local-files.js`'s `exportAs`: the export
dialog button, the hidden File menu actions, the command menu and Export again.
The Gear panel's packing button runs the gear action; the B-roll full page's
Print button calls `exportAs("b-roll pdf")` with its current filter/page group.
The two added routing lines delegate to `browser-pdf.ts` through the named
`pdfPrint` port. Other exports retain `buildFileData` and the existing
file-delivery path; since P3 the desktop branch of the same port prints
through `desktop-pdf.ts` (below). The shared registry's optional
`printPage(request)` accepts the captured document, held assets and options;
AQ-42 can consume the same providers without changing the browser adapter.

| Action | Captured input/options | Previous browser result | P4 result |
| --- | --- | --- | --- |
| `export-pdf` | One `ExportDocument`, clock/day, picture-hash request and resolved assets; script always includes directions, all production groups, all shots by scene, comments/replies | Download script `.pdf` bytes | Composed script/list/comment print page |
| `export-packing-gear` | One capture, gear category | Download Gear packing `.pdf` | Gear packing print page |
| `export-packing-prop` | One capture, prop category | Download Prop packing `.pdf` | Prop packing print page |
| `export-broll-pdf` | One capture, frozen `brollView`; action defaults to all/scene, explicit filter/group resolved before awaiting assets | Download landscape shot-list `.pdf` | Named landscape shot print page |
| B-roll full page Print | One capture, current filter and page group frozen before awaiting assets | Download the visible scope's shot-list `.pdf` | Captured filtered/grouped landscape print page |
| Export again | Remembered action, fresh capture and resolved options | Repeat that PDF download | Repeat that action's print flow |

`PrintDialogPort.reserve(alive)` opens a blank window synchronously in the user
action. A blocked popup reports that pop-ups must be allowed for Splitpage.
The capture and option resolution happen before loading assets. A later edit
or document switch cannot change the page; rendering reads no live editor or
preferences. The originating mount's lifetime remains authoritative.

`src/adapters/print/browser-print.ts` writes the standalone page, waits for
its font readiness and image decoding, focuses it and calls `print()`. It
answers `opened` or `closed`, never `saved`. The export UI says to choose Save as PDF;
it cannot know whether the user saved, printed or cancelled. No save owner,
dirty flag, merge baseline, identity, history or project Save is changed.
Failures close the preparation window and show an error. A 60-second
preparation deadline, manual window close, mount retirement and parent page
exit release resources. The deadline is cleared before invoking print, so
it cannot close an active dialog. `afterprint` closes the window for both
printing and cancellation; browsers without that event leave it for the user
to close. No object URLs or printable-document scripts are created.
The completion notice says only that the print request was sent to the browser:
Chromium's print call can return after saving or cancellation closes the dialog.

The intended workflow replaces the browser download expectations in suites
03, 12, 41, 65, 96, 98, 145 and 284. They capture the page at print invocation, compare
the same captured HTML by both routes, retain content/colour/picture-order
checks, assert cleanup and no PDF download, and leave non-PDF checks intact.
Suites 12/96 retain the Gear-panel and B-roll-page routes, checklist/signature
and shot/person/flag details. Suite 96 checks the named shot's Scene cell and
start directly. Suite 65 verifies the held PNG/WebP/legacy images decode at
their captured dimensions. P4 then forced the old desktop PDF route there and
checked three JPEG image streams; since P3 that step forces the desktop
`printToPDF` route instead and checks that the printed page carries the same
three safe picture data URLs as the browser page, that the PDF written through
the save dialog has its date pinned to the captured day, and that no print
dialog opened. The real Chromium conversion is checked by the desktop smoke.
Old manual pagination geometry in suite 41 is replaced by loaded-image aspect
ratios, bounds, non-overlap, complete text and print CSS checks; the actual
page-break checks belong to print fixtures 382/383 and Adam's saved PDFs.
Suite 384 covers all four actions, Export again, blocked popups, font delay,
document switch, image failure, cancellation and cleanup. Its final probe
opens a real headless popup, verifies image decoding and intercepts print
invocation before checking `afterprint` cleanup. Adapter, workflow
and booted-app tests cover lifecycle, captured options and unchanged save
state/baseline/identity.

Roadmap C6 explicitly authorizes the browser workflow and Chromium pagination
differences. INV-57's shared facts and capture rules remain. For INV-60,
Splitpage's browser HTML remains deterministic for a captured day; the browser
controls saved-PDF metadata and bytes, so byte equality is no longer promised
for its PDF file. INV-61's exact artifact syntax and old PDF bookmarks remain
tested on the old generator, without being claimed for browser output. Adam
must check real dialog cancellation, saved PDFs, fonts, page breaks and footers
on his PC before merging P4 or removing the old writer in P5. That check and
independent review are pending; this PR must not be merged by a queue agent.

## Desktop printToPDF (P3)

On desktop every PDF action still meets at `exportAs`. The `pdfPrint` port's
browser branch answers `null` there, and `desktop-pdf.ts` takes it instead.

| Action | Captured input/options | Old desktop result | P3 result |
| --- | --- | --- | --- |
| `export-pdf` (File menu, export dialog, command menu, native menu) | One capture and its picture request, resolved assets | Old writer's script `.pdf` through the save dialog | Composed script/list/comment print page, printed by Electron, through the same save dialog |
| `export-packing-gear` / `export-packing-prop` (also the Gear panel) | One capture, the category | Old packing `.pdf` | Packing print page as PDF |
| `export-broll-pdf` and the B-roll page's Print | One capture, `brollView` frozen before assets load | Old landscape shot-list `.pdf` | Landscape shot print page as PDF |
| Export again | The remembered action, a fresh capture | Repeat that file | Repeat that print |

The capture, the frozen options and the base file name are taken
synchronously in the user's action; a later edit, document switch or
preference change does not reach the page. The busy bar, the error notice
("Could not build the … file."), the suggested file name, the save dialog and
"Exported …" are the old path's. A retired mount prints and delivers nothing.

Contract and trust boundary. `PdfPrinter.print(html, doc)` (application type)
is built by `desktopPdfPrinter` (`src/adapters/print/desktop-print.ts`), which
calls the bridge's `printToPdf(html)` and pins the PDF's dates to
`exportDay(doc)`. The bridge crosses `splitpage:print-to-pdf`: app origin
only, one string argument, checked by `ipc-setup.js` like every channel. The
request carries no path, options or URL. Main refuses an empty string or one
over 256 Mi characters, and answers bytes; the renderer saves them through the
existing `saveFileDialog` and `writeFile` (file ids, never paths), so a
cancelled dialog is reported exactly as before.

Main (`desktop/print-pdf.js`) owns the print view. Each request gets a new
sandboxed, context-isolated `WebContentsView` with no preload and no window, in
the in-memory `splitpage-print` partition. That partition serves the page from
memory at a one-time `splitpage://print/<random>.html` with the print CSP as a
response header, refuses every other request except `data:` pictures, grants
no permission, denies new windows and blocks navigation. Its origin is not
`splitpage://app`, so it cannot use any IPC channel. Main waits for the load
event, then for `document.fonts.ready` and for every picture to be complete
with a width; a picture that failed fails the print. `img.decode()` never
settles in a view no window shows, so it is not used. Then `printToPDF` runs
with `preferCSSPageSize`, `printBackground`, `generateTaggedPDF` and
`generateDocumentOutline`. The view is closed and the page forgotten on
success, failure, a crashed print renderer, a 60-second deadline, the asking
tab closing, and `will-quit`, after which new prints are refused. Nothing is
written to a temporary file.

Bookmarks come from the page's headings: the script title, "Production
breakdown", "B-roll shot list", "Comments" and one per comment thread; a
packing list has its heading and category, a shot list its heading. The old
writer named its first bookmark "Script" and had none per comment. The
desktop smoke reads the outline of each product.

Output differences from the old desktop writer, beyond the Chromium layout
differences above, which now apply to desktop too:

- `/Creator (Chromium)` and `/Producer (Skia/PDF …)` replace `Splitpage`.
  Dates are midnight of the captured day with its offset, not a date only.
  The PDF is tagged.
- The computer's fonts replace the bundled Noto fonts, so the old warning
  about characters the PDF could not show is not raised for PDFs. Chromium
  falls back through system fonts instead.
- The footer is not an `/Artifact` (INV-61 desktop scope, awaiting Adam's
  decision).
- A picture whose bytes do not decode fails the export with the build error;
  the old writer left it out. Missing pictures still print the placeholder and
  raise no images-left-out warning, as before.

INV-60 holds on desktop: one capture printed twice on one day is the same
bytes (smoke, and `tests/adapters/print/desktop-print.test.mjs`). The editor,
document identity, dirty state, save confirmation, autosave and history are
untouched: the route only captures, prints and delivers a file.

## Fixtures and validation

AQ-45 originally stopped because the composed `script-long` fixture split the
45.9 pt `Spare 050` breakdown row across pages 5 and 6. Adam chose to keep rows
together; [the separate CSS fix](https://github.com/RetroGorilla/splitpage/pull/1012)
moves the whole row to page 6. Original PDF/screenshots remain in
[the stop report](https://github.com/RetroGorilla/splitpage/pull/1004#issuecomment-6546111375),
outside the current source tree. This check changes no product code or CSS.

`tests/adapters/formats/printed-layout.test.mjs` is discovered by `test:all`
and runs all 18 fixtures plus eleven fail-first probes. It uses the existing
Linux `tests` matrix job, without changing a workflow or adding a dependency.
The `checks` browser step selects exact existing suite filenames, so the new
check uses normal test discovery instead. Browser selection honors
`SPLITPAGE_CHROME`, then Windows Edge or the runner's existing versioned
browser cache, then `google-chrome`/`chrome` on PATH. Missing browsers fail
the check; no rule or fixture is skipped. Local runtime was 9.2 seconds for
the check, 10.0 seconds including test startup.

On Unraid, Tests uses `/opt/hostedtoolcache/splitpage-playwright/1.63.0`,
filled only by `checks`; a new or recreated runner needs one `checks` run
first, or Chromium in its image. The automatic test deletes its TEMP
directory only after every assertion passes, retaining artifacts on failure.

The inspector inflates PDF streams with `node:zlib`, decodes ToUnicode and
ActualText, applies text matrices, and follows tagged structure MCIDs to
associate text with physical pages, headings, rows and tables. Embedded
TrueType glyph bounds, Type3 bounds and CFF typographic metrics supply text
bounds. The checks use positions/order/text rather than pixel comparisons.
Text comparison follows tagged reading order, removes repeated column heads
and normalizes Unicode presentation forms, layout whitespace and RTL runs.
It retains all fixture text, including the non-Latin and emoji samples.

| Rule | Check | Scratch fail-first probe |
| --- | --- | --- |
| a | Section/comment, scene and list-group headings share a page with the first line they introduce | Force the first paragraph after a heading onto the next page |
| b | Each script/list/table row occupies one physical page; oversized rows are measured at their printable width and reported | Remove row avoidance from a controlled short row positioned across a page break, independent of system-font pagination |
| c | Every page carrying table body text has its complete column header | Render `gear-long` with a non-repeating header group |
| d, layout | Advance-width/ascent/descent boxes stay inside the body content area or footer margin box with 1 pt tolerance (about 0.35 mm), below visible differences while rejecting real overflow; ink may overhang its box by side bearing | Translate `prop-rich` 60 pt left; separately widen the footer beyond its margin box |
| d, ink | Real glyph bounds stay inside a 12 pt paper-safe border on all four sides (1/6 in, about 4.2 mm), calibrated to office-printer unprintable margins; the paper-safe border is what printers clip | Bottom-align footer text into the outer 12 pt |
| e | No missing glyphs; complete normalized fixture text matches tagged PDF text | Replace the title; separately insert an unsupported character |
| f | Running title and `Page n of N` match on every page | Replace the counter; separately remove the title |
| g | Existing media/clipping/wrapping/image/page-count assertions remain; every page has the correct Letter size/orientation | Print a Letter fixture on A4 |

Each probe edits only the loaded scratch document. It must fail its named
assertion, then reload and reprint the original fixture and pass all rules.
The inspector logs the closest ink to each paper edge and largest layout
overhang across unmodified fixtures; probe mutations are excluded.
The run records 267 checks: the original 130, 126 layout-rule groups and eleven
fail-first/restoration checks. PDFs, viewport screenshots, decoded page JSON
and `summary.txt` go to the output/TEMP directory, never the source tree.

Initial P4 validation on Node 24.22.0: the full verification gate passed all 571
discovered test files (195 frontend, 11 source, 320 tests, 23 desktop, 22 tools),
plus lint, types, dependency/comment gates and build. Final focused lifecycle
and app tests passed 11/11. Fourteen browser suites passed 957/957 checks on
the test build with at most three lanes: 03, 12, 34, 41, 60, 65, 96, 98, 145,
259, 284, 384 and fixtures 382/383. The last 384 run includes a real headless
popup and passed 36/36; 382/383 passed 23/23 and 60/60. Free RAM exceeded
10 GB before final browser runs. Native dialog and saved-PDF checks remain
for Adam; no desktop PDF branch changed, so no Electron smoke was required.

Review round 1 repeated the full gate with all 571 files passing. The focused
adapter/workflow/app tests passed 12/12, including a print call returning after
cancellation. Changed suites 65, 96 and 384 passed 55/55, 81/81 and 36/36
checks on a fresh test build with three lanes and 12.7 GB free RAM beforehand.
The latest counts across the fourteen suites total 962/962. Browser PDF scope
is now also recorded in INV-60/61, awaiting Adam's decision; desktop PDF keeps
both rules. Delta review and Adam's real-dialog/PDF checks remain pending.

The six tests in `tests/adapters/formats/script-print.test.mjs` cover rich text,
tags/keys/directions/cues, facts, comments/replies, raster/gallery/legacy images,
missing/unsafe assets, unsafe URLs, hostile titles, non-Latin text, empty/long
scripts, same-day determinism and capture-followed-by-edit stability. They also
compose a test list section through the shared shell.

Generate the browser-only artifacts before suite 382:

```text
node tests/adapters/formats/fixtures/write-script-print-fixtures.mjs
node build.mjs --test
node tools/run-suites.mjs <out> 'print|export' --lanes 3 --port-base <offset>
node tools/run-suites.mjs <fixture-out> 'print|export' --lanes 3 --port-base <offset> --suites tests/adapters/formats/fixtures/suites
node tests/adapters/formats/fixtures/inspect-script-print.mjs <inspection-out>
node tests/adapters/formats/fixtures/write-list-print-fixtures.mjs
node tools/run-suites.mjs <list-out> 'print|export' --lanes 3 --port-base <offset> --suites tests/adapters/formats/fixtures/suites
node tests/adapters/formats/fixtures/inspect-script-print.mjs <list-inspection-out> --lists --probes
```

The suite runner's `--port-base` is an offset: HTTP starts at `18100 + offset`,
and CDP at `19300 + offset`. The standalone inspector asks for a free CDP port
by default (`PRINT_CDP_PORT` overrides it); browser discovery is described above.
Check free RAM before each browser run; keep at least 4 GB available.

The fixture suite has its own suite directory; normal app suites need no
generated fixtures. Suite `382-script-print.txt` checks the rich, long and empty pages,
loaded pictures, complete scene tails, wrapping and horizontal bounds. The
standalone inspector enables actual print media, tests those bounds at the
printable width, and saves tagged Chromium PDFs, screenshots and `summary.txt`.
Generated `_script-print-*.html` files beside the fixture generator are covered
by the existing root `_*.html` ignore rule. Remove these temporary test artifacts
after the run; never commit them.
They are not built into the release app. No desktop smoke or editing/undo
performance run is needed for this unwired adapter.

P2 adds seven content tests in `tests/adapters/formats/list-print.test.mjs`,
covering both packing categories, all twelve shot filter/group combinations,
invalid-option defaults, all-category script composition, empty/filtered-empty
states, hostile text, capture-after-edit stability, same-day determinism, long
labels, oversized rows and non-Latin text. Suite `383-list-print.txt` exercises
standalone and composed pages plus selected filters/groups. The inspector's
`--lists` mode checks actual print media for fifteen fixtures, repeating header
styles, bounds, complete long-row tails, mixed page orientations, and PDF page
counts. Generated `_list-print-*.html` files use the existing `_*.html` ignore
rule and must be removed after validation.

P2 validation on Node 24.22.0 and Windows Edge: `npm run verify` passed all
568 discovered files (194 frontend, 11 source, 318 tests, 23 desktop, 22 tools),
lint, types, dependency/comment gates and build. Thirteen combined P1/P2 unit
tests passed. The test-build `print|export` run passed nine suites and 605/605
checks on three lanes, including 23/23 in suite 382 and 60/60 in suite 383.
Free RAM exceeded 4 GB before every browser run. The list inspector passed
112/112 checks; the unchanged P1 cases passed 18/18 with 1/2/7 pages.

| P2 fixture | Rich pages | Empty pages | Long pages |
| --- | ---: | ---: | ---: |
| Prop packing | 1 | 1 | 6 |
| Gear packing | 1 | 1 | 4 |
| Standalone shot list | 1 | 1 | 11 |
| Script with breakdown, shots and comments | 4 | 1 | 22 |

Each filtered/grouped fixture (flagged/location, shot/person, unshot/scene)
printed one page. Raster review of all 57 P2 fixture pages confirmed wrapping,
repeating table heads, status/checkbox marks, signatures, notes space, page
footers and portrait/landscape transitions without clipping. PDF text extraction
retained packing note line 99, shot description line 109, final notes 64 and
the final comment reply.

Initial P1 validation on Windows Edge: six content tests passed; `npm run verify`
passed all 567 discovered files (194 frontend, 11 source, 317 tests, 23 desktop,
22 tools). The test-build `print|export` run passed eight suites and 543/543
checks on three lanes, including 21/21 in suite 382. Print-media inspection
passed 18/18 checks: empty one page, rich two pages, long seven pages. All ten
printed pages were rasterized for review; repeated table heads, continuation
content, images, footers, comments and system-font non-Latin text were
inspected. Extracted PDF text retained `Visual line 179`, `Audio line 159`,
scene 18 and the final reply. The original PDF/export tests remain unchanged.

Review follow-up validation: six content tests passed with exact YouTube host
label/address and local-file text assertions. Suite 382 passed 23/23 checks
using the ignored `_script-print-*.html` fixtures; print-media inspection
passed 18/18 checks with the same one/two/seven-page counts. `git check-ignore`
confirmed all three generated pages match the root `_*.html` rule.
