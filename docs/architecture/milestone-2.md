# Milestone 2: pure policies and document/text/merge operations

This is the working plan for milestone 2 of [the implementation plan](../IMPLEMENTATION-PLAN.md#2--extract-pure-policies-and-documenttextmerge-operations). It was derived from the source at `4.0-development` d18adde, and it names functions rather than lines; the two line numbers it does cite are at that commit.

## What moves, and what cannot yet

Three kinds of function:

- Pure: no DOM, no `S`, no time, IDs or platform.
- Pure apart from an injectable dependency: a parser, the clock, ID minting, the blob registry.
- Tied to the DOM, `S` or effects.

| Module | Moves to core (pure, or behind a port) | Stays legacy for now |
| --- | --- | --- |
| `02-state.js` | `escapeHtml`, `legacyMdToHtml`, `mediaCommentId`, `missingStateFields`, `STATE_FIELDS` (without callbacks), `migrateRows` (with ports) | `defaultState`, `loadInitialState` (moves to `02b-doc-id.js`), `buildPublishHtml` |
| `02b-doc-id.js` | `sha256Bytes`/`sha256Hex` (manual UTF-8; `TextEncoder` is banned in core), `deriveDocId`, `docIdEmbeddedIn`, `mergedDocId`, `withPageHead`, `migrateDocument` (core root) | `mintDocId`/`randomHexBytes` go to `adapters/identity`; BroadcastChannel, history copy and identity sync stay |
| `02c-blobs.js` | base64 helpers, `rowImage*`, the pure data-URL decode | The registry and persistence (an M4 store adapter) |
| `02d-gallery.js` | normalisers, slot read models and operations, merge helpers | Interning in `migrateGallery`/`normalizeGalleryItem` becomes a port call |
| `03-sync.js` | `cloneState`, row and field equality, every `merge*` list/scalar merger, `mergeTextField`, `mergeStates` (core root) | Snapshots, stash, history panel, `applyMerge`, `stampRow` (clock and editor) |
| `04-richtext.js` | `safeImageSrc`, `safeHref`, `plainText`, `plainName`, `safeId`, `storedImageHtml` (as a string) | `inertBody`, `sanitizeHtml`, `storedHtmlFromDom`, `htmlToMarkdown`, `buildVideoCardEl` go to `adapters/richtext` |
| `04c-doc-model.js` | Everything except decoding: runs, `toHtml` (a pure encoder), projections, edits, cues, steps, `mergeCells`, anchors | `fromHtml`/`cellOf` decode through the rich-text adapter |
| `07-production-tags.js` | Status/category ids and ranks, `normalizeTagName`, registry keys, tag ids, `contentMemo`, the readers, `collectTagsFromRows`, `missingRegistryTags`, `tagOccurrences`, the healing and quick-add *plans* | Presentation (labels, colours, icons), the `S` mutators, DOM retagging of cells that hold media, the idle refresh |
| `08c-broll.js` | To `core/document/broll.ts`: status ids, limits, the marker regex and the prop policy (`normalizeBrollProps`, `brollPropKey`). To `core/production/broll.ts`, because they need core/text: the cell line readers (they call `tagNameOf`), the anchor edits (`insertBrollKey`, `deleteRange`) and the `brollEntries` read model returning a plan | Capture, record writes (apply the plan), badges, the DOM path for media cells |
| `01-scene-status.js`, `00p-prefs.js` | Scene-length and target-length normalisers, person colours | Rendering |

What `fromHtml` and `toHtml` actually need:
- `fromHtml` needs a parser twice: it sanitises, then parses again. It also needs the sanitiser's images, IDs and tag categories. So decoding and sanitising move to the adapter.
- `toHtml` needs only `normalizeCell`, the default `tagOf` and escaping, so it stays in core as a projection.

Persisted content stays HTML. Core functions that decode today receive the decoder through a port.

## Target layout

`tools/dep-report.mjs`'s `CORE_DEPENDENCIES` sets the order: `document` ← `text` ← `merge`/`production`, and core/merge may not import core/production. `migrateRows` needs text, production and the sanitiser, and `mergeStates` ends by calling it. So both are composed at the core root, which may import every core folder.

- `src/core/document/`: `ports.ts`, `text-policy.ts`, `ids.ts`, `tags.ts`, `broll.ts`, `timing.ts`, `person-colors.ts`, `media.ts`, `gallery.ts`, `memo.ts`, `fields.ts`, `comments.ts`. Its `broll.ts` holds only what needs nothing from core/text: status ids, limits, the marker regex and the prop policy.
- `src/core/text/`: `runs.ts`, `edits.ts`, `directions.ts`, `cues.ts`, `tree.ts`, `html.ts` (`toHtml`), `projections.ts`, `steps.ts`, `anchors.ts`, `ports.ts` (`CellDecoder`).
- `src/core/merge/`: `cells.ts`, `text-field.ts`, `lists.ts`, `rows.ts`, `gallery.ts`, `scalars.ts`, `states.ts` (`mergeStateFields`).
- `src/core/production/`: `readers.ts`, `tags.ts`, `broll.ts`, `timing.ts`. Its `broll.ts` takes the parts of 08c that depend on core/text: the cell line readers, the anchor edits and the `brollEntries` plan.
- `src/core/migrate.ts` and `src/core/merge-states.ts` (core root).
- `src/adapters/richtext/`: `createRichText({ DOMParser, images, ids })`. It builds nodes through `body.ownerDocument`, never the global `document`.
- `src/adapters/identity/ids.ts`: `makeId`, `randomHexBytes`, `mintDocId`, `nowIso`.
- `src/legacy/richtext.ts` and `src/legacy/document-ports.ts`: the adapter composed with `02c-blobs.js`, interning then queueing persistence in today's order.

**Ports.**
- `IdSource { id(prefix), docId() }`.
- `ImageSource { known(sha), fromDataUrl(url) }`.
- `Clock { nowIso() }`.
- `CellDecoder`.

**Image ingestion is an explicit effect.** Core decodes data URLs purely. `createImageIngestion` records what is pending, and its `known()` checks the pending set first. A legacy conflict card's picture is found later in the same pass today, and this keeps that. The caller then interns the pending bytes and queues persistence.

**Ingestion order that lane 2.5 must keep.** In `migrateRows`, a comment's `c.body = sanitizeHtml(c.body)` (02-state.js line 213) runs before the image conflict card looks its picture up with `recordFor` (line 221). Sanitising interns the body's data-URL picture, so the lookup finds it in the same pass, even in a fresh process with an empty registry. `core/migrate.ts` must decode and record a comment body's pictures before it resolves that comment's `imageValue`, and resolve it through `known()`, which sees the pending set.

**One field policy source.** Each `STATE_FIELDS` entry is `{ key, def?, normalize?, merge: StrategyId, undo: boolean }`, with no callbacks into UI modules. Merge strategies come from a table typed `Record<StrategyId, …>`, so a field with no strategy is a compile error. `12a-undo.js`'s skip list is derived from `undo`. A test adds a field and checks that it survives `migrateRows`, `mergeStates` and a `.splitpage` round trip without any other edit (INV-04).

## Mechanics

- **Shims keep callers unchanged.** The legacy modules re-export from core and the adapters, or wrap them with legacy ports. Only three callers change:
  - `21-events.js` imports `loadInitialState` from `02b-doc-id.js`;
  - `08-production-panels.js` applies the quick-add plan;
  - `02-state.js` keeps `STATE_FIELDS` with each `mergeList` reattached from the core table, so `12a-undo.js` and `state-fields.test.mjs` don't change.
- **Bundling.** esbuild bundles `.ts` imported from `src/js` with an explicit `.ts` extension, as `_entry.js` already does for `src/legacy/*.ts`. Node 22.22+ strips types natively, so `src/test/*.test.mjs` keep testing through the shims.
- **New tests.** They go in `tests/core/<area>/`, `tests/core/` for the root files, and `tests/adapters/<area>/`, as the per-area rule requires.
  - Core tests never load `src/test/_dom.mjs`. They decode through maps built with `toHtml`, or through the adapter with an injected parser.
  - `tests/core/environment.test.ts` imports every script under `src/core`, whatever its extension, checks that loading them adds no globals, and runs core's policies in a process that loads no DOM. Keeping platform globals, the clock and `Math.random` out of core is the dependency gate's job.
- **Shared policies.** `shared/*.js` stay CommonJS and remain the single source. Confirm that `tsc` with NodeNext accepts named imports from them before relying on it.
- **Lint.** Core files with control-character regexes get a file-scoped rule in `eslint.config.mjs`; no inline disables.
- **Dependency baseline.**
  - Expected: 594 → about 433 cycle edges, plus 02-state's `S` import and its `docIdWrittenOut` write.
  - One accepted new edge, `02b-doc-id.js → 20b-onboarding.js`, from moving `loadInitialState`, with its reason.
- **Sequencing trap.** `02c-blobs.js` must stop importing `04-richtext.js` and `02b-doc-id.js` before `src/legacy/richtext.ts` imports `02c-blobs.js`. Otherwise there is a cycle through a migrated folder, which the gate refuses outright.

## PRs, in order

| PR | Content | Depends on | Runs in parallel with |
| --- | --- | --- | --- |
| 2.0 | Characterisation tests and golden fixtures (no source change) | — | — |
| 2.1a | `core/document` part 1 (`ports`, `text-policy`, `ids`, `tags`, `broll`, `memo`) and `adapters/identity`; shims in 04, 02c, 02b, 07, 08c. Takes 02c, 02d, 04 and 04c out of the cycle | 2.0 | — |
| 2.1b | `core/document` part 2 (`fields`, `timing`, `person-colors`, `media`, `gallery`, `comments`) | 2.1a | 2.2 |
| 2.2 | `core/text` and `core/merge/cells.ts` | 2.1a | 2.1b |
| 2.3 | `core/merge` (all but `cells.ts`) | 2.2 | 2.4, 2.6 |
| 2.4 | `adapters/richtext` and `legacy/richtext.ts` | 2.2 | 2.3, 2.6 |
| 2.6 | `core/production` | 2.2 | 2.3, 2.4 |
| 2.5 | `core/migrate.ts`, `core/merge-states.ts`, `legacy/document-ports.ts`; 02-state becomes a shim | 2.3, 2.4, 2.6 | — |
| 2.7 | Docs, invariant rows, metrics, performance record, and the full Linux and Windows regression (the milestone gate) | 2.5 | — |

Each PR names its impacted browser suites and runs them along with `npm run verify`. Lanes run `--prune` after merging the base.

## 2.1a as built

- **`src/core/document/`.**
  - `ports.ts`: `ImageRef`, `IdSource`, `ImageSource`, `Clock`.
  - `text-policy.ts`: `safeImageSrc`, `safeHref`, `plainText`, `plainName`, `safeId(id, prefix, ids)` and `storedImageHtml`, which builds the tag as a string.
  - `ids.ts`: `utf8Bytes`, `sha256Bytes`, `sha256Hex`, `deriveDocId`, `docIdEmbeddedIn`, `mergedDocId`.
  - `tags.ts`: the category and status ids, `tagCategoryId`, `tagStatusId`, `tagStatusRank`, `nextTagStatus`, `normalizeTagName`, `tagKey`, `registryKey`, `isTagId`, `mintTagId`, `ensureTagIds` and `registryTagHooks` (pure, and core/merge needs it).
  - `broll.ts`: the status ids, `brollStatusId`, `BROLL_MARKER_RE`, `BROLL_CLOSERS`, the limits, `normalizeBrollProps`, `brollPropKey`.
  - `memo.ts`: `contentMemo`.
- **`src/adapters/identity/ids.ts`.** `makeId`, `randomHexBytes`, `mintDocId`, `nowIso`, and `randomIds` and `systemClock`, which implement `IdSource` and `Clock`.
- **Shims.**
  - `04-richtext.js`, `02b-doc-id.js`, `07-production-tags.js` and `08c-broll.js` re-export what moved. `04-richtext.js`'s `safeId` passes `randomIds`.
  - `02c-blobs.js`, `04-richtext.js` and `04c-doc-model.js` import from core and the adapter instead of from modules in the cycle. That takes 02c, 02d, 04 and 04c out of it: 60 modules become 56, and 102 `cycle-edge` entries were pruned, none added.
  - `07` builds `TAG_CATEGORIES` and `TAG_STATUSES`, and `08c` builds `BROLL_STATUSES`, from the core ids; their labels, colours and icons are keyed by id.
  - `02-state.js`'s `makeId` and `10-comments.js`'s `nowIso` re-export the adapter's, so each has one implementation.
- **Control characters.** `safeHref` strips C0 controls and the space before it looks for a scheme, because a browser resolves `java\0script:` as `javascript:`. `plainText` drops the C0 controls other than tab, line feed and carriage return, which a plain-text field must not carry. So `eslint.config.mjs` turns `no-control-regex` off for `src/core/document/text-policy.ts` alone.
- **Hashing.** The app's `sha256Hex` is now core's, which always encodes UTF-8 by hand; `sha256-utf8.test.mjs` shows its bytes are `TextEncoder`'s.
- **Left for 2.1b.**
  - `withPageHead`: it needs `escapeHtml`, which stays in `02-state.js` until that module's pure parts move, and no file in the layout names it.
  - `mediaCommentId`.
  - 02c's base64 helpers, `rowImage*` and the data-URL decode, which go to `media.ts`.

## 2.1b as built

- **`src/core/document/`, new files.**
  - `fields.ts`: `SCHEMA_VERSION`; `STRATEGY_IDS` and the `StrategyId` type; `STATE_FIELDS` as data, each `{ key, def?, normalize?, merge, undo }`; `ROW_FIELDS`, `GALLERY_FIELDS`; `missingStateFields(state, fields)`, which checks the table it is given, core's by default. The tables and the table's entries are frozen at run time.
  - `timing.ts`: the row status ids, `rowStatusId`, `nextRowStatus`, `DEFAULT_WPM`, `SCENE_LENGTH_MAX`, `hasSetLength`, `normalizeSceneLength`, `parseSceneLength`, `normalizeTargetLength`, `targetLengthOf`.
  - `person-colors.ts`: the palette, `paletteColor`, `personKey`, `normalizePersonColors` with its `__proto__`/`constructor`/`prototype` guard, `lookupByName`, `mergePersonColors`.
  - `media.ts`: the base64 helpers; `imageRecordOf` (sniffed type, size and hash of some bytes), `imageDataUrlBytes` and `decodeImageDataUrl`; `createImageIngestion`; `rowImage`, `rowImageKey`, `rowImageShas`; `mediaComments`, which is `moveMediaOutOfCell` after decoding.
  - `gallery.ts`: the normalisers, slot read models and slot operations, `mergeGalleryField` and `galleryFieldKey`. `migrateGallery(row, images)` takes an `ImageSource`.
  - `comments.ts`: the filter predicates, `compareCommentPositions(a, b, rowIndex)` and `commentRecentOrder`.
- **Additions.** `text-policy.ts` gains `escapeHtml` and `legacyMdToHtml`; `ids.ts` gains `mediaCommentId` and `withPageHead`.
- **Shims.**
  - `02-state.js` re-exports `escapeHtml`, `legacyMdToHtml` and `mediaCommentId`. Its `STATE_FIELDS` is core's table copied entry by entry into a writable array, with `mergeList` attached for `people`, `productionTags` and `brollShots` exactly as before, so `12a-undo.js`, `03-sync.js` and `state-fields.test.mjs` are unchanged. The entries also carry `undo`. Its `missingStateFields` passes that same array to core's, so a field added to it is filled in by `migrateRows` and reported missing alike, as when everything read one array.
  - `01-scene-status.js` and `00p-prefs.js` re-export what moved. `ROW_STATUSES` is built from the core ids, with labels, classes and colours keyed by id, as 2.1a did for tags.
  - `02c-blobs.js` re-exports the `rowImage*` helpers and interns through `imageRecordOf` and `imageDataUrlBytes`. It exports `registryImages`, the legacy `ImageSource`: `known` is `recordFor`, and `fromDataUrl` interns, then queues persistence.
  - `02d-gallery.js` re-exports the gallery and passes `registryImages` to `migrateGallery`. `pictureBytes`, `videoLinkText` and `videoLinkLabel` stay: the first reads the registry, the others are display text.
  - `02-state.js`'s `moveMediaOutOfCell` still decodes and re-encodes the cell, then calls `mediaComments` with `registryImages` and a function that returns the video card's HTML, which needs the DOM until 2.4.
  - `02b-doc-id.js` re-exports `withPageHead`, and `00-prelude.js` re-exports `SCHEMA_VERSION`.
  - `10-comments.js` uses the core predicates and orders. `commentPositionCompare` is still a function declaration, so it stays hoisted; it passes `findRowIndex` to `compareCommentPositions`.
- **`undo`.** `undo: true` means an edit to the field is recorded as a `docField` step. `rows` is `false`: an edit to a scene is recorded row by row, not as a document field. So the keys with `undo: false` are exactly `SKIP_DOC_KEYS` in `12a-undo.js`. `tests/core/document/fields.test.ts` checks the flags against the undo golden. 2.3 derives the skip list.
- **`normalize`.** The type has it, but no entry sets it yet. `migrateRows` normalises each field differently: `personColors` is removed when the normaliser returns `null`, `targetSeconds` when it returns `undefined`, and `wordsPerMinute` falls back to the default. 2.5 decides the contract when it composes the migration.
- **Image ingestion.** `createImageIngestion(known)` decodes data URLs purely. `pending()` lists every picture decoded in the pass once, in the order first met, including those the registry already holds, because the legacy path queues persistence for each of them. `known()` checks the pending set before the registry. Like `fromDataUrl` and `known`, `pending()` hands out copies of the references and bytes, so a caller cannot change what ingestion holds. Nothing calls it yet; 2.5 wires it.
- **Copies until 2.3.** `03-sync.js` keeps its own `ROW_FIELDS` and `GALLERY_FIELDS`, and `12a-undo.js` its own `SKIP_DOC_KEYS`, until 2.3 imports core's. `src/test/state-field-tables.test.mjs` fails if they drift: it compares the first two through `03-sync.js`'s exports, and reads the skip list through `changedBetween`.
- **Comments.** `commentMatchesAssigneeFilter` takes the saved author name as a function, so it is still read only for the "me" filter. The filter modes and their stored preference stay in `10-comments.js`.
- **Control characters.** `eslint.config.mjs` also turns `no-control-regex` off for `gallery.ts`, `media.ts` and `person-colors.ts`. Five inline disables left the comment baseline with the code they covered.
- **Dependency baseline.** No entry was added or removed. Frontend modules went from 100 to 106 and migrated modules from 23 to 29. The cycle stayed at 56 modules and 492 edges, `S` importers at 57 and `S` writers at 34: every shim this step owns still imports other modules in the cycle.
- **Left for later.** 33 imports in `src/js` name only functions that now live in core or the identity adapter, mostly `escapeHtml` and `makeId` from `02-state.js`. Pointed there instead, in a scratch copy, they removed 31 cycle edges (492 to 461) and took `03c-history-idb.js` out of the cycle (56 to 55 modules). They are spread over 31 modules, including `03-sync.js`, `07-production-tags.js` and `08c-broll.js`, which other lanes own, so this step leaves them for a later one.

## 2.2 as built

- **`src/core/text/`.** Imports run one way. `edits` imports `runs`; `directions` and `cues` import both; `tree` imports `runs`, and `html` imports `tree`; `projections` imports `runs`, `cues` and `tree`. `steps.ts` imports nothing. `ports.ts` imports types from `runs.ts`, and `anchors.ts` imports `commentIds` from `runs.ts` and the `CellDecoder` type from `ports.ts`.
  - `runs.ts`: the run and mark types, `normalizeCell` with `cleanText`, `cleanMarks` and `settleCues`, `CUE_LINE_RE`, the default tag ids (`tagNameOf`, `namedTagId`), `projection`, `cellLength`, `commentIds`, `tagIds` and `sameCell`.
  - `edits.ts`: the character model (`explode`, `implode`, `clamp`) and every edit, `typingMarks` and `insideDirection` among them.
  - `directions.ts`: `DIRECTION_MAX`, and the direction range, toggle, `((…))` shortcut, import and flatten.
  - `cues.ts`: `cueLines`, `cuesInCell`, `withoutCues`, and the cue shortcut, import, edit and flatten.
  - `tree.ts`: the element tree that `toHtml` and `toDocxRuns` both walk. `html.ts`: `toHtml`.
  - `projections.ts`: `toPlainText`, `spokenText`, `OMIT_CLOSES`, `toMarkdown` and `toDocxRuns`.
  - `steps.ts`: `applySteps`, `invertSteps` and `touchedCells`.
  - `anchors.ts`: `syncCommentAnchors(state, cellOf)`. `ports.ts`: `CellDecoder`, and `DecodeOptions` with the media `fromHtml` reports.
- **`src/core/merge/cells.ts`.** `mergeCells` and `mergeMarks`, over `explode` and `implode` from core/text.
- **Where the split differs from the plan's order.** `normalizeCell` ends with `settleCues`, so `CUE_LINE_RE` and the cue-run test live in `runs.ts`. `typingMarks`, which `insertText`, `replaceText` and `breakLine` call, needs `insideDirection`, so that stays in `edits.ts`. `projection` and `cellLength` are in `runs.ts` because every position is clamped to them.
- **Shim.** `04c-doc-model.js` re-exports the 52 names that moved and keeps `fromHtml`, `cellOf` and `syncCommentAnchors(state)`, which hands `cellOf` to core. Its 56 exports are the same names as before, so none of the 25 importers changed. It takes `normalizeCell` and the default tag id from core and no longer imports `safeHref`; core reads it from `text-policy.ts`.
- **Translation.** `var` became `let` and `const` as in 2.1a. A `delete` through a computed key is `Reflect.deleteProperty`, because typescript-eslint's strict rules refuse a dynamic `delete`, and `push.apply` is a spread. The source keeps 04c's escapes, and its two literal U+FFFC characters in the direction patterns.
- **Lint.** `eslint.config.mjs` turns `no-control-regex` off for `src/core/text/runs.ts` alone, for `cleanText`. 04c's inline disable went with the function, so the comment baseline loses that entry.
- **Dependencies.** No baseline change: 04c had already left the cycle in 2.1a, and `--prune` found nothing. `--metrics` counts 11 more frontend modules (100 to 111) and 11 more migrated ones (23 to 34); the cycle (56 modules, 492 edges) and every `S` figure are unchanged.
- **Invariants.** INV-02 names `src/core/text/edits.ts` as where the edits live, and INV-18 puts `syncCommentAnchors` in `src/core/text`, not `src/core/document`.
- **Tests.** `tests/core/text/` and `tests/core/merge/` run without a DOM. They build cells from runs, and `anchors.test.ts` decodes through a map from `toHtml` output to cells. They cover b-roll keys and tags as units, comments over keys, Unicode (astral characters, combining marks, ZWJ sequences, U+FFFC never entering text), step inversion over seeded random edits, `mergeCells` and `mergeMarks`, and the cue and direction edges.
- **Review follow-ups.** Core tests now pin the Markdown rule of three and its exception for two runs that are both multiples of three, NBSP in the gap a left-out direction leaves, that `applySteps` and `invertSteps` copy every value they take from a step, `replaceText` keeping the first replaced character's marks, and a blank line dropping Markdown marks. `FORMAT_MARKS`, which `cleanMarks`, the tree and the merge all read, is frozen.
- **Found, not fixed.**
  - Positions count UTF-16 code units, so an edit inside a surrogate pair splits it.
  - `applySteps` compares rows as JSON, so key order counts. An inverse step that restores a removed row field puts it last, and the inverse `deleteRow` of that row is then refused. A test pins this, so a fix shows up as a deliberate change. `12a-undo.js` uses `applySteps` only to move its base forward, and falls back to a copy of the state.
  - A cue line split before its colon leaves neither half reading as a cue, so both lose the mark, and joining them does not bring it back. Split after the colon, the left half keeps the cue and a join restores it on the whole line.
- **Left for 2.7.** `09-find-replace.js` keeps a baselined lint comment saying `cleanText()` lives in `04c-doc-model.js`. It is now in `src/core/text/runs.ts`, but the comment gate allows no new comment text, so the pointer changes when that comment's rule moves to configuration.

## 2.6 as built

- **`src/core/production/`.** Imports run one way: `ports.ts` holds types only; `tags.ts` imports it; `broll.ts` imports `tags.ts`; `readers.ts` imports `broll.ts`; `timing.ts` imports `ports.ts`. Outside the folder they import core/document and core/text only.
  - `ports.ts`: `ProductionReaders` (the decoder and the memoised field readers), `FieldTag`, `BrollItem`, `FieldText` (a field's plain text) and `ProductionRow`. It exists because `broll.ts` needs the readers' type and `readers.ts` needs `brollInCell`, and a type-only cycle through core fails the gate.
  - `readers.ts`: `createProductionReaders(cellOf)` returns `cellOf` itself and `tagsInField`, `cueNamesInField`, `brollInField`, `brollPropsInField` and `wordCount`. Each is a `contentMemo`, so each keeps the two-million-character budget, and each decodes through the injected `cellOf`.
  - `tags.ts`: `TAG_FIELDS`; the registry lookups `registryIndex`, `registryEntry` and `newRegistryTag`; `collectTagsFromRows` (groups carry `catId`) and `missingRegistryTags`; the index (`deriveProductionIndex`, `productionIndexFresh`, `registrySignature`); `snapshotCues`, `planRegistryHealing` and `planQuickAdd`; `tagOccurrences`, `holdsMedia`, `tagFieldOccurrences`, `bulkTagCell` and `retagCell`.
  - `broll.ts`: the cell line readers (`brollCellLines`, `brollInCell`, `brollPropsInCell`, `brollMarkerLines`), `collectBrollFromRows`, the seeds (`brollSeedRef`, `brollSeedLocation`), the read model `brollEntries`, `brollLineKey`, `planBrollAnchors`, the anchor edits (`brollAnchorTodo`, `anchorBrollCell`), `brollPropsRenamed` and `brollSortedForList`.
  - `timing.ts`: `pad2`, `estimatedSeconds`, `rowSeconds`, `totalSeconds`, `formatDuration`, `formatTimecode` and `targetClock`. The last three are pure and sat beside the others in `01-scene-status.js`, so they moved too.
- **The plans, and how the legacy code applies them.** Every plan reads the state it is given and writes nothing; the shim applies it to `S.state` with the writes the legacy code made.
  - **Healing.** `planRegistryHealing(state, readers, cues?, index?)` returns `{ cues, count, retitle: [{ at, from, name }], register }`. It works on a copy of the registry: retitles first, as `retitleEditedCues` did, then each unregistered tag through `newRegistryTag`, which mints against the registry as it stands at that point, so the ids and their order are the legacy ones. `healTagRegistry` keeps the cue snapshot, renames by index, pushes the records, patches the cached entries' ids, refreshes the tag signature and drops the cache after a retitle, as before.
  - **B-roll.** `brollEntries(state, readers, ids, plainTextOf)` returns `{ entries, plan: { create: [{ entry, shot }], rename: [{ at, name, desc }] } }`. The entry of a line with no shot holds the seed `brollEntries(true)` always showed; `create` holds the shot `newBrollRecord` would have stored, in its key order. `brollEntries()` and `brollEntries(false)` push the created shots, point their entries at them and rename by index; `brollEntries(true)` applies nothing. `rename` lists only shots whose name or description changes; the legacy code wrote both fields of every matched shot, the same values for the others.
  - **Anchoring.** `planBrollAnchors(state, readers, ids)` is the legacy id map (`rowId` and ordinal to an id), minting in the same order. `anchorBrollInRows` keeps the declined rows and the row loop, and for each row takes `brollAnchorTodo`, then either the DOM path (a cell holding media) or `anchorBrollCell`.
  - **Props rename.** `brollPropsRenamed(state, fromId, oldName, toId, toName)` returns `[{ at, props }]`, each list normalised against the registry; `08c-broll.js` assigns them. The legacy code renamed the prop objects in place before normalising, which builds new objects anyway, so the stored props are the same.
  - **Quick add.** `planQuickAdd(state, readers, raw, index?)` returns `{ remove, register, added, removed }`. It keeps the plain-object `wanted` map: a line whose key is `constructor` or `__proto__` is skipped, and an entry under such a key is kept, as the golden pins. `applyGearQuickAdd` deletes each name through `deleteProductionTagEntry` and pushes the records through the new `addRegistryTags` in `07-production-tags.js`, so `08-production-panels.js` still writes no member of `S` itself.
- **Shims.**
  - `07-production-tags.js` builds the one `productionReaders` from `04c`'s `cellOf`. `tagsInField`, the b-roll readers in `08c-broll.js` and `01-scene-status.js`'s `wordCount` are its memos, so each memo still exists once.
  - `collectTagsFromRows` maps each group's `catId` back to the category object for `02-state.js` and `05g-scene-clip.js`. The index cache holds core's index and the entries presented with the category object, in the legacy key order; `productionEntries()` is unchanged. `registryEntry` and `registerProductionTag` delegate to core.
  - `01-scene-status.js` re-exports `formatDuration`, `formatTimecode` and `targetClock`, and passes `S.state` and the readers to the read-time functions. `05-render.js` re-exports `pad2`.
  - Every export of `07`, `08c`, `01` and `05` keeps its name. `07` adds `productionReaders`, `currentProductionIndex` (the cached index, for the quick-add plan) and `addRegistryTags`.
- **Legacy behind a bridge.**
  - Cells holding media: `bulkTagCell` and `tagFieldOccurrences` take a `MediaTagWriter` as their last argument, and `07` passes `wrapTagInHtml` (inert body, `domRangeFor`, sanitiser). `retagCell` covers cells without media; `eachTaggedField` still sends a cell holding media to `retagInHtml`. Anchoring and `renameBrollInScript` keep their DOM paths for such cells.
  - A shot's seed reference is the scene's audio through `14-export.js`'s `htmlToPlainText`, passed in as `FieldText`.
  - Capture (`maybeCaptureBroll`), pasted shots (`recordPastedBroll`), `newBrollRecord`, the `S` mutators, labels, colours and icons, `tagsByCategory` and the idle refresh stay in `07` and `08c`.
- **Found, not changed.**
  - #282: cue retitling pairs the names that went and came by position in the cell. A core test pins it.
  - Reads that repair: the b-roll badge counts through `brollEntries()` with no argument, so drawing it creates and renames shots; `14-export.js`'s `settleDerivedRecords` heals and repairs before a save. Both apply the plans exactly as before.
  - The repair path no longer draws the id `newBrollRecord` minted and then overwrote. No stored id comes from that draw, and the masked goldens cannot see it.
  - A b-roll key carrying a comment reads as a typed marker with no id, and anchoring replaces it with a fresh key that drops the comment. A core test pins it.
- **Tests.** `tests/core/production/` runs without a DOM. `readers`, `tags`, `broll` and `timing` build cells with core/text and decode through a map from `toHtml` output, as `anchors.test.ts` does. They cover the plan contents for healing, b-roll creation and renaming, anchoring and quick add; INV-26 (the quick-add plan deletes an orphaned entry and keeps one still tagged); INV-54 (a repeated key gets its own id, a typed line never takes a shot a keyed line further down holds); INV-56 (props on a shot's lines are read, hand-added ones kept by registry id, a rename planned by id and by name, a created shot stores none). `golden.test.ts` reads the long demo and the crafted documents with a small stored-HTML reader that checks every cell against `toHtml`, the three cells `heal-crafted` writes raw aside; it applies each plan as the shims do and compares the result with the `production` fixtures for the long demo (as shipped, registry emptied, shots dropped), `broll-crafted`, `heal-crafted`, `cue-retitle` and `gear-quick-add`. Two deliberate faults in the plans each failed both these tests and the legacy golden.
- **Dependencies.** No baseline change: `--prune` found nothing and no entry was accepted. `--metrics`: frontend modules 117 to 122, migrated modules 40 to 45; the cycle (56 modules, 492 edges), `S` importers (57), `S.state` assigners (9) and `S` writers (34) are unchanged. `07` and `08c` stay in the cycle: they still import `S`, `03-sync.js`, `05-render.js`, `05b-cell-edit.js` and the panels for their mutators and DOM work, and `08c` still imports `14-export.js` for `htmlToPlainText`.

## Characterisation (2.0)

Fixtures are generated once from the current code and committed. Tests compare against the committed files and never regenerate them; a separate, documented command does that, and `npm test` refuses to run while `GOLDEN_UPDATE` is set. Goldens are regenerated only on `4.0-development`, in a dedicated commit that changes nothing else, never inside a lane that moves code: a moving lane keeps every golden passing unchanged.

- **`richtext-golden`:** `sanitizeHtml`, `fromHtml`, `toHtml(fromHtml)`, `htmlToMarkdown`, `storedHtmlFromDom` and video-card HTML, over a corpus:
  - pasted HTML: style spans, `b` with normal weight, empty blocks;
  - invalid tag categories and b-roll markers;
  - `cmt-anchor` spans with no id (minted ids are masked);
  - images: png/jpeg/gif/webp/svg data URLs, bad base64, and known/unknown/bad `data-blob`;
  - `javascript:` and `data:` links;
  - astral characters, NBSP, U+FFFC, U+200B, CRLF.
- **`migrate-golden`:** run in a fresh process, so the registry starts empty.
  - Inputs: schema-1 documents; inline images in cells, comments, replies, conflict cards, `visualImage`, gallery items and annotations; video cards in cells; a schema 2 document with tag anchors and no `productionTags` key, whose derived entries pin the `hadTagRegistry` order.
  - Asserts: the JSON (ids masked), key order, the registry's shas, the shas queued for persistence, and idempotence.
  - The conflict-card picture is used nowhere else in its document, so the golden shows it is found within one pass from an empty registry, by the ingestion order above. (`migrate-rows.test.mjs` does not depend on earlier tests for this either: its body is sanitised, and the picture interned, before the lookup.)
- **`normalisers-golden`:** one table per normaliser that moves, with every case at a limit, one past it and one short of it: people names, the `migrateRows` field limits, `plainText`'s control characters, `plainName`, `safeId`, `safeHref`, `safeImageSrc`, the image size attributes, `DIRECTION_MAX`, `normalizePersonColors` and its name guard, `withPageHead`, scene and target lengths, gallery limits and b-roll props.
- **`merge-golden`:** `mergeStates` fixtures with ids and timestamps masked, including the fields `12a-undo.js` skips.
- **`production-golden`:** `productionEntries`, `brollEntries` (read and repair), the records that `healTagRegistry` writes, and cue retitling (today only browser suite 241 covers it).
- **`sha256-utf8`:** `sha256Hex` over `TextEncoder` and over the hand-written UTF-8 encoder (with `TextEncoder` removed) equals `node:crypto`, lone surrogates included; it is the oracle for 2.1a's manual encoder.

## Risks

- **Key order and in-place mutation.** `migrateRows` mutates and returns the same object, and key order sets the `.splitpage` and `.md` bytes. Don't rebuild objects, and don't delete and re-add keys. `hadTagRegistry` is read before defaults are filled in.
- **Identity.** Keep the #82 seed order and the frozen SHA vectors, and write the manual encoder into a `Uint8Array`. The sanitiser mints ids for anchor and b-roll key spans that lack them.
- **Translate literally.** Keep `{}` maps, `||` defaults and `var` semantics, and keep the throwing default of the merge strategy switch.
- **Latent defect found, not fixed during the move.** Ids like `__proto__` or `constructor` survive `safeId` and collide in the id maps. Fix it on 3.1.x first.
- **Forward merges.** Expect 3.1.x conflicts in 02-state, 03-sync and 04c. Land lanes quickly, and port fixes into core during the merge.

**What stays legacy behind a documented bridge after this milestone:**
- DOM edits of cells that hold media;
- the blob registry;
- `getEditorName`;
- render-time repairs, which apply core plans until M6;
- `loadInitialState` and `standaloneHtmlFor`.

## Where the plan's wording does not fit the code

1. Only decoding and sanitising move to the HTML adapter. `toHtml` uses no DOM and core/merge needs it, so encoding stays in core. INV-10 (the sanitiser's fixed point) still holds.
2. `migrateRows` and `mergeStates` are composed at the core root, because `CORE_DEPENDENCIES` keeps merge and production apart.
3. "Separate ingestion" becomes a port with pure decoding and a pending list, not a second pass.
4. The export comment read model needs HTML-to-text and date formatting, which the invariant ledger assigns to milestone 5. This milestone moves comment anchors, ordering and filters.
5. Statuses and categories move down as ids and ranks. Labels, colours and icons stay in presentation.
6. The `S` metrics barely move in this milestone; its gain is in cycle edges. `S` access falls in milestones 3 to 6.
