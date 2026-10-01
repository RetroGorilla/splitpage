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
  - `tests/core/environment.test.ts` imports every core module and asserts that no DOM globals exist.
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
