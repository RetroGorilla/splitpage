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

## 2.3 as built

- **`src/core/merge/`, new files.** Inside the folder, imports run one way: `text-field` imports `lists` and `cells`; `rows` imports `text-field`; `scalars` imports a type from `rows`; `states` imports `lists`, `rows`, `scalars` and `text-field`. `lists` imports nothing from core/merge or core/text, only core/document.
  - `text-field.ts`: `textMergeContext(decode, base, mine, theirs, mergedTags?)` and `mergeTextField(base, mine, theirs, ctx)`. The context carries the decoder as `ctx.decode`, so `mergeTextField` keeps its four arguments and `18a-local-merge.js` calls it unchanged.
  - `lists.ts`: `mergePeople`, `mergeProductionTags`, `mergeBrollShots`, `mergeBrollProps` and `LIST_MERGERS`, which is frozen and keyed by the three `list-union-with-base` fields: `people`, `productionTags`, `brollShots`. `mergeBrollProps` merges a shot's `props` inside `mergeBrollShots`; no state field holds props, so it is exported but not in the table.
  - `rows.ts`: `byId`, `rowFieldKey`, `rowContentEqual`, `commentContentEqual`, `mergeRows` (with `mergeRow` inside it, as before), `mergeComments` and `conflictComment`, which builds one conflict card from the `ids`, `clock` and `editor` ports.
  - `scalars.ts`: `mergeTitle`, which pushes the title conflict as before, `mergeChangedSideWins`, `mergeMaxPlusOne`, `mergeTheirsWins` and `mergeTargetLength`.
  - `states.ts`: `mergeStateFields(base, mine, theirs, { decode, ids, clock, editor, fields? })` returns `{ merged, conflicts, stats }`, with `merged` not yet migrated. The strategies are a table typed `Record<StrategyId, FieldStrategy>`, so a missing strategy is a compile error. A strategy the table does not hold as its own property still throws `no merge strategy for state field <key>`, so `constructor` or `__proto__` as a strategy throws, as the `switch` did. `fields` defaults to core's `STATE_FIELDS`.
  - No `gallery.ts`: `mergeGalleryField` and `galleryFieldKey` were already in `core/document/gallery.ts`, and `mergeRow` calls them in the same ten lines as before.
- **The merge's decoder port.** `text-field.ts` exports `MergeDecoder`, `(html, opts: DecodeOptions) => readonly Run[]`. The merge decodes each side with that side's `tagId`, and must hear `onMedia`: a cell holding a picture is never merged word by word. `CellDecoder` stays the options-free reader `anchors.ts` takes, so the two contracts have different names.
  - TypeScript accepts a function that declares fewer parameters, so the type cannot stop a cached reader such as `cellOf` or `createCellReader()` being wired in as `decode`. If one were, a merge where mine adds a picture and theirs changes a word would keep theirs with no conflict and silently drop mine's picture.
  - So the guard is a contract test. `tests/core/merge/decoder-contract.ts` checks that a decoder reports the picture through `onMedia`, maps a tag through `tagId`, and turns that picture-beside-a-word merge into a conflict. The adapter's `decode` and `04c-doc-model.js`'s `fromHtml`, which `03-sync.js` passes, meet it; the adapter's cell reader, `cellOf` and an options-ignoring fake fail all three clauses. `src/test/merge-decoder.test.mjs` also runs that merge through `mergeStates`.
- **List mergers.** The `list-union-with-base` strategy finds its merger in `LIST_MERGERS` by the field's key, not through `f.mergeList`. `02-state.js` attaches the same functions, so the result is the same for every table the app has.
- **Translation.** It stays literal: `{}` maps, so ids named like `Object.prototype` members behave as before (#278); the same `||` defaults; the same order of work (tags, rows, comments, title, conflict cards, field loop), and so the same order of clock, editor and id calls. `(tagStatus(x) || TAG_STATUSES[0]).id` became `tagStatusId(x) || TAG_STATUS_IDS[0]`: the same list in the same order. The mergers' `cloneState` calls became a local JSON copy, `var` became `let` and `const`, and `delete out[f]` became `Reflect.deleteProperty`.
- **`cloneState` stays.** The plan's table moves it to core, but the merge no longer calls it, and the ten legacy modules that do import it from `03-sync.js`, so it stays there.
- **Shims.**
  - `03-sync.js` keeps `mergeStates`, which calls `mergeStateFields` with legacy ports, then `migrateRows`, as before. The ports are `fromHtml` from `04c-doc-model.js`, `randomIds` (whose `id` is the `makeId` that `02-state.js` re-exports), `systemClock` (the `nowIso` that `10-comments.js` re-exports), `getEditorName`, and `02-state.js`'s `STATE_FIELDS`. That last one keeps a probe pushed onto the legacy table in the merge, as the merge golden's throwing test needs. Its `textMergeContext(base, mine, theirs, mergedTags)` passes `fromHtml`.
  - `03-sync.js` re-exports `byId`, `rowFieldKey`, `rowContentEqual`, `mergeTextField`, the three list mergers and `mergeTargetLength` from core, and `ROW_FIELDS` and `GALLERY_FIELDS` from `core/document/fields.ts`, so its copies are gone. It exports the same names as before, so no importer changed. It no longer imports `00-prelude.js`, `02d-gallery.js` or `08c-broll.js`, or the names only the merge used from the modules it still imports.
  - `02-state.js` attaches `mergeList` from core's `LIST_MERGERS` and no longer imports `03-sync.js`.
  - `12a-undo.js` builds `SKIP_DOC_KEYS` from the `undo: false` entries of core's `STATE_FIELDS` when it loads. It reads core's table, not `02-state.js`'s copy, because core is outside the cycle and so has always loaded by then.
- **The drift test.** `src/test/state-field-tables.test.mjs` now checks the shims rather than copies: `03-sync.js`'s `ROW_FIELDS` and `GALLERY_FIELDS` are core's objects, each `mergeList` in `02-state.js` is core's `LIST_MERGERS` entry, and `changedBetween` still skips exactly the `undo: false` fields.
- **Tests.** `tests/core/merge/` runs without a DOM. `fakes.ts` holds a decoder that maps `toHtml` output back to cells, maps default tag ids through `tagId` and reports media for cells marked as holding it, plus counting ids, a fixed clock and a fixed editor. The tests cover:
  - every strategy over one three-way merge, with keys in table order, and person colours and a target length that no side has leaving no key;
  - a deterministic merge with fake ports, conflict cards included, and the ports as the only source of time, ids and the editor's name;
  - an unknown strategy throwing, prototype names included;
  - INV-04: a copy of the table with added fields, one for each per-key strategy, merging with no other edit;
  - `LIST_MERGERS` reproducing all 46 stored list-merger golden cases, key order included;
  - text outcomes, mark conflicts, media cells, tag refits and which cells are decoded;
  - row placement, deletes, stamps, pictures, status, length, gallery lists, comments and conflict cards;
  - today's prototype-id collisions in rows, comments, replies, people, tags and shots.
- **Dependencies.** `--prune` removed two `cycle-edge` entries, `02-state.js → 03-sync.js` and `03-sync.js → 08c-broll.js`; nothing was accepted. `--metrics`: frontend modules 117 to 122, migrated modules 40 to 45, runtime cycle edges 492 to 490. The cycle stays at 56 modules, and `S` importers (57), `S.state` assigners (9) and `S` writers (34) are unchanged.
- **Found, not fixed.**
  - A `list-union-with-base` field with no entry in `LIST_MERGERS` throws a `TypeError`, not the "no merge strategy" error. That is as before, when its `mergeList` was missing.
  - A table without a `productionTags` field throws, because the text merge needs the merged registry. That is also as before.
  - For a row whose id is an `Object.prototype` name and that one side lacks, `mergeRow` reads that side's row as the inherited member, and the merged row's `status` can come out `undefined` until `migrateRows` resets it. This is part of #278.
- **Left for 2.5.**
  - INV-04's test here covers the merge only. The same added field surviving `migrateRows` and a `.splitpage` round trip comes when `core/migrate.ts` and `core/merge-states.ts` compose them at the core root.
  - **Reply aliasing: 2.5 must change this.** For a comment both sides hold, `mergeComments` puts the input reply objects into its output by reference, not copies. `migrateRows` then writes into them (`id`, `body`, `author`), so `mergeStates` changes its own `mine` and `theirs` arguments. The review's fuzzing saw it in 2,830 of 25,000 cases, the same on the code before the move, so 2.3 keeps it. When `core/merge-states.ts` composes migrate and merge, the merge must clone the replies, or the migration must stop mutating its input. Two tests pin today's behaviour and must change on purpose then: `tests/core/merge/rows.test.ts` ("the input objects themselves, not copies") and `src/test/merge-states.test.mjs` ("pinned until 2.5").

## 2.4 as built

- **`src/adapters/richtext/`.** `createRichText({ DOMParser, images, ids })` takes a `DOMParser` constructor and core/document's `ImageSource` and `IdSource`; no new port type was needed. It returns `inertBody`, `sanitize`, `decode` (`fromHtml`), `createCellReader`, `storedHtmlFromDom`, `htmlToMarkdown`, `videoCardElement`, `videoCardHtml` and `imageRefOf`. Every node is built through the parsed body's `ownerDocument`. The only platform global it names is `URL`, for the video card's host.
  - `sanitize.ts`: `walkSanitize`, `imageRefOf`, the stored image element and the video card. `imageRefOf` asks `images.known(sha)` for a valid `data-blob` and `images.fromDataUrl(src)` for a safe data URL, so interning then queueing persistence is the port's job. Ids go through core's `safeId(id, prefix, ids)`. Lookups, ingestion and minting happen in document order, as before.
  - `decode.ts`: the walk over sanitised HTML, ending in `normalizeCell(runs, opts)`, and `createCellReader(decode)`. That is `cellOf`'s cache: a `Map` cleared whole when, before a new entry, it holds more than 2,000,000 characters. Each reader has its own cache.
  - `markdown.ts`: the Markdown walk. `richtext.ts`: the factory.
- **One stored image tag.** `text-policy.ts` gains `StoredImageRef` (an `ImageRef` whose size and type may be missing) and `storedImageAttributes(ref)`: `class`, `data-blob`, then `data-w`, `data-h` and `data-mime` only when all three are set. It now exports `storedImageMarkup`, which writes the tag from that list, and the adapter sets the same list with `setAttribute`.
  - The adapter does not parse core's string, so a record a port returns is escaped by the DOM rather than spliced into markup. A test hands back a `mime` holding `" onerror="` and finds no new attribute.
  - `mediaComments`' tag for a picture known only by its sha is `storedImageMarkup({ sha256 })`, not a third copy.
  - The bytes are unchanged; the richtext and migrate goldens pass as they were.
- **`src/legacy/richtext.ts`.** It composes the adapter with the page's `DOMParser`, `registryImages` from `02c-blobs.js` and `randomIds`. It builds the adapter on first use, so the `DOMParser` global is read when something is first parsed, as `inertBody` read it before. It exports `inertBody`, `sanitizeHtml`, `imageRefOf`, `storedHtmlFromDom`, `htmlToMarkdown`, `buildVideoCardEl`, `videoCardHtml`, `fromHtml` and `cellOf`.
- **Shims.**
  - `04-richtext.js` re-exports the first six. It keeps `safeId` (with `randomIds`), `cssAttr` and `ensureTrailingCaretSpot`. The last appends a caret text node to a live cell through the page's `document`; it is editor code, not sanitising, and moves with the editor in milestone 6.
  - `04c-doc-model.js` re-exports `fromHtml` and `cellOf`, keeps `syncCommentAnchors(state)`, and no longer imports `04-richtext.js`.
  - No importer of either module changed.
- **Where nodes live.** The sanitiser builds its output in the parser's inert document instead of the page's, and `buildVideoCardEl` builds its card in an inert document the adapter parses on its first card and reuses. Every caller of `buildVideoCardEl` (`05-render.js`, `02-state.js`, the golden) only reads its `outerHTML`.
- **Import graph.**
  - `04-richtext.js` no longer imports `02c-blobs.js`, `shared/blob-policy.js`, or core's `broll.ts` and `tags.ts`.
  - `04c-doc-model.js` no longer imports 04.
  - Both import `src/legacy/richtext.ts`, which imports the two adapters and `02c-blobs.js`; 02c imports only core and shared. So neither 04 nor 04c gains an edge back into the legacy cycle, and no cycle runs through a migrated folder.
- **Dependencies.** No baseline change: `--prune` found nothing, and nothing was accepted. `--metrics` counts 5 more frontend modules (117 to 122) and 5 more migrated ones (40 to 45). The cycle (56 modules, 492 edges) and every `S` figure are unchanged.
- **Translation.**
  - `Array.prototype.slice.call` and `forEach.call` over node lists became `Array.from` and `NodeList.forEach`, and a text node's value is read as `data`.
  - `parseInt(weight, 10)` became `parseInt(String(weight), 10)`, still `NaN` for a missing style, and an unused `catch` binding went.
  - `STORED_IMG_ATTRS` stays a `{}` map. Sanitised output always carries both attributes of a tag anchor, so the decoder hands them to `tagId` as strings.
- **Tests.**
  - `tests/adapters/richtext/` builds the adapter with jsdom's `DOMParser` in a process with no DOM globals. The parser comes from `jsdom.mjs`, because jsdom has no types.
  - `golden.test.ts` replays the 83 cases and 11 video cards of `richtext-golden.json` byte for byte. Its fake `ImageSource` holds the golden's known picture and decodes data URLs with core, and its fake `IdSource`'s ids are masked as the golden masks minted ones. It asserts INV-10, that `toHtml(decode(x))` is in stored form, that decoding asks the ports exactly what sanitising asks, in the same order, and that Markdown and stored-form reads ask nothing.
  - `ports.test.ts` pins the order of lookups, ingestion and minting, a dropped picture, a bad `data-blob` falling back to its `src`, the decode options, the cell reader's cache and eviction at the budget, and the video card.
  - `tests/legacy/richtext.test.ts`: 04 and 04c hand out the bridge's functions; the bridge parses with the page's `DOMParser`; a pasted picture is interned at once and persisted after; a held `data-blob` takes the registry's record; minted ids are `makeId`'s; `cellOf` keeps what it read.
  - `tests/core/document/text-policy.test.ts` checks the attribute list and the markup. INV-10's tests name the adapter's.
  - Browser suites, all passing: `01-core` (20), `10-comments-panel` (17), `20-comment-drift` (43), `52-csp` (22), `65-blobs` (49), `66-hosted-blobs` (84), `68-images` (31), `69-html-images` (54), `77-clipboard-model` (51), `86-gdocs-paste-bold` (5), `92-paste-into-gallery` (102), `160-gallery-video` (127). The bundle has no `eval` or `new Function`.
- **Found, not fixed.** `storedHtmlFromDom` keeps an image attribute named `constructor` or `__proto__`, because `STORED_IMG_ATTRS` is a `{}` map. HTML lower-cases attribute names, so no other `Object.prototype` name matches. Neither can carry script, and sanitising drops both.
- **Review follow-ups (PR #287).**
  - `storedImageMarkup`, now exported, escapes every attribute value with `escapeHtml`, so a record nobody validated cannot open an attribute through its `sha256`, `width`, `height` or `mime`. A valid record's values need no escaping, so every stored tag and golden is unchanged. Core tests put `"`, `<`, `&` and `'` in each field; an adapter test parses the markup back to exactly its five attributes.
  - `tests/adapters/richtext/stored-form.test.ts` pins `storedHtmlFromDom`'s allow-list: event handlers in odd capitalisation and quoting, twenty other attributes, and pictures nested in other markup. A mutant that kept `on*` attributes passed every test before; it fails all three now.
  - Video cards come from one inert document per adapter instead of a fresh parse per card.
  - Two quirks of stored form, neither reachable from a cell: `storedHtmlFromDom` looks for `data-blob` case-sensitively before parsing, so markup spelling it `DATA-BLOB` passes through untouched, and an `is` attribute removed from a picture comes back on serialisation, because the DOM writes an element's `is` value out. Every caller passes a live cell's `innerHTML`, which writes attribute names in lower case, and the sanitiser builds fresh elements that have no `is` value.
- **Left for 2.5.** `02-state.js`'s `moveMediaOutOfCell` still makes the video card's HTML with `buildVideoCardEl(href).outerHTML`; the bridge's `videoCardHtml` is the same string. INV-10's acceptance also asks for a check that no module outside the adapter builds cells from HTML; it is not written yet.

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
