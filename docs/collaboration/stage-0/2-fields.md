# Stage 0 field inventory

Every persisted thing in a Splitpage document, with its normalization, writers, export use, today's merge rule and a provisional shared policy (plan section 12, item 2).

Audited against `0ca1929177ffc84bced412ad2be3aa99690761d0`.

## Reading the tables

- **Merge today** is the standalone three-way merge: the `STATE_FIELDS` strategy in `src/core/document/fields.ts` for top-level fields, otherwise the function in `src/core/merge/` or `src/core/document/gallery.ts` that decides it. It is evidence for the shared policy, not the shared policy.
- **Normalization** happens in `migrateRows` (`src/core/migrate.ts`) unless another symbol is named. `migrateRows` runs on every whole-document entry: open, new tab, adopt, disk absorb, recovery, reload, merge result, draft restore, and on a clone before every `.splitpage`, Markdown project and Standalone HTML write (`fileStateFor` in `src/adapters/formats/project-file.ts`, `standaloneHtmlFor` in `src/adapters/page/standalone-html.ts`).
- **Export** codes:
  - **F**: the whole-document formats `.splitpage` (`buildSplitpageFile`), the Markdown project data block (`buildMarkdownProject`) and Standalone HTML state data (`standaloneHtmlFor`). All three are byte-stable sha256 goldens in `src/test/exports-golden.test.mjs`. Every field below is in F unless the row says otherwise. App-data export, history and drafts also carry the whole document; they have no golden.
  - **R**: readable exports. Markdown and Markdown table are byte goldens and the export facts (`exportFacts`, `src/adapters/formats/export-kit.ts`) a value golden in the same test. DOCX (`docx.ts`), print and PDF (`script-print.ts`), XLSX, CSV and production lists (`list-print.ts`) have no byte golden.
- **On disk** the F formats differ from the in-memory shape: `inlineStateImages` (`src/adapters/storage/02c-blobs.ts`) swaps every `imageRef` for a `visualImage` data URL and every `<img data-blob>` for `<img src="data:..." class="comment-img">`. On load, `migrateRows` interns them back to sha256 references.
- **Serves** uses the brief's tags. Stage 1a: T01 to T12, T20, T21, MOVE, SLICE, PROJ. Stage 1b: T13 to T19, T22 to T24, STORE.

## Top-level document fields (`STATE_FIELDS`, 18 fields)

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `title` | Plain text, at most 300 units | `""` (`STATE_FIELDS` def); `cappedLongText(plainText())` | `src/application/commands/title.ts` (sets `titleOrigin: "user"`); first save renames from the file name (`fileTitleChange`, `src/application/save/file-saving.ts`); restore of a title conflict (`restoreConflictCommand`); Markdown project heading on open (`applyMarkdownProject`) | F; R everywhere (title line) | `title.ts` | `title` (`mergeTitle`): changed side wins; both changed keeps theirs and adds a conflict comment | Character-level text | PROJ, SLICE |
| `titleOrigin` | `"file"` or `"user"`, else absent | `normalizeTitleOrigin` | `title.ts`; first save (`fileTitleChange`) | F only | `title.ts` | `optional-changed-side-wins` | Coupled atomic group **file-title** (`titleOrigin`, `titleVersion`), last writer wins | PROJ |
| `titleVersion` | `v<digits>`, lowercased, else absent | `normalizeTitleVersion` | First save from a versioned file name (`fileTitleChange`) | F only | `title.ts` | `optional-changed-side-wins` | Group **file-title** | PROJ |
| `docId` | `d` + 32 hex (`DOC_ID_RE`, `shared/doc-id-policy.ts`) | Minted if missing; a file without one gets `deriveDocId("splitpage-file", canonical source)` in `migrateDocument` | Load; Save As fork (`documentIdStamp` in `src/application/save/save-completion.ts`); duplicate-id reassignment between open scripts (`src/application/identity/document-identity.ts`) | F, except Standalone HTML and `buildSplitpageCopy`, which delete it | `document-identity.ts` | `doc-id` (`mergedDocId`) | Write-once atomic value, set when the instance is created (plan section 3) | T13, T17, PROJ |
| `rows` | Ordered array of beat records, see the next table | `[]`; non-objects dropped | Every structural command (flow, beats, split-join, clipboard, import) | F; R (one beat per row) | `src/application/session/document-session.ts` through commands | `rows` (`mergeRows`) by row id; order by `mergeSceneLayout` when scenes exist | Ordered sequence of beat boundaries with stable ids | T05, T06, T08, T09, T10, T12, MOVE, PROJ, SLICE |
| `comments` | Array of comment records | `[]` | Comment commands (`src/application/commands/comments.ts`); merge conflict cards; media moved out of cells on load | F; R (comment lists) | `comments.ts` | `comments` (`mergeComments`) by id | Set keyed by id | T11, T21, PROJ |
| `people` | Array of `{id, name}` (extra properties kept, see unknown keys) | `[]`; names capped at 60 by `settledNames`, which does not deduplicate them; nameless dropped | `addPersonCommand`, `deletePersonCommand` (`production-records.ts`); owner sync at commit (`applyOwnerSync`) | F; R (owners by name) | `src/core/production/records.ts` | `list-union-with-base` (`mergePeople`): union, name unique, an unchanged base entry deleted on one side stays deleted | Set keyed by id; the unique-name rule is a merged-state limit | PROJ |
| `productionTags` | Array of tag records | `[]`; rebuilt from row spans when the key is absent (`collectTagsFromRows`) | Tag commands (`production-records.ts`, `bulk-tags.ts`, `tag-rewrites.ts`); tag records at commit; load | F; R (production lists, DOCX) | `src/core/production/tags.ts` | `list-union-with-base` (`mergeProductionTags`) | Set keyed by id, but see "Marks with identity" | T20, PROJ |
| `brollShots` | Array of shot records | `[]` | Shot commands (`production-actions.ts`, `broll-records.ts`); shot records at commit; paste (`recordPastedBroll`); load | F; R (shot lists) | `src/core/production/broll.ts` | `list-union-with-base` (`mergeBrollShots`) | Set keyed by id (the id is the b-roll key's id) | T06, PROJ |
| `wordsPerMinute` | Integer 60 to 400 | 150 (`DEFAULT_WPM`); `normalizeWordsPerMinute` | `wordsPerMinuteCommand` (`document-settings.ts`) | F; R (DOCX, export facts) | `document-settings.ts` | `changed-side-wins` | Atomic, last writer wins | PROJ |
| `rev` | Number | 0; non-finite becomes 0 | Save completion only (`editStamp` in `save-stamps.ts`, from `confirmWrite`) | F (the capture stamp) | `src/application/save/save-completion.ts` | `max-plus-one` | Unresolved (edit stamps, Open question 1) | T13, T22, PROJ |
| `lastEditedBy` | Name, at most 30 units, else absent | `normalizeEditorName` | Save completion (`editStamp`) | F | `save-completion.ts` | `theirs-wins` | Unresolved (Open question 1) | T13, PROJ |
| `lastEditedAt` | ISO string, not normalized | none | Save completion (`editStamp`) | F | `save-completion.ts` | `theirs-wins` | Unresolved (Open question 1) | T13, PROJ |
| `personColors` | Map of person name (at most 80) to one of 8 palette colors, at most 200 entries | `normalizePersonColors`; empty map becomes absent | Attribution at every commit (`attribute` → `myColorPlan` in `src/application/save/session-effects.ts`), only when the author's color differs | F only | `session-effects.ts` | `person-colors` (`mergePersonColors`) | Unresolved (Open question 1); candidate: set keyed by name, last writer wins per key | PROJ, PERF |
| `targetSeconds` | Integer 1 to 86400, else absent | `normalizeTargetLength` | `targetLengthCommand` | F; R (export facts) | `document-settings.ts` | `target-length` (`mergeTargetLength`) | Atomic, last writer wins | PROJ |
| `sections` | Array of `{id, name, firstSceneId}`, absent when empty | `normalizeScenes` drops bad ids, empty names, duplicate ids and anchors; `writeScenes(scenesInOrder())` sorts by anchor position and drops headers whose anchor is gone | Flow heading operations (`src/core/flow/flow.ts`); `src/application/commands/scenes.ts`; beat removal and moves (`scenesAfterRemoval`); paste | F; R via `deriveDocumentNumbering` (Markdown, DOCX, print and PDF show headings; CSV and XLSX do not) | `scenes.ts`, `flow.ts` | `sections` (`mergeSceneLayout`, rules in `docs/architecture/sections.md`) | Ordered sequence of scene boundaries with stable ids | T08, T09, MOVE, PROJ |
| `paragraphsDecided` | `true` or absent | Only literal `true` kept | `initializeFlowParagraphs` (`src/application/commands/flow.ts`) when the writer first opens a script | F only | `flow.ts` | `true-if-either` | Monotonic: once true stays true (OR). Its writer is a repair; see "Repairs" | PROJ |
| `schema` | Number; always written as 2 (`SCHEMA_VERSION`) | Set to 2 on every load; below 2 converts legacy Markdown cells | `migrateRows` | F only | `src/core/migrate.ts` | `constant` | Write-once per instance, used as a version gate | T18, PROJ |

## Fields outside `STATE_FIELDS`

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unknown top-level keys (fixture `doc.unknownField.kept`) | Any JSON | Kept unchanged by `migrateRows`; the types allow `[key: string]: unknown` at the top level, on rows, comments and shots | Older or newer apps | F | none | Dropped: `mergeStateFields` (`src/core/merge/states.ts`) starts from `out: {}` and writes only registered fields | Unresolved (Open question 6) | T18, PROJ |
| Unknown keys on rows, comments, replies and shots | Any JSON | Kept by `migrateRows` | Older or newer apps | F | none | Kept from the copied side: theirs for a row both sides have (`mergeRows`), the newer comment (`mergeComments`), theirs for a shot (`mergeBrollShots`) | Unresolved (Open question 6) | T18, PROJ |
| Unknown keys on people and tag records | Any JSON | Kept by `migrateRows` (it edits the records in place) | Older or newer apps | F | none | Dropped: `mergePeople` rebuilds `{id, name}`, `mergeProductionTags` rebuilds the entry (`entryOf`) | Unresolved (Open question 6) | T18, PROJ |

## Beat (`rows[]`)

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rows[].id` | `[A-Za-z0-9_-]+`, unique | Missing: `r-load-<source hash>-<n>` (`createLoadIds`); a duplicate gets `-<n>` | Created by flow (`ports.newId()` → `makeId`), `beats.ts`, new tab, file menu, paste, import | F; R (beat numbers come from order, not id) | `flow.ts`, `beats.ts` | Row identity in `mergeRows` | Identity of a sequence element, never changed | T05, T06, T10, MOVE, PROJ |
| `rows[].audioText` (narration) | Sanitized HTML; contents in the rich-text table. Commands write `toHtml(runs)`, but `migrateRows` only sanitizes, so a loaded cell is not guaranteed to be in `toHtml(decode(…))` form | `""`; `sanitize(textOf())`, or `legacyMdToHtml` below schema 2; cell media moved out (`moveMediaOutOfCell`) | Typing (`syncBeatEl` → cell-text and flow commands), split and join, paste, find and replace, tag rewrites, retag on rename, comment unwrap, Markdown project reconcile | F; R (all) | `cell-text.ts`, `flow.ts` | `mergeTextField` (`src/core/merge/text-field.ts`). **Text conflict** (overlapping text changes, or a cell over the LCS limit in `mergeCells`): theirs whole plus a conflict comment holding mine. **Mark conflict** (`mergeMarks` reports one): the partly merged cell is kept and a conflict comment holding mine is added (`marks: true`). Per-mark rules in the rich-text table. A cell holding media merges whole | Character-level text with marks | T01–T05, T09, T10, T12, T20, T21, PROJ, SLICE, PERF |
| `rows[].visualText` (visual) | Same as narration | Same | Same, plus the b-roll anchoring pass and `@Name` insertion | F; R (all) | `cell-text.ts` | Same as narration | Character-level text with marks; needs a join rule (plan section 5) | T06, T07, T09, T10, T20, T21, PROJ, SLICE |
| `rows[].status` | `todo`, `ready` or `shot` (shot means Filmed) | `todo` when invalid | `beat-status.ts` (cycles todo → ready → shot → todo) | F; R (CSV, DOCX, Markdown, print, XLSX, facts) | `beat-status.ts` | Highest rank wins (`mergeRows`) | Changes made at the same time to different values leave the status as it was; the same value applies (Decision 1, decided) | PROJ |
| `rows[].lengthSeconds` | Integer 0 to 86400, else absent | `normalizeBeatLength` | `beat-length.ts` | F; R (timings via `export-projections.ts`) | `beat-length.ts` | Changed side wins (`mergeRows`) | Atomic, last writer wins | PROJ |
| `rows[].paragraphStart` | `true` or absent | Non-`true` deleted | Flow split and Enter, `paragraphFlagsAfterOrder` on delete and move (`paragraphs.ts`), `initializeFlowParagraphs`, paste, import | F only (the prompter reads it; no export does) | `paragraphs.ts`, `flow.ts` | Changed side wins (`mergeRows`) | Atomic, last writer wins, on the beat boundary; the implicit starts are derived (see "Stored twice") | T05, T06, T08, PROJ |
| `rows[].updatedAt` | ISO string or `""` | `""` when missing | Most row commands (cell-text, split-join, beat-status, beat-length, gallery, clipboard, document-edit, import, restore conflict); merge when mine is taken; session merge | F only | Each row command | Restamped with now when mine is taken | Unresolved (Open question 1) | PROJ, PERF |
| `rows[].updatedBy` | Name or `null` | `plainName` or `null` | Same writers as `updatedAt` | F only | Each row command | Restamped with the editor name | Unresolved (Open question 1) | PROJ, PERF |
| `rows[].imageRef` | Image reference (below) or `null`; first gallery slot | `normalizeImageRef`; legacy `visualImage` interned | Gallery commands (`gallery.ts`, `setRowSlots`), paste and drop, restore of an image conflict, Markdown project | F (on disk as `visualImage`); R (DOCX, Markdown images, print) | `src/application/commands/gallery.ts` | Coupled with `imageName` and `imageAnnotation`; a conflict makes an image conflict comment (`mergeRows`) | Coupled atomic group **first-picture** (`imageRef`, `imageName`, `imageAnnotation`) inside the slot sequence | T06, T16, T17, PROJ |
| `rows[].imageName` | Plain text, at most 200; only with `imageRef` | `normalizePictureName` | Gallery commands | F only | `gallery.ts` | Follows `imageRef` | Group **first-picture** | T06, PROJ |
| `rows[].imageAnnotation` | `{imageRef, marks[]}`; `imageRef` is the original, the slot's `imageRef` is the flattened render | `normalizeAnnotation`: needs marks and a different sha | `annotateGallerySlot` | F (original inlined as `visualImage`) | `gallery.ts` | Follows `imageRef` | Group **first-picture** | T16, PROJ |
| `rows[].imageLinks` | Up to 20 video links (attachments uncounted); the first slot's links plus every file attachment of the row | `normalizeVideoLinks`: dedupe by `videoLinkKey`, one `poster` | `addGalleryVideo`, `addGalleryFile`, `removeGalleryLink`, `setVideoThumbnail` | F; R (DOCX, Markdown, print via `rowVideoLinks`) | `gallery.ts` | `mergeGalleryField` → `mergeSet` keyed by `videoLinkKey`, `mergeLink` | Set keyed by `videoLinkKey` | T06, PROJ |
| `rows[].moreImages` | Up to 60 gallery items after the first slot | `migrateGallery`: dedupe by `galleryItemKey`, promotes the first item when slot one is empty, hoists file attachments into `imageLinks` | Gallery commands | F (on disk `visualImage`); R (DOCX, Markdown, print via `morePictureRefs`) | `gallery.ts` | `mergeGalleryField` keyed by `galleryItemKey`; `mergeGalleryThumbnailRemovals` | Ordered sequence of slots, first slot included (see "Stored twice"); slot identity unresolved, because `galleryItemKey` is a content key that changes on edit (Open question 8) | T06, T16, T17, PROJ |
| `rows[].visualImage` | Legacy data URL (in memory); the on-disk form of `imageRef` | Interned to `imageRef` and deleted | F writers (`inlineStateImages`) | F on disk only | `02c-blobs.ts` | n/a | Not in shared state (file encoding only) | T16, PROJ |

### Gallery item, link and image reference

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `moreImages[].imageRef` | Image reference; absent for a video slot with no thumbnail | `normalizeImageRef` | Gallery commands | F, R | `gallery.ts` | Item key: `galleryItemKey` is its sha256, else `"v:" + videoLinkKey(poster)` | Atomic value inside group **slot-picture**; a content key, not a stable slot identity (Open question 8) | T16, T17, PROJ |
| `moreImages[].name` | Plain text, at most 200; only with `imageRef` | `normalizePictureName` | Gallery commands | F only | `gallery.ts` | Theirs copy | Atomic, last writer wins | PROJ |
| `moreImages[].annotation` | `{imageRef, marks[]}` | `normalizeAnnotation` | `annotateGallerySlot` | F | `gallery.ts` | Theirs copy | Coupled atomic group **slot-picture** (`imageRef`, `annotation`) | T16, PROJ |
| `moreImages[].links` | Links of that slot | `normalizeVideoLinks` | Gallery commands | F, R | `gallery.ts` | `mergeSet` + `mergeLink` | Set keyed by `videoLinkKey` | PROJ |
| `…links[].href` | `http(s)` URL, at most 2048 (`safeHref`) | Link dropped if invalid | `addGalleryVideo` | F, R | `gallery.ts` | Key part | Write-once (part of the key) | PROJ |
| `…links[].name`, `…links[].size` | Local file name (at most 200) and byte size | `normalizePictureName`, floor | `addGalleryVideo`, `addGalleryFile` | F, R | `gallery.ts` | Key part | Write-once (part of the key) | PROJ |
| `…links[].duration` | Seconds, one decimal, 0 to 1e7 | Rounded | `addGalleryVideo` | F, R | `gallery.ts` | Theirs copy | Atomic, last writer wins | PROJ |
| `…links[].poster` | `true` or absent; at most one per list | Duplicate posters dropped | `addGalleryVideo` | F | `gallery.ts` | Theirs copy | Atomic, write-once | PROJ |
| `…links[].location` | `{kind:"path", path}` or `{kind:"bundled", name}` | `normalizeVideoLocation`; `bundleVideoLinks` and `pathVideoLinks` rewrite it | Desktop attach and bundle-on-drop | `.splitpage` and Markdown project only; Standalone HTML strips it (`withoutVideoLocations`) | `gallery.ts` | `mergeLink`: bundled beats path; a missing one never wins | Local-only, not shared (plan section 7) | T16, PROJ |
| Image reference `{sha256, width, height, mime}` | 64 hex; integers 1 to 2^20; jpeg, png, gif or webp | `normalizeImageRef` (`shared/blob-policy.ts`) | Image ingestion (`imageRecordOf`) | Bytes in F as data URLs; listed by `refsIn()` | `blob-policy.ts` | n/a | Atomic value; bytes outside the CRDT (plan section 7) | T16, T17, PROJ |
| Hash-only inline image reference `{sha256}` (`StoredImageRef`) | 64 hex, no size or MIME | `imageRefOf` (`sanitize.ts`) and `imageRefIn` (`runs.ts`) fall back to `{sha256}` when the blob store does not know the hash; `storedImageAttributes` writes `data-w`, `data-h`, `data-mime` only when all three are present; `mediaComments` writes `storedImageMarkup({ sha256 })` for an unknown image moved out of a cell | Sanitizer, decoder, `migrateRows` | F (`<img class="comment-img" data-blob>` without dimensions); listed by `refsIn()` | `sanitize.ts`, `runs.ts` | n/a | Atomic value; the projection resolves bytes, size and MIME from the blob store, and the shared schema must accept the hash-only form (T16, T17) | T16, T17, PROJ |
| Annotation mark, pen or highlight | `{kind, color, width 0.001–0.2, points[] ≤ 4000 numbers in 0–1}`; color one of 6 | `normalizeMarks`, at most 500 marks | `annotateGallerySlot` | F | `gallery.ts` | Whole annotation | Inside group **slot-picture** | PROJ |
| Annotation mark, text | `{kind:"text", color, size 0.01–0.3, x, y, text ≤ 500}` | `normalizeMark` | `annotateGallerySlot` | F | `gallery.ts` | Whole annotation | Inside group **slot-picture** | PROJ |

`refsIn()` names every image a document references: `rows[].imageRef`, `imageAnnotation.imageRef`, `moreImages[].imageRef` and `.annotation.imageRef`, `<img data-blob>` in either cell, `comments[].imageValue`, and `<img data-blob>` in comment and reply bodies. It reads no video poster separately; a poster thumbnail is the slot's `imageRef`.

## Scene header (`sections[]`)

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sections[].id` | `[A-Za-z0-9_-]+`, unique | Entry dropped if invalid | Flow promote and paste (`ports.newId()`), `ids.id("section")` in `src/features/rows/scene-controls.ts` | F | `scenes.ts`, `flow.ts` | Identity (`mergeSceneLayout`) | Identity of a boundary element | T08, MOVE, PROJ |
| `sections[].name` | Plain text, at most 200 (`SCENE_NAME_MAX`); no marks | `cappedText(…, 200)`; empty drops the header on load | `renameHeading` replaces the whole string; removing a header copies its name into a new beat's narration (`flow.ts`) | F; R (headings) | `flow.ts`, `scenes.ts` | Changed side wins; both changed keeps theirs | Character-level text (plan section 5); today it is a whole-value replace | T08, PROJ |
| `sections[].firstSceneId` | Id of the scene's first beat | Header dropped when the beat is missing; one header per beat | Every scene and structural command | F | `scenes.ts` | Derived anchor (`sections.md`) | Derived from boundary position, not stored | T08, MOVE, PROJ |

## Comment (`comments[]`) and reply (`comments[].replies[]`)

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `id` | Clean id | Missing: load id `c-load-…` | Composer (`ids.id("c")` in `src/features/rows/render.ts`, `newCommentId` in writer wiring); `mediaCommentId` on load; `conflictComment` | F; R (numbering) | `comments.ts` | Key | Set key | T11, PROJ |
| `rowId` | Beat id; `null` for title conflicts | `cleanId` or minted `r-orphan-load-…`; moved to the mark's row by `syncCommentAnchors` | Composer; anchor repair at every commit | F | `src/core/text/anchors.ts` | Newer copy | Derived from the comment's marks; last known value kept for detached comments (Open question 4) | T11, PROJ |
| `field` | `audioText`, `visualText`, `visualImage` or `title` | Coerced to `audioText` | Composer; anchor repair | F | `anchors.ts` | Newer copy | Same as `rowId` | T11, PROJ |
| `anchorId` | The mark id this comment owns (equals `id` for new comments); `null` for title comments | `cleanId`, else `id` for every non-title comment, so media and conflict comments created with `null` get their own `id` on load | Composer; `conflictComment` and `mediaComments` (as `null`) | F | `comments.ts` | Newer copy | Write-once | T11, PROJ |
| `quotedText` | Plain text copy of the anchored words when created | `plainText`, lone surrogates removed | Composer | F; R | `comments.ts` | Newer copy | Write-once snapshot (stored twice) | T11, PROJ |
| `author` | Name | `plainName` | Composer; `"Splitpage"` for moved media | F; R | `comments.ts` | Newer copy | Write-once | PROJ |
| `body` | Sanitized HTML (same sanitizer as cells; may hold images and video cards) | `sanitize`; image conflicts rebuilt from `imageValue` | Composer; `conflictComment` | F (images inlined); R | `comments.ts` | Newer copy | Write-once atomic HTML (no edit command exists) | T11, T16, PROJ |
| `resolved` | Boolean | `false` | `toggleResolveCommand` | F; R | `comments.ts` | True if either | Coupled atomic group **resolution** (`resolved`, `resolvedBy`, `resolvedAt`), last writer wins (Decision 2) | T11, T21, PROJ |
| `resolvedBy`, `resolvedAt` | Name (≤ 80) and ISO, or `null` | Reset to `null` when unresolved | `toggleResolveCommand` | F; R (`resolvedBy`) | `comments.ts` | From the side whose resolve is newer | Group **resolution** | T11, PROJ |
| `assignee` | Name, at most 80, or `""` | `cappedText` | `setCommentAssigneeCommand` | F; R | `comments.ts` | Newer copy, else either side | Atomic, last writer wins | PROJ |
| `createdAt` | ISO or `null` | `stampOrNull` | Composer | F; R | `comments.ts` | Newer copy | Write-once | PROJ |
| `updatedAt` | ISO or `null` | Falls back to `createdAt` | Every comment command (reply, assign, resolve) | F only | `comments.ts` | Decides the newer copy | Proposed: derived (latest of the comment's own changes), not stored. Stage 1 found that reply times alone cannot reproduce an assignment or reopening time without a change history, so a round trip retains the loaded value ([projection results](../../../prototypes/collab/projection-results.md#mechanisms-and-departures-from-artifact-8)) | T11, PROJ |
| `kind` | `anchor` or `conflict` | `anchor` | Composer; `conflictComment` | F | `comments.ts` | Newer copy | Write-once | PROJ |
| `imageValue` | Image reference; only on `conflict` + `visualImage` | Rebuilt from the body's `data-blob`; deleted elsewhere | `conflictComment` | F (inlined into `body`); R | `src/core/merge/rows.ts` | Newer copy | Write-once (local merge is off in shared mode, so new ones only arrive in old files) | T16, PROJ |
| `conflictField`, `emptyValue`, `titleValue` | Label; boolean; the losing title | not normalized | `conflictComment` | F | `merge/rows.ts` | Newer copy | Write-once | PROJ |
| `replies[]` | Array of replies | `[]`; non-objects dropped | `addReplyCommand` | F; R | `comments.ts` | Union by id, sorted by `createdAt` | Set keyed by id; display order derived from `(createdAt, id)`; the id comparison must be total, since `localeCompare` treats distinct canonically equivalent ids as equal and leaves their order to map iteration ([reply history](../../../prototypes/collab/histories/T21-reply-collation-order.md)) | T11, PROJ |
| `replies[].id` | Clean id | Missing: `rp-load-…` | `ids.id("rp")` in the comments feature | F | `comments.ts` | Key | Set key | T11 |
| `replies[].author`, `.body`, `.createdAt` | Name; sanitized HTML; ISO or `null` | `plainName`, `sanitize`, `stampOrNull` | `addReplyCommand` | F; R | `comments.ts` | Theirs copy for the same id | Write-once | T11, PROJ |

## Person, tag record and shot

| Field (path) | Shape and allowed values | Default and normalization | Written by | Export | Owner today | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `people[].id` | Clean id | Missing: `p-load-…` | `addPerson` (`ids.id("p")`): manual add, owner pickers, owner sync | F | `records.ts` | Union by id and name | Set key | PROJ |
| `people[].name` | Plain text, at most 60; `addPerson` returns the existing person for a name already used ignoring case (`personNamed`) | `settledNames` caps it; a file with two equal names keeps both on load | `addPerson` (no rename command) | F; R | `records.ts` | Name decides duplicates | Write-once; uniqueness is a merged-state limit (Open question 5) | PROJ |
| `productionTags[].id` | `t_` + hash of `cat` and `name` at creation (`mintTagId`), `-n` on collision | `ensureTagIds` keeps a valid unique id and mints only missing or duplicate ones | `newRegistryTag`, `ensureTagIds`; `renameRegistryTag` keeps the id | F | `src/core/document/tags.ts` | Key (or `key:cat name`) | Set key, immutable after creation; after a rename it no longer matches the hash of the current key, so it cannot be derived (Open question 3) | T20, PROJ |
| `productionTags[].cat` | `prop`, `location`, `cast`, `vfx`, `sound`, `gear` | First category when invalid | Register, rename, update commands | F; R | `tags.ts` | Changed side wins | Coupled atomic group **tag-key** (`cat`, `name`) | T20, PROJ |
| `productionTags[].name` | Plain text, at most 80; commands keep it unique per category ignoring case | `settledNames` caps it but does not deduplicate; long sound cue names re-cut and the row spans retagged (`retagRenamedSounds`) | `renameRegistryTag` (also rewrites every span through `retagCommand`) | F; R | `tags.ts` | Changed side wins; duplicates folded by key | Group **tag-key** | T20, PROJ |
| `productionTags[].owner` | Person id or `""` | `""` unless the person exists | `updateTagsCommand`; owner sync from `@Name` (`applyOwnerSync`); person removal clears it | F; R (by name) | `src/core/production/owners.ts` | `mineOwnerWins` / `ownerGivesWay` | Atomic, last writer wins; the derived part is a repair (see below) | PROJ |
| `productionTags[].notes` | Plain text, at most 2000 | `cappedLongText` | `updateTagsCommand` | F; R | `tags.ts` | Non-empty wins | Atomic, last writer wins | PROJ |
| `productionTags[].status` | `needed`, `sourcing`, `have`, `returned` | First status when invalid | `updateTagsCommand` (cycles via `nextTagStatus`) | F; R | `tags.ts` | Highest rank wins | Changes made at the same time to different values leave the status as it was; the same value applies (Decision 1, decided) | PROJ |
| `brollShots[].id` | Clean id; equals the `data-broll-id` of its key in visual text | Missing: `bs-load-…` | `ids.id("bs")`: shot records, shot commands, paste, anchoring | F | `src/core/production/broll.ts` | Key | Set key, shared with the key atom | T06, PROJ |
| `brollShots[].name`, `.desc` | Plain text ≤ 200; ≤ 2000 | `settledNames`; `cappedLongText` | Shot records rename both from the key's line (`planBrollRecords`); shot edits | F; R | `broll.ts` | Theirs copy | Derived from the key line while the key exists; the stored value stays the source for `origin: "list"` shots and for orphaned script shots whose key is gone (`brollEntryFrom` falls back to `rec.name`, `rec.desc`) (Open question 2) | T06, T10, PROJ |
| `brollShots[].status` | `unshot` or `shot` | First status when invalid | Shot commands | F; R | `broll.ts` | `shot` wins | Changes made at the same time to different values leave the status as it was; the same value applies (Decision 1, decided) | PROJ |
| `brollShots[].reshoot` | Boolean | `=== true` | Shot commands | F; R | `broll.ts` | True if either | Atomic, last writer wins | PROJ |
| `brollShots[].notes`, `.audioRef`, `.location` | Plain text ≤ 2000, ≤ 2000, ≤ 80 | Capped; `audioRef` and `location` seeded from the beat on creation (`brollSeedOf`) | Shot commands; records | F; R | `broll.ts` | Non-empty wins | Atomic, last writer wins each | PROJ |
| `brollShots[].owner` | Person id or `""` | `""` unless the person exists | Shot commands; person removal | F; R | `records.ts` | `mineOwnerWins` | Atomic, last writer wins | PROJ |
| `brollShots[].origin` | `script` or `list` | `script` | Shot creation | F | `broll.ts` | Theirs copy | Write-once | PROJ |
| `brollShots[].props[]` | Up to 40 `{id, name}`; `id` a tag id or `""` | `normalizeBrollProps` against the registry | `addBrollProp`, `removeBrollProp`, tag rename (`renameBrollProps`) | F; R | `records.ts` | `mergeBrollProps` keyed by `brollPropKey` | Set keyed by `brollPropKey`; `name` derived from the registry when `id` names an existing entry; otherwise the stored `name` is kept (`normalizeBrollProps`), so it stays a stored fallback | T10, PROJ |

## Rich text inside cells

Stored as HTML; `decodeBody` (`src/adapters/richtext/decode.ts`) turns sanitized HTML into runs, `normalizeCell` (`src/core/text/runs.ts`) normalizes them, and `toHtml` (`src/core/text/html.ts`) writes them back. The sanitizer (`walkSanitize`, `src/adapters/richtext/sanitize.ts`) keeps only what is listed here and turns `DIV`/`P` into `<br>`, inline styles into formatting tags, and `b`, `i`, `strike`, `del` into canonical tags. Scene names hold no rich text.

**Merge today** in this table is `mergeCells` and `mergeMarks` (`src/core/merge/cells.ts`) under `mergeTextField`. Text is split into words, whitespace and atoms and aligned by LCS; a stretch changed on one side wins, the same change on both sides is kept, and any other overlap is a text conflict. Marks of unchanged tokens are merged per character and per mark key; a mark conflict keeps the partly merged cell (see the narration row).

| Item | Stored as | Run form and normalization | Where it may appear | Written by | Export | Merge today | Provisional shared policy | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Characters and line breaks | Text nodes; `<br>` | `text` with `"\n"`; control chars, U+200B, U+FFFC and lone surrogates removed (`cellChars`) | Narration, visual, comment and reply bodies | Typing and every text command | F; R | Word-level LCS; overlapping changes, a one-sided nesting change inside a changed stretch (`nestingChanged`) or an LCS over 4,000,000 cells: text conflict, theirs kept | Character-level text | T01–T05, T09, PROJ |
| Bold, italic, underline, strike, highlight | `<strong>`, `<em>`, `<u>`, `<s>`, `<mark>` | `b`, `i`, `u`, `s`, `hl` = `true` | Narration, visual, bodies; also on atoms | `toggleMark` | F; R | Per character and mark: the side that changed it wins; never a conflict | Character-level text with a formatting attribute | T09, T21, PROJ |
| Link | `<a href target rel>` | `href` value (`safeHref`: http, https, mailto); split around video cards (`splitLinkAround`); across a tag stretch the first `href` wins | Narration, visual, bodies; on atoms except video | Paste, link command | F; R | Per character, keyed by `href=` value: changed side wins; two different surviving values: mark conflict, theirs kept | Unresolved: a link has identity in plan section 5 (Open question 3) | T09, T20, T21, PROJ |
| Comment mark | `<span class="cmt-anchor" data-cmt>` | `cmt`: sorted, de-duplicated ids; ids without a comment removed when `hasComment` is given; a missing id is minted (`safeId(…, "c")`) | Narration and visual; on atoms | Composer, delete and unwrap, paste (cut-paste keeps it) | F; R (comment numbering) | Each comment id merged on its own per character (added or removed on one side wins); never a conflict | Set keyed by comment id: one attribute per comment id (plan section 5) | T11, T20, T21, PROJ |
| Tag | `<span class="tag-anchor" data-tag-cat data-tag-name contenteditable="false">`, nested for inner tags | `tag` (outermost) + `innerTags` (outer to inner): the per-character tag stack; ids resolved from `(cat, name)` through `registryTagHooks`; a tag stretch shares `cmt`, `href` and `dir` | Narration and visual; not on atoms | Tag commands (`tagCellsCommand`, `bulk-tags.ts`, `tag-rewrites.ts`), cue healing | F; R (production) | Single tag: like a link, keyed by `tag=`. Any side with `innerTags`: the whole stack, mine if theirs is unchanged, else theirs; both changed differently is a mark conflict | Unresolved (see "Marks with identity") | T20, T21, PROJ |
| Stage direction | `<span class="stage-dir">` | `dir: true`; spread across a tag stretch | Narration by design (`docs/DOCUMENT-MODEL.md` section 3); the code accepts either cell | Direction toggle (writer and table) | F; R (DOCX styles it; Markdown per preference) | Per character: changed side wins; never a conflict | Character-level text with a formatting attribute | PROJ |
| Audio cue | `<span class="audio-cue">` | `cue: true`; `settleCues` re-decides it per line from `SFX:` or `MUSIC:` when a line holds any cue | Narration and visual | Cue editing; cue lines also register sound tags | F; R (DOCX) | Per character: changed side wins; never a conflict | Unresolved: stored flag versus derived from the line (Open question 2) | PROJ |
| B-roll key | `<span class="broll-key" data-broll-id contenteditable="false">B-roll:</span>` | Atom `broll` with `id` and marker text matching `BROLL_MARKER_RE`; a missing id is minted (`safeId(…, "bs")`) | Visual (records read only visual); the sanitizer also keeps it in narration | Typing a marker + anchoring pass; paste (`freshBrollIds`) | F; R (shot numbers) | One token, keyed by its id, inside the text merge | Embedded atom with an id unique in the document | T06, T07, PROJ |
| `@Name` | `<span class="who-anchor" data-who contenteditable="false">@Name</span>` | Atom `who`, `name` ≤ 60, text `"@" + name` | Visual (owner sync reads visual only) | `insertWho` | F except Standalone HTML, which removes it (`withoutWho`); `htmlToMarkdown` also removes it | One token inside the text merge | Embedded atom, write-once | PROJ |
| Image | `<img class="comment-img" data-blob data-w data-h data-mime>`; the last three are absent for a hash-only reference | Atom `image` | Comment and reply bodies only; `migrateRows` moves any in a cell into a new comment | Comment composer | F (inlined); R | In a cell: the whole cell merges as one value (`mergeTextField`); in a body: with its comment | Part of the write-once body | T16, T17 |
| Video card | `<a class="video-embed-card" href>` + `vec-play`, `vec-host` spans | Atom `video` with `href`, `host` | Comment and reply bodies only; moved out of cells on load | Comment composer | F; R | Same as image | Part of the write-once body | T16 |

## Marks with identity: how nesting is stored today (T20)

| Mark | Identity in storage | Nesting and overlap | Enforcement today |
| --- | --- | --- | --- |
| Comment | `data-cmt` = comment `anchorId` | Overlap allowed: each character carries a set (`cmt`, sorted). `walkSanitize` peels a comment span off a tag, b-roll, who or direction span so the comment is outermost; a span that is both comment and cue, and carries none of the tag, b-roll, who or direction classes (`CUE_OUTRANKED`), is the exception, and there the comment goes inside the cue | INV-18: the mark is the anchor; INV-03: a comment covers all of a tag or none (`normalizeCell` spreads `cmt` over a tag stretch) |
| Tag | `(data-tag-cat, data-tag-name)`; the stored HTML carries no tag id | Strict nesting: each character carries a stack, `tag` then `innerTags`; a tag is wholly inside or outside another | INV-03 in the edit functions (`src/core/text/edits.ts`) and `normalizeCell`; the editor keeps the caret out (`contenteditable="false"`) |
| Link | The `href` value; no id | One `href` per character; the first wins across a tag stretch | `normalizeCell`; `splitLinkAround` |

A tag rename rewrites every span that uses the old name (`retagCommand`, `retagRenamedSounds`, `retagTagAnchors`), so in shared state a rename is a text rewrite in every cell, not one record change.

## Stored twice or derivable

| Value | Second copy or source | Kept in step by |
| --- | --- | --- |
| Comment `rowId` and `field` | Position of the `cmt` mark | `syncCommentAnchors` (load and every commit) |
| Comment `quotedText` | The anchored words at creation | Nothing; it goes stale by design |
| Comment `updatedAt` | Latest reply, assign or resolve time; reply times alone cannot reproduce an assignment or reopening time, so a round trip retains the loaded value ([projection results](../../../prototypes/collab/projection-results.md#mechanisms-and-departures-from-artifact-8)) | Each comment command |
| Tag registry entries and names | Tag spans `(cat, name)` in cells | `missingRegistryTags` (load), tag records at commit (`recordsPlan`), retag on rename |
| Tag `owner` and new `people` | `@Name` pairs in visual text | `planOwnerSync` / `applyOwnerSync` at commit |
| Sound tags | `SFX:` / `MUSIC:` cue lines | Cue healing in the production index (`HealingPlan`) |
| Shot record `id`, `name`, `desc` | B-roll key atom and its line, while the key exists; the stored values remain for `origin: "list"` and orphaned shots (`brollEntryFrom`) | `planBrollRecords` (load and commit), anchoring pass |
| Shot prop `name` | Registry entry with that id, when it exists; else the stored name | `normalizeBrollProps`, `renameBrollProps` |
| `sections[].firstSceneId` and membership | Row order | `writeScenes`, `scenesAfterRemoval`, flow |
| Paragraph start at index 0 and at scene anchors | Position | `startsParagraph` treats them as starts whatever the flag; `paragraphFlagsAfterOrder` keeps the flag on implicit rows |
| `paragraphsDecided` + sentence-based flags | Narration sentences | `initializeFlowParagraphs` |
| Gallery first slot | Split across `imageRef`, `imageName`, `imageAnnotation`, `imageLinks`; the rest in `moreImages`; file attachments of every slot hoisted into `imageLinks` | `setRowSlots`, `rowSlots`, `migrateGallery` |
| Annotated picture | Slot `imageRef` is the flattened render of `annotation.imageRef` + marks | `annotateGallerySlot` |
| `@Name` atom text | `"@" + name` | `whoRun` |
| `title` with `titleOrigin: "file"` | The file name | `fileTitleChange` on save |
| `updatedAt`/`updatedBy`, `rev`, `lastEdited*`, `personColors` | Edit and save history | Stamps (next section) |

## Edit stamps and counters

| Field | Written by | When |
| --- | --- | --- |
| `rows[].updatedAt`, `rows[].updatedBy` | Row commands: `cell-text.ts`, `split-join.ts`, `beat-status.ts`, `beat-length.ts`, `gallery.ts`, `clipboard.ts`, `document-edit.ts`, `import-rows.ts`, `restoreConflictCommand`; `mergeRows`; `src/application/session/session-merge.ts` | In the same command as the edit, so on every committed text edit of that beat |
| `comments[].updatedAt` | `addReplyCommand`, `setCommentAssigneeCommand`, `toggleResolveCommand` | Each comment command |
| `rev`, `lastEditedBy`, `lastEditedAt` | `editStamp` from `confirmWrite` (`save-completion.ts`) | After a file or autosave write is confirmed; `rev` comes from the captured document |
| `personColors` | `attribute` (`session-owner.ts`) → `myColorPlan` (`session-effects.ts`) | At every `transact` and absorbed settle, but it writes only when the author's color is missing or different |
| `docId` | `documentIdStamp` | Save As fork; duplicate-id reassignment |

## Writes into the document outside a user command

### Commit-time steps (`transact` in `src/application/session/document-session.ts`; records only for kind `edit`, anchors when `needsReconciliation`)

| Step | Location | Writes |
| --- | --- | --- |
| Attribution | `ports.attribution.attribute` → `myColorPlan` (`src/application/save/session-effects.ts`) | `personColors` |
| Tag and shot records from text | `withRecords` → `createRecordsReconciler` (`src/application/production/broll-records.ts`): `recordsPlan` (production index), `planBrollRecords`, `planOwnerSync` | `productionTags` (new entries, cue retitles, owners), `brollShots` (create, rename), `people` (new from `@Name`); mints `bs` and `p` ids |
| Comment anchor repair | `ports.reconcile.anchors` → `syncCommentAnchors` (`src/core/text/anchors.ts`) | `comments[].rowId`, `comments[].field` |

### INV-54 re-keying

`anchorBrollInRows` (`src/adapters/production/broll-anchors.ts`) with the plan from `planBrollAnchors` (`src/core/production/broll.ts`). `collectBrollFromRows` blanks the id of every repeat of a key id, and the plan gives it a matched record's id or a new `ids.id("bs")`, rewriting `visualText`. Called from `src/bootstrap/wiring/broll.ts` and `src/bootstrap/wiring/ports/imports.ts`. Paste gives a known key a new id first (`freshBrollIds` in `src/features/clipboard/cell-clipboard.ts` and `src/application/commands/clipboard.ts`).

### Load-time repairs (`migrateRows`), all writing into the document

Defaults for the eight `STATE_FIELDS` with a `def`; row ids minted and duplicates suffixed; `status`, `lengthSeconds`, `paragraphStart` normalized; both cells sanitized (minting missing `data-cmt` and `data-broll-id`) or converted from legacy Markdown; `visualImage` interned; gallery normalized (`migrateGallery`); `updatedAt`/`updatedBy` defaulted; cell images and video cards moved into new comments (`moveMediaOutOfCell`, ids by `mediaCommentId`); comment, reply, person and shot ids minted; comment fields coerced; `syncCommentAnchors`; people names settled and nameless dropped; tag registry rebuilt when absent, categories, names, status, owner and notes normalized, long sound names re-cut with the spans in row HTML retagged (`retagRenamedSounds`), missing entries added, ids minted (`ensureTagIds`); shot fields normalized and records planned (`planBrollRecords`); all `STATE_FIELDS` normalizers; `title` capped; `sections` re-sorted and pruned; `docId` minted or derived; `schema` set to 2.

### Other repairs

| Repair | Location | Writes |
| --- | --- | --- |
| Paragraph initialization when the writer first opens a script | `initializeFlowParagraphs` (`src/application/commands/flow.ts`), run by `liveSession().amend` in `src/bootstrap/wiring/writer.ts` | `rows[].paragraphStart`, `paragraphsDecided` |
| Duplicate document id between open scripts | `src/application/identity/document-identity.ts` → `documentIdStamp` | `docId` |
| Save stamps | `save-completion.ts` (`editStamp`, `documentIdStamp`), `file-saving.ts` (`fileTitleChange`) | `rev`, `lastEdited*`, `docId`, `title`, `titleOrigin`, `titleVersion` |

The plan forbids projection repairs that write into shared state (section 4, "Undo and rendering"). Each step above becomes a pure derivation or an explicit validated command in shared mode.

## Id-minting sites

| Record | Format | Sites |
| --- | --- | --- |
| Beat | `makeId("r")`: prefix + 7 random base-36 chars + time (`src/adapters/identity/ids.ts`) | Flow (`ports.newId()`), `src/features/rows/beats.ts`, new tab, file menu, writer wiring, flow paste (`flow-clip.ts` re-ids copies), import |
| Scene | `makeId` (`ports.newId()`), or `ids.id("section")` | Flow promote and paste; `scene-controls.ts` |
| Comment | `ids.id("c")`; `safeId(…, "c")` in the sanitizer; `mediaCommentId` (deterministic hash) | Composer, writer, sanitizer, `migrateRows`, `conflictComment` |
| Reply | `ids.id("rp")` | Comments feature |
| Person | `ids.id("p")` | `addPerson` (manual and owner sync) |
| Tag | `mintTagId`: hash of `(cat, name)` at creation, `-n` on collision; kept unchanged by rename | `newRegistryTag`, `ensureTagIds` (missing or duplicate ids only) |
| Shot and b-roll key | `ids.id("bs")`; `safeId(…, "bs")` | Records, shot commands, paste, anchoring, sanitizer |
| Any record on load | `<prefix>-load-<sha of canonical source>-<n>` (`createLoadIds`): the same source gives the same ids | `migrateRows` |
| Document | `mintDocId` (random); `deriveDocId` (file seed, server id); duplicate replacement (`duplicateReplacementInput`) | Load, Save As, identity |

## Structural rules a merged state can break

| Rule | Where it is enforced today |
| --- | --- |
| A scene with no beat | `scenesAfterRemoval` moves the header to the first remaining beat or drops it; `scenesInOrder` and `normalizeScenes` drop headers whose anchor is missing (load); `mergeSceneLayout` leaves an empty group headerless (`sections.md`) |
| A script with no beats | Not prevented: `removeBeatsCommand` (`src/application/commands/beats.ts`) can remove every beat and `migrateRows` accepts `rows: []`; flow range replacement inserts a blank beat when nothing remains (`flow.ts`) |
| Paragraph flags | `paragraphFlagsAfterOrder` on delete and move; flow split and join; `startsParagraph` treats index 0 and scene anchors as starts |
| Duplicate b-roll key ids (INV-54) | `freshBrollIds` on paste; the anchoring re-key pass (above) |
| A mark spanning two beats | Each beat's cells are separate HTML, so no mark element crosses a beat. A comment id can occur in more than one cell, and `syncCommentAnchors` takes the first in row order. Flow joins carry a comment or link over the glue space only when both sides have it (`joinCells`) |
| Cross-header join | `flow.ts` refuses ("A beat can't join across a scene header.") |
| Gallery overflow | `MAX_MORE` (60) in `migrateGallery`; flow join refuses above 61 pictures |
| Missing owner | `migrateRows` clears owners that name no person; `removePerson` clears them |
| Deleted tag still marked in text | `missingRegistryTags` re-adds the registry entry on load and at commit |

## Persisted state that is not part of the document

All local-only, not shared.

| State | Store |
| --- | --- |
| Preferences (theme, author name, my color, sort, autosave, prompter, sizes and about 30 more) | localStorage `splitpage-*` keys in `src/application/preferences/preferences.ts`; panel widths in `panel-widths.ts` |
| Drafts | Desktop `userData/drafts` (`desktop/drafts.ts`, `session.json`); browser web storage through `src/bootstrap/wiring/drafts.ts` |
| History snapshots | IndexedDB `splitpage-history` (`03c-history-idb.ts`); desktop `userData/history` (`history-fs-backend.ts`); legacy localStorage `splitpage-snapshots` |
| Image bytes | IndexedDB `splitpage-blobs` (`blob-store.ts`); desktop `userData/blobs` |
| Conflict stash | localStorage `splitpage-conflict-stash`, `splitpage-conflict-reloaded` |
| Known document ids (duplicate detection) | `splitpage-doc-ids` (`document-identity.ts`) |
| Last file handle | IndexedDB `splitpage-files` (`src/adapters/files/last-file.ts`) |
| Cut-paste clipboard for beats and scenes | `splitpage-flow`, `splitpage-scenes` (clipboard feature) |
| Recent commands, last export, import scans, find state, open tag, prompter launch and voice, seed check, version | `splitpage-recent-commands`, `splitpage-last-export`, `splitpage-import-scans`, `splitpage-find-match`, `splitpage-present-matches`, `splitpage-open-tag-*`, `splitpage-prompter-*`, `splitpage-seed-check`, `splitpage-version` |
| App-data bundle | `splitpage-app-data` (`src/features/settings/app-data.ts`) |
| Desktop window, tabs, recents, theme, updates | `userData/desktop-state.json`, `desktop/recents.ts`, `desktop/session-restore.ts`, `theme.json`, `userData/updates` |
| Scene folding | Per-session view state, not saved (`sections.md`) |

## Validation

- Field list from the TypeScript types in `src/core/document/` (`validated.ts`, `fields.ts`, `gallery.ts`, `scenes.ts`, `broll.ts`, `tags.ts`, `media.ts`), `src/core/text/runs.ts` and `src/core/production/`.
- Normalization from `migrateRows`/`migrateDocument`, `walkSanitize`, `decodeBody`, `normalizeCell` and `toHtml`; merge rules from `src/core/merge/` and `src/core/document/gallery.ts`; scene rules from `docs/architecture/sections.md`.
- A throwaway script walked every `.json` and `.splitpage` under `src/test/fixtures`, `src/starters` and `tests` (146 files, 288 document objects). It printed every key path below a document and every HTML tag, attribute and class in `visualText`, `audioText` and `body`. Every path it found is in a table above, including `comments[].conflictField`, `emptyValue`, `titleValue`, `rows[].visualImage` and the unknown-key passthrough. Gaps the fixtures do not cover and that came from code only: `links[].location`, `who-anchor`, `rows[].paragraphStart`.
- Image references from `refsIn()` and `normalizeImageRef` in `shared/blob-policy.ts`; on-disk shapes from `inlineStateImages`.
- The file has no relative links; paths are cited as code.

## Open questions

1. **Edit stamps** (`updatedAt`, `updatedBy`, `rev`, `lastEditedBy`, `lastEditedAt`, `personColors`): plan section 5 requires a decision before schema selection. Row stamps are written by every text command today. Experiment (PERF, in the 1a model): measure update bytes and count per keystroke with row stamps as shared fields, against stamps derived from update metadata. `rev` and `lastEdited*` have no save moment in a shared script: settle with T22 and T23 whether a receipt sequence can stand in for `rev`.
2. **Derived production records**: shot `name` and `desc`, the `cue` flag, sound tags and tag owners are recomputed from text at commit. Experiment (PROJ): derive them in the projection only, and round-trip every golden fixture through the projection. A differing byte shows which ones need a stored value. Known fallbacks already need one: shots with `origin: "list"`, script shots whose key was deleted (T10: delete, then undo, must bring back the same name and desc), and shot props whose tag id has no registry entry. Stage 1 result for the `cue` flag: line-only derivation is refuted (a flag is invented on an unmarked `SFX:` line and a mid-line cue is lost), so the stored flag is required; the corpus round-trips with it apart from the exact device-local exclusion ([lossless projection results](../../../prototypes/collab/src/proj/lossless-results.md#literal-device-local-exclusion)). The first failed round-trip histories are superseded by that report ([initial histories](../../../prototypes/collab/histories/PROJ-roundtrip-A.md), [cue hypothesis](../../../prototypes/collab/projection-results.md#cue-hypothesis)).
3. **Tag and link representation (T20)**: stored tag spans carry `(cat, name)`, not the registry id, and a rename rewrites all cells while the registry entry keeps its id. The id is hashed from the key only at creation, and the `-n` collision suffix depends on the local registry, so two replicas that create the same key concurrently can mint different ids. Experiment T20: concurrent tag edits, a rename against a concurrent tag insertion, and a link across part of a tag, under one attribute per tag occurrence and under an anchored-range alternative.
4. **Detached comments**: where `rowId` and `field` live once they are derived from marks, for a comment whose mark is gone, and for media comments, which have no mark. Experiment T11 with deletion of the anchored text and recovery.
5. **Merged-state limits**: unique person names, unique tag keys per category, 61 pictures (the first slot plus the 60 of `moreImages`, `MAX_MORE` in `src/core/document/gallery.ts`), 40 props, one poster per link list and one header per beat can each be broken by two valid concurrent operations. Experiment PROJ: fuzz pairs of valid operations and record the projection's deterministic answer for each limit. Stage 1 result: a merged gallery reaches 62 pictures; the projection returns all 62 with no recovery entry, and the app's export keeps the first 61 and drops the last ([merged-state limits](../../../prototypes/collab/projection-results.md#merged-state-limits)).
6. **Unknown keys**: `migrateRows` keeps them; a shared schema must store them opaquely or drop them with a recorded difference. Experiment PROJ/T18: round-trip the fixture holding `unknownField` through each candidate.
7. Random beat ids from `makeId` use `Math.random` with 7 base-36 characters plus time. Two replicas colliding is unlikely but not excluded, and the plan forbids duplicate identities. T05 and T06 should create beats on several replicas in the same millisecond.
8. **Gallery slot identity**: `galleryItemKey` is the picture's sha256, or `"v:"` plus the poster link's key for a video slot without a thumbnail. `setVideoThumbnail`, `annotateGallerySlot` and `replaceGalleryPicture` change it, so a concurrent edit to the same slot reads as a removal plus an addition. Candidate: a slot id minted at insertion. Experiment PROJ/T06/T16: a thumbnail arriving, an annotation and a picture replacement each against a concurrent link edit or reorder of the same slot, under the content key and under a slot id.

## Decisions for Adam

1. **Status after concurrent changes** (beat Filmed, tag status, shot status): today's merge keeps the highest. If one person sets a beat back to To do while another marks it Filmed, which wins? Decided 2026-11-09: neither. Two changes made at the same time to different values leave the status as it was before both, and the person who wants the change makes it again; two changes to the same value apply. A change by someone who has already seen the other change applies as usual. The standalone file merge keeps its rule.
2. **Resolve against reopen**: today a comment resolved on either side stays resolved. Decided 2026-11-09: the last resolve or reopen wins.

## Doc mismatches

- `docs/DOCUMENT-MODEL.md` section 6 still says tag spans carry `data-tag-id`; section 3.1 already matches the code (ids only in the registry, kept on rename; spans write only `data-tag-cat` and `data-tag-name`).
- `docs/DOCUMENT-MODEL.md` section 3 says `dir` belongs to the Audio column; the sanitizer and `cleanMarks` accept it in either cell.
