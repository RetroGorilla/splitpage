# Captured HTML print layout

AQ-40 implements roadmap C6 P1. **Not wired; no user-visible change.** The
registered PDF exporter still calls `buildPdf`; that generator and its tests
remain unchanged until P5. These modules do not open a window, print, register
an exporter, resolve assets, or read a session or preference.

## Existing PDF content inventory

| Output in `buildPdf` | Captured input and existing projection | P1 destination |
| --- | --- | --- |
| Title, scene count, runtime, target/delta, shot count, calendar date | `ExportDocument`, `exportFacts`, `exportSummaryParts` | Script heading and facts line |
| Rundown and status legend | `sceneFacts` durations/statuses, `exportFacts` status counts and target | Proportional scene strip, status counts, target in facts line |
| Scene number, start, status, read time and explicit-duration border | `sceneFacts` | Scene and Read columns |
| Visual/audio words, bold, italic, underline, strike, highlight, links | Captured scene HTML decoded by `ExportServices`, `exportRuns` | Escaped semantic HTML in fixed-width columns |
| Tags, B-roll keys, stage directions, audio cues, thread anchors/numbers | `exportRuns`, captured `commentNumbers`, print palette | Category underline, chip, brackets, cue styling and numbered markers |
| Main and gallery pictures; video references | Captured row/gallery refs, legacy data URLs, held `ExportAssets`, `rowVideoLinks` | Embedded raster data URLs and safe text links; unavailable images get an explicit placeholder |
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

AQ-41 can compose `[script, ...listSections, ...comments]` through this shell,
or pass only list sections for a standalone document. The shell already
provides fixed-layout tables, repeating headers, section page breaks, image
bounds and wrapping. A later list renderer can add its own scoped layout
rules within its renderer-owned section. No list fact calculation belongs in
the shell. P1 makes no production wiring change.

## Print behavior and deliberate differences

The page uses Letter paper with 0.6-inch margins, the light print palette and
the computer's system fonts. It bundles no fonts and fetches no font, image,
stylesheet or script. A restrictive CSP permits only inline CSS and raster
data images. Links preserve safe HTTP(S)/mailto destinations without fetching
them during rendering. There is no printable-document script.

Chromium decides page breaks and repeats table headers. Oversized scene rows
can span pages without a hand-drawn pagination algorithm or a `cont.` label.
Long words wrap within their column; text and scene content are not clipped.
Pictures retain their aspect ratio within column and page-height bounds.
Gallery pictures flow vertically rather than the old three-thumbnail strip,
so each remains legible. The rundown target remains in the facts line instead
of a hand-positioned vertical rule. Footer titles can ellipsize; the full title
remains in the heading and document title.

Bookmarks are desktop-only work for P3. Browser users will choose “Save as
PDF” from their print dialog in P4. P1 creates neither a desktop print window
nor a browser print dialog. The old writer stays until P5 and the PC PDF check.

## Fixtures and validation

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
```

The suite runner's `--port-base` is an offset: HTTP starts at `18100 + offset`,
and CDP at `19300 + offset`. The standalone inspector uses CDP port 15780 by
default (`PRINT_CDP_PORT` overrides it) and `SPLITPAGE_CHROME` or Windows Edge.
Check free RAM before each browser run; keep at least 4 GB available.

The fixture suite has its own suite directory; normal app suites need no
generated fixtures. Suite `382-script-print.txt` checks the rich, long and empty pages,
loaded pictures, complete scene tails, wrapping and horizontal bounds. The
standalone inspector enables actual print media, tests those bounds at the
printable width, and saves tagged Chromium PDFs, screenshots and `summary.txt`.
Generated `.generated-script-print-*.html` files beside the fixture generator
are temporary test artifacts: remove them after the run, never commit them.
They are not built into the release app. No desktop smoke or editing/undo
performance run is needed for this unwired adapter.

P1 validation on Windows Edge: six content tests passed; `npm run verify`
passed all 567 discovered files (194 frontend, 11 source, 317 tests, 23 desktop,
22 tools). The test-build `print|export` run passed eight suites and 543/543
checks on three lanes, including 21/21 in suite 382. Print-media inspection
passed 18/18 checks: empty one page, rich two pages, long seven pages. All ten
printed pages were rasterized for review; repeated table heads, continuation
content, images, footers, comments and system-font non-Latin text were
inspected. Extracted PDF text retained `Visual line 179`, `Audio line 159`,
scene 18 and the final reply. The original PDF/export tests remain unchanged.
