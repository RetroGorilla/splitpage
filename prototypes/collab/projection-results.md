# Full-document projection experiment results

Integration finding fixed in this PR: a new probe found #1392 reused imported tag/link occurrence counters across different fields under both candidates (one identity instead of three). Hydration now namespaces those occurrence keys by origin row and field; the same probe passes after encoded transfer. Existing main at e5b3306a (#1391 plus #1392) passed all 876 pre-existing prototype tests and the 291-fixture app-reference check before this work. This follow-up also makes every projection document use the initialized replica constructor, including receiving and late-joining documents. No established expected trace result changed.

## Result

The field inventory has **96 rows**. All 96 have locations below, checked against the inventory text. No inventory document was changed.

| Candidate | Documents | Original bytes identical | Same bytes as direct app save | Projection-only differences |
| --- | ---: | ---: | ---: | ---: |
| A | 291 | 7 | 286 | 5 |
| B | 291 | 7 | 286 | 5 |

The source bytes are the oracle. `.splitpage` files are read verbatim, including whitespace; JSON fixture subdocuments are rendered with the app's two-space JSON convention before loading. They are not represented as byte goldens the repository never had. Every source path and subdocument is listed below.

[`src/proj/results.json`](src/proj/results.json) records every exact changed JSON path with before/after values, all direct-save normalizations and the first differing UTF-8 byte with its surrounding text. A byte difference with no JSON value difference is formatting or key order. These results do not waive the byte-identical requirement.

## Mechanisms and departures from artifact 8

- A uses the exported SchemaReplica's document with one flow Y.Text and boundary embeds. B uses segments with head fields and one order array. Both use separate visual components, gallery slots, comment/reply maps and ranked registries. No file in the other lane was changed.
- Both preserve import key order in record keys arrays. This is required by the JSON serializer's byte contract; these arrays contain names, never duplicate field values. Unknown data lives only in each record's extra JSON string. defineProperty retains every key during assembly; JSON string encoding avoids both Yjs constructor dispatch and unsafe object-key decoding for arbitrary names.
- Legacy rev, lastEditedAt, lastEditedBy and personColors live in meta.capture. The proposed absence/export regeneration and deriving personColors from people cannot reproduce a historical capture. This is import/export evidence, not a shared edit-stamp policy.
- Comment updatedAt is retained; deriving it from replies cannot reproduce an assignment or reopening timestamp without a change history. Comments keep load rowId/field as fallback; live marks determine the projected anchor and the explicit mark-move command records its new fallback. The concurrent detachment scope is below.
- Comment bodies/replies are atomic sanitized HTML, as the shared-layer write-once body contract specifies. Resolution is one atomic group. Reply keys include commentId to avoid cross-comment id collisions; import rank retains file order rather than sorting existing replies by time.
- Gallery picture data is one coupled JSON value (imageRef, name, annotation); slot identity is minted from origin row and import index, never from content. Links are keyed by the existing href/name/size key. Location stays device-local and is excluded from Yjs; a Yjs-only transfer cannot carry it. Blob bytes also remain external; encoded Yjs sizes exclude them. This corpus carries references, not a successful available-blob byte transfer.
- B-roll embeds retain a label in addition to k because the format accepts marker spelling/case variants. Who embeds retain w. Text attributes use one c:commentId, t:occurrenceId and l:occurrenceId per mark; tag registry ids resolve back to names on export. Rich-text decoding is a bounded prototype parser for already-sanitized app documents, not a replacement sanitizer.
- No joins, soft removals, structural recovery or conflicting status semantics are claimed by this full-document layout. Existing trace lanes own those mechanisms. Shot props now form a map keyed by brollPropKey, with atomic value/rank per member, so independent additions can exceed the format limit without overwriting each other.

## Hypotheses

| Hypothesis | Evidence in PR 1 |
| --- | --- |
| A-H10 | Refuted as byte-identical for both candidates: projection-only changes listed below, even against a direct app save. Most raw legacy/merge inputs also undergo app migration or JSON formatting. |
| PROJ-cue | Refuted as fully byte-identical with this writer: one stored mid-line cue is removed. Stored/derived comparison covers all six cue-bearing fixtures; the literal unmarked-line test proves line text cannot generally derive the flag. test/proj/cues.test.ts. |
| PROJ-detached | Confirmed for the specified delete-versus-explicit-mark-move scenario with stored fallback, both candidates, D1/dup/rev/late-C and swapped ids. Media null anchor/load location retained; several simultaneous movers remain unproved. test/proj/concurrency.test.ts. |
| PROJ-unknown | Confirmed for encoded transfer and concurrent known-field edits on all seven record kinds, including special-key payloads. Concurrent editing of extra JSON itself is not established. test/proj/review.test.ts and concurrency.test.ts. |

Tests: `test/proj/projection.test.ts`. Every candidate has 96 generated missing-mapping declaration checks, independently compared with artifact 2. They do not mutate transport and do not prove it. Behavioral protection is the full exact fixture equality test, the unknown-record transfer test and the explicit titleVersion/paragraphStart/shot-props and highlight-annotation transport tests. A separate deliberate lengthSeconds deletion fails equality with literal R1 lengthSeconds:12.

## Opaque values and limits of this evidence

Both candidates carry the same opaque values: meta.capture (rev, lastEditedBy, lastEditedAt, personColors); beat stamp (updatedBy, updatedAt); gallery picture groups (imageRef, name, annotation, including annotation.imageRef and the full marks/points array); each record's extra JSON string; gallery extra JSON string; comment resolution group (resolved, resolvedAt, resolvedBy); comment imageValue; each shot-prop member's id/name value; comment and reply body HTML. Prop membership is a keyed set with rank, not one opaque array. Quoted text is a stored immutable snapshot. Import key-order arrays and Candidate B segment heads are atomic metadata; b-roll/who and structural embeds are atomic objects. All other named scalar fields are individual map entries, and text/mark attributes are represented separately.

A successful round trip proves these opaque values can be stored and recovered. It says nothing about concurrent edits inside picture/annotation groups, one prop member, color maps, capture/stamp/resolution groups, unknown JSON or body HTML. Their merge granularity is the whole value, and no fine-grained merge claim is made. Highlight marks are exercised by the supplement and a literal marks-array equality test.

## Projection-only differences

| Candidate | Fixture | Paths |
| --- | --- | --- |
| A | merge-text-unicode-and-atoms.json/inputs/base | $.rows.3.visualText |
| A | merge-text-unicode-and-atoms.json/inputs/mine | $.rows.3.visualText |
| A | merge-text-unicode-and-atoms.json/inputs/theirs | $.rows.3.visualText |
| A | migrate-golden.json/scenarios/media in cells/output | $.rows.1.audioText |
| A | supplement.splitpage | $.rows.0.imageLinks.0.location, $.rows.0.imageLinks.1.location |
| B | merge-text-unicode-and-atoms.json/inputs/base | $.rows.3.visualText |
| B | merge-text-unicode-and-atoms.json/inputs/mine | $.rows.3.visualText |
| B | merge-text-unicode-and-atoms.json/inputs/theirs | $.rows.3.visualText |
| B | migrate-golden.json/scenarios/media in cells/output | $.rows.1.audioText |
| B | supplement.splitpage | $.rows.0.imageLinks.0.location, $.rows.0.imageLinks.1.location |

The unicode-and-atoms fixtures lose a U+200B inside visual text: normalizeCell removes it, while direct migrate/save keeps it. The media-in-cells output loses an audio-cue span on a mid-line SFX fragment: settleCues removes that flag, while direct save retains it. The supplement loses two local link locations, deliberately excluded from shared state by the proposed layout. These are projection differences, not normalizations the app's save applies. The exact strings are in results.json and the minimized histories are histories/PROJ-roundtrip-A.md and histories/PROJ-roundtrip-B.md.

## Fixture selection

The two immutable v0.3.0 files exercise actual historical on-disk input. Seed plus all starters include the long demo, script formatting, tags, galleries, comments and production lists used by exports-golden. Every complete document under merge goldens exercises input/base/mine/theirs and expected output states, including conflict cards, stamps, ids, ordering, gallery links and sections. Every migrate-golden output exercises the app's already-normalized shapes, including images, annotations and unknown keys. Non-document arrays and hash-only export summaries are not mistaken for full documents.

test/proj/supplement.splitpage covers who-anchor, stored paragraph flags, path/bundled locations, hash-only body images, highlight annotations and unknown keys on nested record kinds. Existing fixtures cover full image references and pen/text annotations. The local-location loss is asserted as literal before-values with no after-value. The supplement is not silently normalized to become byte-identical.

Review fixtures add the previously missing values A > B and Mira > Nia in quoted attributes, with literal expected complete file bytes. attribute-cases.splitpage checks literal less-than, ampersand, double and single quotes, literal entity text, numeric entities, supplementary Unicode, nonbreaking whitespace and an allowed HTTP href containing quoted-attribute metacharacters. The sanitizer's outputs are checked against literal expected HTML before projection, then again after encoded transfer. special-keys.splitpage checks __proto__, constructor and prototype on documents, rows, comments, replies, people, tags and shots. Those four regressions failed under both candidates before their fixes. No established trace oracle was changed.

The sole permitted non-prototype addition is tools/projection-reference.mjs and its tool test. Run `node tools/projection-reference.mjs --write` at the repository root to generate test/proj/app-reference.json from the actual parseSplitpageFile, migrateDocument(file), migrateRows and buildSplitpageFile. Each entry has source and saved byte lengths/SHA-256, the normalized input document, and full saved bytes only when the app save differs from the source. `--check` regenerates and compares the manifest; the tool test checks both a current and deliberately stale manifest. Tools may import the app under the dependency gate; the prototype may not. The prototype no longer imports or launches bootstrap, adapters, a DOM shim or a subprocess, and its tests need only its own npm ci.

The prototype serializer accepts those validated plain documents and performs JSON file encoding, including null imageRef to visualImage. Before every experiment it must match the independent app manifest byte length and SHA-256 on every normalized source; otherwise the experiment fails. Projected bytes are compared independently with the app manifest and the original source. This is not evidence for input sanitization, migration of arbitrary merged states, or resolution of available blob bytes.

## Per-fixture byte results

| Candidate | Fixture | Original bytes identical | Direct app save identical | Projection equals app save |
| --- | --- | --- | --- | --- |
| A | splitpage-0.3.0-seed.splitpage | no | no | yes |
| A | splitpage-0.3.0-spot.splitpage | no | no | yes |
| A | src/seed-state.json | no | no | yes |
| A | src/starters/interview.json | no | no | yes |
| A | src/starters/long-demo.json | no | no | yes |
| A | src/starters/thirty-second-spot.json | no | no | yes |
| A | src/starters/to-camera.json | no | no | yes |
| A | merge-broll-props-edges.json/inputs/base | no | no | yes |
| A | merge-broll-props-edges.json/inputs/mine | no | no | yes |
| A | merge-broll-props-edges.json/inputs/theirs | no | no | yes |
| A | merge-broll-props-edges.json/merged | no | no | yes |
| A | merge-broll-shots-each-side.json/inputs/base | no | no | yes |
| A | merge-broll-shots-each-side.json/inputs/mine | no | no | yes |
| A | merge-broll-shots-each-side.json/inputs/theirs | no | no | yes |
| A | merge-broll-shots-each-side.json/merged | no | no | yes |
| A | merge-comments-anchor-moved.json/inputs/base | no | no | yes |
| A | merge-comments-anchor-moved.json/inputs/mine | no | no | yes |
| A | merge-comments-anchor-moved.json/inputs/theirs | no | no | yes |
| A | merge-comments-anchor-moved.json/merged | no | no | yes |
| A | merge-comments-deleted-and-added.json/inputs/base | no | no | yes |
| A | merge-comments-deleted-and-added.json/inputs/mine | no | no | yes |
| A | merge-comments-deleted-and-added.json/inputs/theirs | no | no | yes |
| A | merge-comments-deleted-and-added.json/merged | no | no | yes |
| A | merge-comments-edited-both-sides.json/inputs/base | no | no | yes |
| A | merge-comments-edited-both-sides.json/inputs/mine | no | no | yes |
| A | merge-comments-edited-both-sides.json/inputs/theirs | no | no | yes |
| A | merge-comments-edited-both-sides.json/merged | no | no | yes |
| A | merge-comments-no-base.json/inputs/mine | no | no | yes |
| A | merge-comments-no-base.json/inputs/theirs | no | no | yes |
| A | merge-comments-no-base.json/merged | no | no | yes |
| A | merge-doc-id-both-changed.json/inputs/base | no | no | yes |
| A | merge-doc-id-both-changed.json/inputs/mine | no | no | yes |
| A | merge-doc-id-both-changed.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-both-changed.json/merged | no | no | yes |
| A | merge-doc-id-mine-changed.json/inputs/base | no | no | yes |
| A | merge-doc-id-mine-changed.json/inputs/mine | no | no | yes |
| A | merge-doc-id-mine-changed.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-mine-changed.json/merged | no | no | yes |
| A | merge-doc-id-neither-readable.json/inputs/base | no | no | yes |
| A | merge-doc-id-neither-readable.json/inputs/mine | no | no | yes |
| A | merge-doc-id-neither-readable.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-neither-readable.json/merged | no | no | yes |
| A | merge-doc-id-no-base.json/inputs/mine | no | no | yes |
| A | merge-doc-id-no-base.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-no-base.json/merged | no | no | yes |
| A | merge-doc-id-theirs-changed.json/inputs/base | no | no | yes |
| A | merge-doc-id-theirs-changed.json/inputs/mine | no | no | yes |
| A | merge-doc-id-theirs-changed.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-theirs-changed.json/merged | no | no | yes |
| A | merge-doc-id-theirs-unreadable.json/inputs/base | no | no | yes |
| A | merge-doc-id-theirs-unreadable.json/inputs/mine | no | no | yes |
| A | merge-doc-id-theirs-unreadable.json/inputs/theirs | no | no | yes |
| A | merge-doc-id-theirs-unreadable.json/merged | no | no | yes |
| A | merge-editor-anonymous.json/inputs/base | no | no | yes |
| A | merge-editor-anonymous.json/inputs/mine | no | no | yes |
| A | merge-editor-anonymous.json/inputs/theirs | no | no | yes |
| A | merge-editor-anonymous.json/merged | no | no | yes |
| A | merge-file-title-mine-only.json/inputs/base | no | no | yes |
| A | merge-file-title-mine-only.json/inputs/mine | no | no | yes |
| A | merge-file-title-mine-only.json/inputs/theirs | no | no | yes |
| A | merge-file-title-mine-only.json/merged | no | no | yes |
| A | merge-file-title-theirs-only.json/inputs/base | no | no | yes |
| A | merge-file-title-theirs-only.json/inputs/mine | no | no | yes |
| A | merge-file-title-theirs-only.json/inputs/theirs | no | no | yes |
| A | merge-file-title-theirs-only.json/merged | no | no | yes |
| A | merge-last-edited-only-mine-knows.json/inputs/base | no | no | yes |
| A | merge-last-edited-only-mine-knows.json/inputs/mine | no | no | yes |
| A | merge-last-edited-only-mine-knows.json/inputs/theirs | no | no | yes |
| A | merge-last-edited-only-mine-knows.json/merged | no | no | yes |
| A | merge-paragraphs-decided-both.json/inputs/base | no | no | yes |
| A | merge-paragraphs-decided-both.json/inputs/mine | no | no | yes |
| A | merge-paragraphs-decided-both.json/inputs/theirs | no | no | yes |
| A | merge-paragraphs-decided-both.json/merged | no | no | yes |
| A | merge-people-each-side.json/inputs/base | no | no | yes |
| A | merge-people-each-side.json/inputs/mine | no | no | yes |
| A | merge-people-each-side.json/inputs/theirs | no | no | yes |
| A | merge-people-each-side.json/merged | no | no | yes |
| A | merge-person-colors-both-changed-one-name.json/inputs/base | no | no | yes |
| A | merge-person-colors-both-changed-one-name.json/inputs/mine | no | no | yes |
| A | merge-person-colors-both-changed-one-name.json/inputs/theirs | no | no | yes |
| A | merge-person-colors-both-changed-one-name.json/merged | no | no | yes |
| A | merge-person-colors-each-side.json/inputs/base | no | no | yes |
| A | merge-person-colors-each-side.json/inputs/mine | no | no | yes |
| A | merge-person-colors-each-side.json/inputs/theirs | no | no | yes |
| A | merge-person-colors-each-side.json/merged | no | no | yes |
| A | merge-person-colors-removed-both-sides.json/inputs/base | no | no | yes |
| A | merge-person-colors-removed-both-sides.json/inputs/mine | no | no | yes |
| A | merge-person-colors-removed-both-sides.json/inputs/theirs | no | no | yes |
| A | merge-person-colors-removed-both-sides.json/merged | no | no | yes |
| A | merge-person-colors-theirs-only.json/inputs/base | no | no | yes |
| A | merge-person-colors-theirs-only.json/inputs/mine | no | no | yes |
| A | merge-person-colors-theirs-only.json/inputs/theirs | no | no | yes |
| A | merge-person-colors-theirs-only.json/merged | no | no | yes |
| A | merge-production-tags-each-side.json/inputs/base | no | no | yes |
| A | merge-production-tags-each-side.json/inputs/mine | no | no | yes |
| A | merge-production-tags-each-side.json/inputs/theirs | no | no | yes |
| A | merge-production-tags-each-side.json/merged | no | no | yes |
| A | merge-production-tags-no-base.json/inputs/mine | no | no | yes |
| A | merge-production-tags-no-base.json/inputs/theirs | no | no | yes |
| A | merge-production-tags-no-base.json/merged | no | no | yes |
| A | merge-prototype-ids-comments.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-comments.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-comments.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-comments.json/merged | no | no | yes |
| A | merge-prototype-ids-people.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-people.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-people.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-people.json/merged | no | no | yes |
| A | merge-prototype-ids-rows-added-on-each-side.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-rows-added-on-each-side.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-rows-added-on-each-side.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-rows-added-on-each-side.json/merged | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-mine.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-mine.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-mine.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-mine.json/merged | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-rows-deleted-by-theirs.json/merged | no | no | yes |
| A | merge-prototype-ids-rows-edited-on-each-side.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-rows-edited-on-each-side.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-rows-edited-on-each-side.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-rows-edited-on-each-side.json/merged | no | no | yes |
| A | merge-prototype-ids-shots.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-shots.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-shots.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-shots.json/merged | no | no | yes |
| A | merge-prototype-ids-tags.json/inputs/base | no | no | yes |
| A | merge-prototype-ids-tags.json/inputs/mine | no | no | yes |
| A | merge-prototype-ids-tags.json/inputs/theirs | no | no | yes |
| A | merge-prototype-ids-tags.json/merged | no | no | yes |
| A | merge-revision-and-last-edited.json/inputs/base | no | no | yes |
| A | merge-revision-and-last-edited.json/inputs/mine | no | no | yes |
| A | merge-revision-and-last-edited.json/inputs/theirs | no | no | yes |
| A | merge-revision-and-last-edited.json/merged | no | no | yes |
| A | merge-rows-delete-both-sides.json/inputs/base | no | no | yes |
| A | merge-rows-delete-both-sides.json/inputs/mine | no | no | yes |
| A | merge-rows-delete-both-sides.json/inputs/theirs | no | no | yes |
| A | merge-rows-delete-both-sides.json/merged | no | no | yes |
| A | merge-rows-delete-same-row.json/inputs/base | no | no | yes |
| A | merge-rows-delete-same-row.json/inputs/mine | no | no | yes |
| A | merge-rows-delete-same-row.json/inputs/theirs | no | no | yes |
| A | merge-rows-delete-same-row.json/merged | no | no | yes |
| A | merge-rows-gallery-links.json/inputs/base | no | no | yes |
| A | merge-rows-gallery-links.json/inputs/mine | no | no | yes |
| A | merge-rows-gallery-links.json/inputs/theirs | no | no | yes |
| A | merge-rows-gallery-links.json/merged | no | no | yes |
| A | merge-rows-gallery-more-images.json/inputs/base | yes | yes | yes |
| A | merge-rows-gallery-more-images.json/inputs/mine | yes | yes | yes |
| A | merge-rows-gallery-more-images.json/inputs/theirs | yes | yes | yes |
| A | merge-rows-gallery-more-images.json/merged | yes | yes | yes |
| A | merge-rows-insert-both-sides.json/inputs/base | no | no | yes |
| A | merge-rows-insert-both-sides.json/inputs/mine | no | no | yes |
| A | merge-rows-insert-both-sides.json/inputs/theirs | no | no | yes |
| A | merge-rows-insert-both-sides.json/merged | no | no | yes |
| A | merge-rows-mine-deleted-theirs-edited.json/inputs/base | no | no | yes |
| A | merge-rows-mine-deleted-theirs-edited.json/inputs/mine | no | no | yes |
| A | merge-rows-mine-deleted-theirs-edited.json/inputs/theirs | no | no | yes |
| A | merge-rows-mine-deleted-theirs-edited.json/merged | no | no | yes |
| A | merge-rows-move-and-edit-both.json/inputs/base | no | no | yes |
| A | merge-rows-move-and-edit-both.json/inputs/mine | no | no | yes |
| A | merge-rows-move-and-edit-both.json/inputs/theirs | no | no | yes |
| A | merge-rows-move-and-edit-both.json/merged | no | no | yes |
| A | merge-rows-move-mine.json/inputs/base | no | no | yes |
| A | merge-rows-move-mine.json/inputs/mine | no | no | yes |
| A | merge-rows-move-mine.json/inputs/theirs | no | no | yes |
| A | merge-rows-move-mine.json/merged | no | no | yes |
| A | merge-rows-move-theirs.json/inputs/base | no | no | yes |
| A | merge-rows-move-theirs.json/inputs/mine | no | no | yes |
| A | merge-rows-move-theirs.json/inputs/theirs | no | no | yes |
| A | merge-rows-move-theirs.json/merged | no | no | yes |
| A | merge-rows-no-base.json/inputs/mine | no | no | yes |
| A | merge-rows-no-base.json/inputs/theirs | no | no | yes |
| A | merge-rows-no-base.json/merged | no | no | yes |
| A | merge-rows-picture.json/inputs/base | yes | yes | yes |
| A | merge-rows-picture.json/inputs/mine | no | no | yes |
| A | merge-rows-picture.json/inputs/theirs | yes | yes | yes |
| A | merge-rows-picture.json/merged | no | no | yes |
| A | merge-rows-status-and-length.json/inputs/base | no | no | yes |
| A | merge-rows-status-and-length.json/inputs/mine | no | no | yes |
| A | merge-rows-status-and-length.json/inputs/theirs | no | no | yes |
| A | merge-rows-status-and-length.json/merged | no | no | yes |
| A | merge-rows-theirs-deleted-mine-edited.json/inputs/base | no | no | yes |
| A | merge-rows-theirs-deleted-mine-edited.json/inputs/mine | no | no | yes |
| A | merge-rows-theirs-deleted-mine-edited.json/inputs/theirs | no | no | yes |
| A | merge-rows-theirs-deleted-mine-edited.json/merged | no | no | yes |
| A | merge-schema-from-other-versions.json/inputs/base | no | no | yes |
| A | merge-schema-from-other-versions.json/inputs/mine | no | no | yes |
| A | merge-schema-from-other-versions.json/inputs/theirs | no | no | yes |
| A | merge-schema-from-other-versions.json/merged | no | no | yes |
| A | merge-sections-both-changed.json/inputs/base | no | no | yes |
| A | merge-sections-both-changed.json/inputs/mine | no | no | yes |
| A | merge-sections-both-changed.json/inputs/theirs | no | no | yes |
| A | merge-sections-both-changed.json/merged | no | no | yes |
| A | merge-target-length-both-changed.json/inputs/base | no | no | yes |
| A | merge-target-length-both-changed.json/inputs/mine | no | no | yes |
| A | merge-target-length-both-changed.json/inputs/theirs | no | no | yes |
| A | merge-target-length-both-changed.json/merged | no | no | yes |
| A | merge-target-length-mine-only.json/inputs/base | no | no | yes |
| A | merge-target-length-mine-only.json/inputs/mine | no | no | yes |
| A | merge-target-length-mine-only.json/inputs/theirs | no | no | yes |
| A | merge-target-length-mine-only.json/merged | no | no | yes |
| A | merge-target-length-no-base.json/inputs/mine | no | no | yes |
| A | merge-target-length-no-base.json/inputs/theirs | no | no | yes |
| A | merge-target-length-no-base.json/merged | no | no | yes |
| A | merge-target-length-theirs-cleared.json/inputs/base | no | no | yes |
| A | merge-target-length-theirs-cleared.json/inputs/mine | no | no | yes |
| A | merge-target-length-theirs-cleared.json/inputs/theirs | no | no | yes |
| A | merge-target-length-theirs-cleared.json/merged | no | no | yes |
| A | merge-text-both-sides-conflict.json/inputs/base | no | no | yes |
| A | merge-text-both-sides-conflict.json/inputs/mine | no | no | yes |
| A | merge-text-both-sides-conflict.json/inputs/theirs | no | no | yes |
| A | merge-text-both-sides-conflict.json/merged | no | no | yes |
| A | merge-text-both-sides-merged.json/inputs/base | no | no | yes |
| A | merge-text-both-sides-merged.json/inputs/mine | no | no | yes |
| A | merge-text-both-sides-merged.json/inputs/theirs | no | no | yes |
| A | merge-text-both-sides-merged.json/merged | no | no | yes |
| A | merge-text-different-tags-on-one-word.json/inputs/base | no | no | yes |
| A | merge-text-different-tags-on-one-word.json/inputs/mine | no | no | yes |
| A | merge-text-different-tags-on-one-word.json/inputs/theirs | no | no | yes |
| A | merge-text-different-tags-on-one-word.json/merged | no | no | yes |
| A | merge-text-link-conflict-with-other-edits.json/inputs/base | no | no | yes |
| A | merge-text-link-conflict-with-other-edits.json/inputs/mine | no | no | yes |
| A | merge-text-link-conflict-with-other-edits.json/inputs/theirs | no | no | yes |
| A | merge-text-link-conflict-with-other-edits.json/merged | no | no | yes |
| A | merge-text-no-base.json/inputs/mine | no | no | yes |
| A | merge-text-no-base.json/inputs/theirs | no | no | yes |
| A | merge-text-no-base.json/merged | no | no | yes |
| A | merge-text-one-side-each.json/inputs/base | no | no | yes |
| A | merge-text-one-side-each.json/inputs/mine | no | no | yes |
| A | merge-text-one-side-each.json/inputs/theirs | no | no | yes |
| A | merge-text-one-side-each.json/merged | no | no | yes |
| A | merge-text-tag-renamed-and-cell-edited.json/inputs/base | no | no | yes |
| A | merge-text-tag-renamed-and-cell-edited.json/inputs/mine | no | no | yes |
| A | merge-text-tag-renamed-and-cell-edited.json/inputs/theirs | no | no | yes |
| A | merge-text-tag-renamed-and-cell-edited.json/merged | no | no | yes |
| A | merge-text-unicode-and-atoms.json/inputs/base | no | no | no |
| A | merge-text-unicode-and-atoms.json/inputs/mine | no | no | no |
| A | merge-text-unicode-and-atoms.json/inputs/theirs | no | no | no |
| A | merge-text-unicode-and-atoms.json/merged | no | no | yes |
| A | merge-title-both-changed.json/inputs/base | no | no | yes |
| A | merge-title-both-changed.json/inputs/mine | no | no | yes |
| A | merge-title-both-changed.json/inputs/theirs | no | no | yes |
| A | merge-title-both-changed.json/merged | no | no | yes |
| A | merge-title-both-same.json/inputs/base | no | no | yes |
| A | merge-title-both-same.json/inputs/mine | no | no | yes |
| A | merge-title-both-same.json/inputs/theirs | no | no | yes |
| A | merge-title-both-same.json/merged | no | no | yes |
| A | merge-title-mine-cleared.json/inputs/base | no | no | yes |
| A | merge-title-mine-cleared.json/inputs/mine | no | no | yes |
| A | merge-title-mine-cleared.json/inputs/theirs | no | no | yes |
| A | merge-title-mine-cleared.json/merged | no | no | yes |
| A | merge-title-mine-only.json/inputs/base | no | no | yes |
| A | merge-title-mine-only.json/inputs/mine | no | no | yes |
| A | merge-title-mine-only.json/inputs/theirs | no | no | yes |
| A | merge-title-mine-only.json/merged | no | no | yes |
| A | merge-title-no-base.json/inputs/mine | no | no | yes |
| A | merge-title-no-base.json/inputs/theirs | no | no | yes |
| A | merge-title-no-base.json/merged | no | no | yes |
| A | merge-title-theirs-only.json/inputs/base | no | no | yes |
| A | merge-title-theirs-only.json/inputs/mine | no | no | yes |
| A | merge-title-theirs-only.json/inputs/theirs | no | no | yes |
| A | merge-title-theirs-only.json/merged | no | no | yes |
| A | merge-words-per-minute-both-changed.json/inputs/base | no | no | yes |
| A | merge-words-per-minute-both-changed.json/inputs/mine | no | no | yes |
| A | merge-words-per-minute-both-changed.json/inputs/theirs | no | no | yes |
| A | merge-words-per-minute-both-changed.json/merged | no | no | yes |
| A | merge-words-per-minute-mine-only.json/inputs/base | no | no | yes |
| A | merge-words-per-minute-mine-only.json/inputs/mine | no | no | yes |
| A | merge-words-per-minute-mine-only.json/inputs/theirs | no | no | yes |
| A | merge-words-per-minute-mine-only.json/merged | no | no | yes |
| A | merge-words-per-minute-no-base.json/inputs/mine | no | no | yes |
| A | merge-words-per-minute-no-base.json/inputs/theirs | no | no | yes |
| A | merge-words-per-minute-no-base.json/merged | no | no | yes |
| A | merge-words-per-minute-theirs-only.json/inputs/base | no | no | yes |
| A | merge-words-per-minute-theirs-only.json/inputs/mine | no | no | yes |
| A | merge-words-per-minute-theirs-only.json/inputs/theirs | no | no | yes |
| A | merge-words-per-minute-theirs-only.json/merged | no | no | yes |
| A | migrate-golden.json/scenarios/schema 1 document/output | no | no | yes |
| A | migrate-golden.json/scenarios/media in cells/output | no | no | no |
| A | migrate-golden.json/scenarios/schema 2 document saved before the tag registry/output | no | no | yes |
| A | migrate-golden.json/scenarios/seed/output | no | no | yes |
| A | migrate-golden.json/scenarios/odd shapes/output | no | no | yes |
| A | migrate-golden.json/scenarios/null document/output | no | no | yes |
| A | migrate-golden.json/scenarios/legacy file with a picture/output | yes | yes | yes |
| A | attribute-cases.splitpage | no | no | yes |
| A | quoted-tag.splitpage | no | no | yes |
| A | quoted-who.splitpage | no | no | yes |
| A | special-keys.splitpage | no | no | yes |
| A | supplement.splitpage | no | no | no |
| B | splitpage-0.3.0-seed.splitpage | no | no | yes |
| B | splitpage-0.3.0-spot.splitpage | no | no | yes |
| B | src/seed-state.json | no | no | yes |
| B | src/starters/interview.json | no | no | yes |
| B | src/starters/long-demo.json | no | no | yes |
| B | src/starters/thirty-second-spot.json | no | no | yes |
| B | src/starters/to-camera.json | no | no | yes |
| B | merge-broll-props-edges.json/inputs/base | no | no | yes |
| B | merge-broll-props-edges.json/inputs/mine | no | no | yes |
| B | merge-broll-props-edges.json/inputs/theirs | no | no | yes |
| B | merge-broll-props-edges.json/merged | no | no | yes |
| B | merge-broll-shots-each-side.json/inputs/base | no | no | yes |
| B | merge-broll-shots-each-side.json/inputs/mine | no | no | yes |
| B | merge-broll-shots-each-side.json/inputs/theirs | no | no | yes |
| B | merge-broll-shots-each-side.json/merged | no | no | yes |
| B | merge-comments-anchor-moved.json/inputs/base | no | no | yes |
| B | merge-comments-anchor-moved.json/inputs/mine | no | no | yes |
| B | merge-comments-anchor-moved.json/inputs/theirs | no | no | yes |
| B | merge-comments-anchor-moved.json/merged | no | no | yes |
| B | merge-comments-deleted-and-added.json/inputs/base | no | no | yes |
| B | merge-comments-deleted-and-added.json/inputs/mine | no | no | yes |
| B | merge-comments-deleted-and-added.json/inputs/theirs | no | no | yes |
| B | merge-comments-deleted-and-added.json/merged | no | no | yes |
| B | merge-comments-edited-both-sides.json/inputs/base | no | no | yes |
| B | merge-comments-edited-both-sides.json/inputs/mine | no | no | yes |
| B | merge-comments-edited-both-sides.json/inputs/theirs | no | no | yes |
| B | merge-comments-edited-both-sides.json/merged | no | no | yes |
| B | merge-comments-no-base.json/inputs/mine | no | no | yes |
| B | merge-comments-no-base.json/inputs/theirs | no | no | yes |
| B | merge-comments-no-base.json/merged | no | no | yes |
| B | merge-doc-id-both-changed.json/inputs/base | no | no | yes |
| B | merge-doc-id-both-changed.json/inputs/mine | no | no | yes |
| B | merge-doc-id-both-changed.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-both-changed.json/merged | no | no | yes |
| B | merge-doc-id-mine-changed.json/inputs/base | no | no | yes |
| B | merge-doc-id-mine-changed.json/inputs/mine | no | no | yes |
| B | merge-doc-id-mine-changed.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-mine-changed.json/merged | no | no | yes |
| B | merge-doc-id-neither-readable.json/inputs/base | no | no | yes |
| B | merge-doc-id-neither-readable.json/inputs/mine | no | no | yes |
| B | merge-doc-id-neither-readable.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-neither-readable.json/merged | no | no | yes |
| B | merge-doc-id-no-base.json/inputs/mine | no | no | yes |
| B | merge-doc-id-no-base.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-no-base.json/merged | no | no | yes |
| B | merge-doc-id-theirs-changed.json/inputs/base | no | no | yes |
| B | merge-doc-id-theirs-changed.json/inputs/mine | no | no | yes |
| B | merge-doc-id-theirs-changed.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-theirs-changed.json/merged | no | no | yes |
| B | merge-doc-id-theirs-unreadable.json/inputs/base | no | no | yes |
| B | merge-doc-id-theirs-unreadable.json/inputs/mine | no | no | yes |
| B | merge-doc-id-theirs-unreadable.json/inputs/theirs | no | no | yes |
| B | merge-doc-id-theirs-unreadable.json/merged | no | no | yes |
| B | merge-editor-anonymous.json/inputs/base | no | no | yes |
| B | merge-editor-anonymous.json/inputs/mine | no | no | yes |
| B | merge-editor-anonymous.json/inputs/theirs | no | no | yes |
| B | merge-editor-anonymous.json/merged | no | no | yes |
| B | merge-file-title-mine-only.json/inputs/base | no | no | yes |
| B | merge-file-title-mine-only.json/inputs/mine | no | no | yes |
| B | merge-file-title-mine-only.json/inputs/theirs | no | no | yes |
| B | merge-file-title-mine-only.json/merged | no | no | yes |
| B | merge-file-title-theirs-only.json/inputs/base | no | no | yes |
| B | merge-file-title-theirs-only.json/inputs/mine | no | no | yes |
| B | merge-file-title-theirs-only.json/inputs/theirs | no | no | yes |
| B | merge-file-title-theirs-only.json/merged | no | no | yes |
| B | merge-last-edited-only-mine-knows.json/inputs/base | no | no | yes |
| B | merge-last-edited-only-mine-knows.json/inputs/mine | no | no | yes |
| B | merge-last-edited-only-mine-knows.json/inputs/theirs | no | no | yes |
| B | merge-last-edited-only-mine-knows.json/merged | no | no | yes |
| B | merge-paragraphs-decided-both.json/inputs/base | no | no | yes |
| B | merge-paragraphs-decided-both.json/inputs/mine | no | no | yes |
| B | merge-paragraphs-decided-both.json/inputs/theirs | no | no | yes |
| B | merge-paragraphs-decided-both.json/merged | no | no | yes |
| B | merge-people-each-side.json/inputs/base | no | no | yes |
| B | merge-people-each-side.json/inputs/mine | no | no | yes |
| B | merge-people-each-side.json/inputs/theirs | no | no | yes |
| B | merge-people-each-side.json/merged | no | no | yes |
| B | merge-person-colors-both-changed-one-name.json/inputs/base | no | no | yes |
| B | merge-person-colors-both-changed-one-name.json/inputs/mine | no | no | yes |
| B | merge-person-colors-both-changed-one-name.json/inputs/theirs | no | no | yes |
| B | merge-person-colors-both-changed-one-name.json/merged | no | no | yes |
| B | merge-person-colors-each-side.json/inputs/base | no | no | yes |
| B | merge-person-colors-each-side.json/inputs/mine | no | no | yes |
| B | merge-person-colors-each-side.json/inputs/theirs | no | no | yes |
| B | merge-person-colors-each-side.json/merged | no | no | yes |
| B | merge-person-colors-removed-both-sides.json/inputs/base | no | no | yes |
| B | merge-person-colors-removed-both-sides.json/inputs/mine | no | no | yes |
| B | merge-person-colors-removed-both-sides.json/inputs/theirs | no | no | yes |
| B | merge-person-colors-removed-both-sides.json/merged | no | no | yes |
| B | merge-person-colors-theirs-only.json/inputs/base | no | no | yes |
| B | merge-person-colors-theirs-only.json/inputs/mine | no | no | yes |
| B | merge-person-colors-theirs-only.json/inputs/theirs | no | no | yes |
| B | merge-person-colors-theirs-only.json/merged | no | no | yes |
| B | merge-production-tags-each-side.json/inputs/base | no | no | yes |
| B | merge-production-tags-each-side.json/inputs/mine | no | no | yes |
| B | merge-production-tags-each-side.json/inputs/theirs | no | no | yes |
| B | merge-production-tags-each-side.json/merged | no | no | yes |
| B | merge-production-tags-no-base.json/inputs/mine | no | no | yes |
| B | merge-production-tags-no-base.json/inputs/theirs | no | no | yes |
| B | merge-production-tags-no-base.json/merged | no | no | yes |
| B | merge-prototype-ids-comments.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-comments.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-comments.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-comments.json/merged | no | no | yes |
| B | merge-prototype-ids-people.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-people.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-people.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-people.json/merged | no | no | yes |
| B | merge-prototype-ids-rows-added-on-each-side.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-rows-added-on-each-side.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-rows-added-on-each-side.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-rows-added-on-each-side.json/merged | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-mine.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-mine.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-mine.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-mine.json/merged | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-theirs.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-rows-deleted-by-theirs.json/merged | no | no | yes |
| B | merge-prototype-ids-rows-edited-on-each-side.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-rows-edited-on-each-side.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-rows-edited-on-each-side.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-rows-edited-on-each-side.json/merged | no | no | yes |
| B | merge-prototype-ids-shots.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-shots.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-shots.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-shots.json/merged | no | no | yes |
| B | merge-prototype-ids-tags.json/inputs/base | no | no | yes |
| B | merge-prototype-ids-tags.json/inputs/mine | no | no | yes |
| B | merge-prototype-ids-tags.json/inputs/theirs | no | no | yes |
| B | merge-prototype-ids-tags.json/merged | no | no | yes |
| B | merge-revision-and-last-edited.json/inputs/base | no | no | yes |
| B | merge-revision-and-last-edited.json/inputs/mine | no | no | yes |
| B | merge-revision-and-last-edited.json/inputs/theirs | no | no | yes |
| B | merge-revision-and-last-edited.json/merged | no | no | yes |
| B | merge-rows-delete-both-sides.json/inputs/base | no | no | yes |
| B | merge-rows-delete-both-sides.json/inputs/mine | no | no | yes |
| B | merge-rows-delete-both-sides.json/inputs/theirs | no | no | yes |
| B | merge-rows-delete-both-sides.json/merged | no | no | yes |
| B | merge-rows-delete-same-row.json/inputs/base | no | no | yes |
| B | merge-rows-delete-same-row.json/inputs/mine | no | no | yes |
| B | merge-rows-delete-same-row.json/inputs/theirs | no | no | yes |
| B | merge-rows-delete-same-row.json/merged | no | no | yes |
| B | merge-rows-gallery-links.json/inputs/base | no | no | yes |
| B | merge-rows-gallery-links.json/inputs/mine | no | no | yes |
| B | merge-rows-gallery-links.json/inputs/theirs | no | no | yes |
| B | merge-rows-gallery-links.json/merged | no | no | yes |
| B | merge-rows-gallery-more-images.json/inputs/base | yes | yes | yes |
| B | merge-rows-gallery-more-images.json/inputs/mine | yes | yes | yes |
| B | merge-rows-gallery-more-images.json/inputs/theirs | yes | yes | yes |
| B | merge-rows-gallery-more-images.json/merged | yes | yes | yes |
| B | merge-rows-insert-both-sides.json/inputs/base | no | no | yes |
| B | merge-rows-insert-both-sides.json/inputs/mine | no | no | yes |
| B | merge-rows-insert-both-sides.json/inputs/theirs | no | no | yes |
| B | merge-rows-insert-both-sides.json/merged | no | no | yes |
| B | merge-rows-mine-deleted-theirs-edited.json/inputs/base | no | no | yes |
| B | merge-rows-mine-deleted-theirs-edited.json/inputs/mine | no | no | yes |
| B | merge-rows-mine-deleted-theirs-edited.json/inputs/theirs | no | no | yes |
| B | merge-rows-mine-deleted-theirs-edited.json/merged | no | no | yes |
| B | merge-rows-move-and-edit-both.json/inputs/base | no | no | yes |
| B | merge-rows-move-and-edit-both.json/inputs/mine | no | no | yes |
| B | merge-rows-move-and-edit-both.json/inputs/theirs | no | no | yes |
| B | merge-rows-move-and-edit-both.json/merged | no | no | yes |
| B | merge-rows-move-mine.json/inputs/base | no | no | yes |
| B | merge-rows-move-mine.json/inputs/mine | no | no | yes |
| B | merge-rows-move-mine.json/inputs/theirs | no | no | yes |
| B | merge-rows-move-mine.json/merged | no | no | yes |
| B | merge-rows-move-theirs.json/inputs/base | no | no | yes |
| B | merge-rows-move-theirs.json/inputs/mine | no | no | yes |
| B | merge-rows-move-theirs.json/inputs/theirs | no | no | yes |
| B | merge-rows-move-theirs.json/merged | no | no | yes |
| B | merge-rows-no-base.json/inputs/mine | no | no | yes |
| B | merge-rows-no-base.json/inputs/theirs | no | no | yes |
| B | merge-rows-no-base.json/merged | no | no | yes |
| B | merge-rows-picture.json/inputs/base | yes | yes | yes |
| B | merge-rows-picture.json/inputs/mine | no | no | yes |
| B | merge-rows-picture.json/inputs/theirs | yes | yes | yes |
| B | merge-rows-picture.json/merged | no | no | yes |
| B | merge-rows-status-and-length.json/inputs/base | no | no | yes |
| B | merge-rows-status-and-length.json/inputs/mine | no | no | yes |
| B | merge-rows-status-and-length.json/inputs/theirs | no | no | yes |
| B | merge-rows-status-and-length.json/merged | no | no | yes |
| B | merge-rows-theirs-deleted-mine-edited.json/inputs/base | no | no | yes |
| B | merge-rows-theirs-deleted-mine-edited.json/inputs/mine | no | no | yes |
| B | merge-rows-theirs-deleted-mine-edited.json/inputs/theirs | no | no | yes |
| B | merge-rows-theirs-deleted-mine-edited.json/merged | no | no | yes |
| B | merge-schema-from-other-versions.json/inputs/base | no | no | yes |
| B | merge-schema-from-other-versions.json/inputs/mine | no | no | yes |
| B | merge-schema-from-other-versions.json/inputs/theirs | no | no | yes |
| B | merge-schema-from-other-versions.json/merged | no | no | yes |
| B | merge-sections-both-changed.json/inputs/base | no | no | yes |
| B | merge-sections-both-changed.json/inputs/mine | no | no | yes |
| B | merge-sections-both-changed.json/inputs/theirs | no | no | yes |
| B | merge-sections-both-changed.json/merged | no | no | yes |
| B | merge-target-length-both-changed.json/inputs/base | no | no | yes |
| B | merge-target-length-both-changed.json/inputs/mine | no | no | yes |
| B | merge-target-length-both-changed.json/inputs/theirs | no | no | yes |
| B | merge-target-length-both-changed.json/merged | no | no | yes |
| B | merge-target-length-mine-only.json/inputs/base | no | no | yes |
| B | merge-target-length-mine-only.json/inputs/mine | no | no | yes |
| B | merge-target-length-mine-only.json/inputs/theirs | no | no | yes |
| B | merge-target-length-mine-only.json/merged | no | no | yes |
| B | merge-target-length-no-base.json/inputs/mine | no | no | yes |
| B | merge-target-length-no-base.json/inputs/theirs | no | no | yes |
| B | merge-target-length-no-base.json/merged | no | no | yes |
| B | merge-target-length-theirs-cleared.json/inputs/base | no | no | yes |
| B | merge-target-length-theirs-cleared.json/inputs/mine | no | no | yes |
| B | merge-target-length-theirs-cleared.json/inputs/theirs | no | no | yes |
| B | merge-target-length-theirs-cleared.json/merged | no | no | yes |
| B | merge-text-both-sides-conflict.json/inputs/base | no | no | yes |
| B | merge-text-both-sides-conflict.json/inputs/mine | no | no | yes |
| B | merge-text-both-sides-conflict.json/inputs/theirs | no | no | yes |
| B | merge-text-both-sides-conflict.json/merged | no | no | yes |
| B | merge-text-both-sides-merged.json/inputs/base | no | no | yes |
| B | merge-text-both-sides-merged.json/inputs/mine | no | no | yes |
| B | merge-text-both-sides-merged.json/inputs/theirs | no | no | yes |
| B | merge-text-both-sides-merged.json/merged | no | no | yes |
| B | merge-text-different-tags-on-one-word.json/inputs/base | no | no | yes |
| B | merge-text-different-tags-on-one-word.json/inputs/mine | no | no | yes |
| B | merge-text-different-tags-on-one-word.json/inputs/theirs | no | no | yes |
| B | merge-text-different-tags-on-one-word.json/merged | no | no | yes |
| B | merge-text-link-conflict-with-other-edits.json/inputs/base | no | no | yes |
| B | merge-text-link-conflict-with-other-edits.json/inputs/mine | no | no | yes |
| B | merge-text-link-conflict-with-other-edits.json/inputs/theirs | no | no | yes |
| B | merge-text-link-conflict-with-other-edits.json/merged | no | no | yes |
| B | merge-text-no-base.json/inputs/mine | no | no | yes |
| B | merge-text-no-base.json/inputs/theirs | no | no | yes |
| B | merge-text-no-base.json/merged | no | no | yes |
| B | merge-text-one-side-each.json/inputs/base | no | no | yes |
| B | merge-text-one-side-each.json/inputs/mine | no | no | yes |
| B | merge-text-one-side-each.json/inputs/theirs | no | no | yes |
| B | merge-text-one-side-each.json/merged | no | no | yes |
| B | merge-text-tag-renamed-and-cell-edited.json/inputs/base | no | no | yes |
| B | merge-text-tag-renamed-and-cell-edited.json/inputs/mine | no | no | yes |
| B | merge-text-tag-renamed-and-cell-edited.json/inputs/theirs | no | no | yes |
| B | merge-text-tag-renamed-and-cell-edited.json/merged | no | no | yes |
| B | merge-text-unicode-and-atoms.json/inputs/base | no | no | no |
| B | merge-text-unicode-and-atoms.json/inputs/mine | no | no | no |
| B | merge-text-unicode-and-atoms.json/inputs/theirs | no | no | no |
| B | merge-text-unicode-and-atoms.json/merged | no | no | yes |
| B | merge-title-both-changed.json/inputs/base | no | no | yes |
| B | merge-title-both-changed.json/inputs/mine | no | no | yes |
| B | merge-title-both-changed.json/inputs/theirs | no | no | yes |
| B | merge-title-both-changed.json/merged | no | no | yes |
| B | merge-title-both-same.json/inputs/base | no | no | yes |
| B | merge-title-both-same.json/inputs/mine | no | no | yes |
| B | merge-title-both-same.json/inputs/theirs | no | no | yes |
| B | merge-title-both-same.json/merged | no | no | yes |
| B | merge-title-mine-cleared.json/inputs/base | no | no | yes |
| B | merge-title-mine-cleared.json/inputs/mine | no | no | yes |
| B | merge-title-mine-cleared.json/inputs/theirs | no | no | yes |
| B | merge-title-mine-cleared.json/merged | no | no | yes |
| B | merge-title-mine-only.json/inputs/base | no | no | yes |
| B | merge-title-mine-only.json/inputs/mine | no | no | yes |
| B | merge-title-mine-only.json/inputs/theirs | no | no | yes |
| B | merge-title-mine-only.json/merged | no | no | yes |
| B | merge-title-no-base.json/inputs/mine | no | no | yes |
| B | merge-title-no-base.json/inputs/theirs | no | no | yes |
| B | merge-title-no-base.json/merged | no | no | yes |
| B | merge-title-theirs-only.json/inputs/base | no | no | yes |
| B | merge-title-theirs-only.json/inputs/mine | no | no | yes |
| B | merge-title-theirs-only.json/inputs/theirs | no | no | yes |
| B | merge-title-theirs-only.json/merged | no | no | yes |
| B | merge-words-per-minute-both-changed.json/inputs/base | no | no | yes |
| B | merge-words-per-minute-both-changed.json/inputs/mine | no | no | yes |
| B | merge-words-per-minute-both-changed.json/inputs/theirs | no | no | yes |
| B | merge-words-per-minute-both-changed.json/merged | no | no | yes |
| B | merge-words-per-minute-mine-only.json/inputs/base | no | no | yes |
| B | merge-words-per-minute-mine-only.json/inputs/mine | no | no | yes |
| B | merge-words-per-minute-mine-only.json/inputs/theirs | no | no | yes |
| B | merge-words-per-minute-mine-only.json/merged | no | no | yes |
| B | merge-words-per-minute-no-base.json/inputs/mine | no | no | yes |
| B | merge-words-per-minute-no-base.json/inputs/theirs | no | no | yes |
| B | merge-words-per-minute-no-base.json/merged | no | no | yes |
| B | merge-words-per-minute-theirs-only.json/inputs/base | no | no | yes |
| B | merge-words-per-minute-theirs-only.json/inputs/mine | no | no | yes |
| B | merge-words-per-minute-theirs-only.json/inputs/theirs | no | no | yes |
| B | merge-words-per-minute-theirs-only.json/merged | no | no | yes |
| B | migrate-golden.json/scenarios/schema 1 document/output | no | no | yes |
| B | migrate-golden.json/scenarios/media in cells/output | no | no | no |
| B | migrate-golden.json/scenarios/schema 2 document saved before the tag registry/output | no | no | yes |
| B | migrate-golden.json/scenarios/seed/output | no | no | yes |
| B | migrate-golden.json/scenarios/odd shapes/output | no | no | yes |
| B | migrate-golden.json/scenarios/null document/output | no | no | yes |
| B | migrate-golden.json/scenarios/legacy file with a picture/output | yes | yes | yes |
| B | attribute-cases.splitpage | no | no | yes |
| B | quoted-tag.splitpage | no | no | yes |
| B | quoted-who.splitpage | no | no | yes |
| B | special-keys.splitpage | no | no | yes |
| B | supplement.splitpage | no | no | no |

## Checked field locations

| Inventory field | Candidate A | Candidate B |
| --- | --- | --- |
| `title` | meta.title Y.Text | meta.title Y.Text |
| `titleOrigin` | meta.titleOrigin | meta.titleOrigin |
| `titleVersion` | meta.titleVersion | meta.titleVersion |
| `docId` | meta.docId (import identity retained) | meta.docId (import identity retained) |
| `rows` | boundary order + beats | boundary order + beats |
| `comments` | comments map + import rank | comments map + import rank |
| `people` | people map + rank | people map + rank |
| `productionTags` | tags map + rank | tags map + rank |
| `brollShots` | shots map + rank | shots map + rank |
| `wordsPerMinute` | meta.wordsPerMinute | meta.wordsPerMinute |
| `rev` | meta.capture.rev (legacy export capture) | meta.capture.rev (legacy export capture) |
| `lastEditedBy` | meta.capture.lastEditedBy (legacy export capture) | meta.capture.lastEditedBy (legacy export capture) |
| `lastEditedAt` | meta.capture.lastEditedAt (legacy export capture) | meta.capture.lastEditedAt (legacy export capture) |
| `personColors` | meta.capture.personColors (cannot derive historical palette from people) | meta.capture.personColors (cannot derive historical palette from people) |
| `targetSeconds` | meta.targetSeconds | meta.targetSeconds |
| `sections` | heading boundaries + headings.keys | heading boundaries + headings.keys |
| `paragraphsDecided` | meta.paragraphsDecided | meta.paragraphsDecided |
| `schema` | meta.schema (file schema, distinct from CRDT schema version) | meta.schema (file schema, distinct from CRDT schema version) |
| Unknown top-level keys (fixture `doc.unknownField.kept`) | meta.extra JSON string; arbitrary key names retained | meta.extra JSON string; arbitrary key names retained |
| Unknown keys on rows, comments, replies and shots | record.extra JSON string; arbitrary key names retained | record.extra JSON string; arbitrary key names retained |
| Unknown keys on people and tag records | record.extra JSON string; arbitrary key names retained | record.extra JSON string; arbitrary key names retained |
| `rows[].id` | boundary identity + beats map key | boundary identity + beats map key |
| `rows[].audioText` (narration) | flow between beat boundary embeds | segments[id].text after head or inner embed |
| `rows[].visualText` (visual) | visuals[component].text Y.Text | visuals[component].text Y.Text |
| `rows[].status` | beats[id].status LWW; conflict policy unproved here | beats[id].status LWW; conflict policy unproved here |
| `rows[].lengthSeconds` | beats[id].lengthSeconds | beats[id].lengthSeconds |
| `rows[].paragraphStart` | beats[id].paragraphStart (stored flag retained) | beats[id].paragraphStart (stored flag retained) |
| `rows[].updatedAt` | beats[id].stamp.at | beats[id].stamp.at |
| `rows[].updatedBy` | beats[id].stamp.by | beats[id].stamp.by |
| `rows[].imageRef` | gallery[slot].picture.imageRef; bytes outside Yjs | gallery[slot].picture.imageRef; bytes outside Yjs |
| `rows[].imageName` | gallery[first].picture.name | gallery[first].picture.name |
| `rows[].imageAnnotation` | gallery[first].picture.annotation JSON | gallery[first].picture.annotation JSON |
| `rows[].imageLinks` | gallery[first].links map | gallery[first].links map |
| `rows[].moreImages` | gallery slots by rank then id | gallery slots by rank then id |
| `rows[].visualImage` | file encoding only; app reference blob store inlines refs | file encoding only; app reference blob store inlines refs |
| `moreImages[].imageRef` | gallery[slot].picture.imageRef | gallery[slot].picture.imageRef |
| `moreImages[].name` | gallery[slot].picture.name | gallery[slot].picture.name |
| `moreImages[].annotation` | gallery[slot].picture.annotation JSON | gallery[slot].picture.annotation JSON |
| `moreImages[].links` | gallery[slot].links map | gallery[slot].links map |
| `…links[].href` | gallery[slot].links[key].href | gallery[slot].links[key].href |
| `…links[].name`, `…links[].size` | gallery[slot].links[key].name,size | gallery[slot].links[key].name,size |
| `…links[].duration` | gallery[slot].links[key].duration | gallery[slot].links[key].duration |
| `…links[].poster` | gallery[slot].links[key].poster | gallery[slot].links[key].poster |
| `…links[].location` | device-local; deliberately absent from encoded Yjs state | device-local; deliberately absent from encoded Yjs state |
| Image reference `{sha256, width, height, mime}` | atomic reference JSON in gallery and comment.imageValue | atomic reference JSON in gallery and comment.imageValue |
| Hash-only inline image reference `{sha256}` (`StoredImageRef`) | atomic comment/reply HTML, hash resolved externally | atomic comment/reply HTML, hash resolved externally |
| Annotation mark, pen or highlight | gallery[slot].picture.annotation.marks JSON | gallery[slot].picture.annotation.marks JSON |
| Annotation mark, text | gallery[slot].picture.annotation.marks JSON | gallery[slot].picture.annotation.marks JSON |
| `sections[].id` | heading boundary identity | heading boundary identity |
| `sections[].name` | flow between heading boundary embeds | segments[id].text under heading head or embed |
| `sections[].firstSceneId` | next beat boundary, derived | next beat boundary, derived |
| `id` | comments map key and record id | comments map key and record id |
| `rowId` | comments[id].rowId (last known fallback) | comments[id].rowId (last known fallback) |
| `field` | comments[id].field (last known fallback) | comments[id].field (last known fallback) |
| `anchorId` | comments[id].anchorId | comments[id].anchorId |
| `quotedText` | comments[id].quote | comments[id].quote |
| `author` | comments[id].author | comments[id].author |
| `body` | comments[id].text atomic sanitized HTML | comments[id].text atomic sanitized HTML |
| `resolved` | comments[id].resolution.resolved atomic group | comments[id].resolution.resolved atomic group |
| `resolvedBy`, `resolvedAt` | comments[id].resolution.resolvedBy,resolvedAt | comments[id].resolution.resolvedBy,resolvedAt |
| `assignee` | comments[id].assignee | comments[id].assignee |
| `createdAt` | comments[id].createdAt | comments[id].createdAt |
| `updatedAt` | comments[id].updatedAt (legacy value retained) | comments[id].updatedAt (legacy value retained) |
| `kind` | comments[id].kind | comments[id].kind |
| `imageValue` | comments[id].imageValue atomic image reference | comments[id].imageValue atomic image reference |
| `conflictField`, `emptyValue`, `titleValue` | comments[id] named keys | comments[id] named keys |
| `replies[]` | replies map, commentId + import rank | replies map, commentId + import rank |
| `replies[].id` | replies[commentId:replyId].id | replies[commentId:replyId].id |
| `replies[].author`, `.body`, `.createdAt` | replies[id].author,text,createdAt | replies[id].author,text,createdAt |
| `people[].id` | people map key and record id | people map key and record id |
| `people[].name` | people[id].name | people[id].name |
| `productionTags[].id` | tags map key and record id | tags map key and record id |
| `productionTags[].cat` | tags[id].cat | tags[id].cat |
| `productionTags[].name` | tags[id].name (stored fallback retained) | tags[id].name (stored fallback retained) |
| `productionTags[].owner` | tags[id].owner (stored fallback retained) | tags[id].owner (stored fallback retained) |
| `productionTags[].notes` | tags[id].notes | tags[id].notes |
| `productionTags[].status` | tags[id].status LWW | tags[id].status LWW |
| `brollShots[].id` | shots map key and record id | shots map key and record id |
| `brollShots[].name`, `.desc` | shots[id].name,desc (stored fallback retained) | shots[id].name,desc (stored fallback retained) |
| `brollShots[].status` | shots[id].status LWW | shots[id].status LWW |
| `brollShots[].reshoot` | shots[id].reshoot | shots[id].reshoot |
| `brollShots[].notes`, `.audioRef`, `.location` | shots[id].notes,audioRef,location | shots[id].notes,audioRef,location |
| `brollShots[].owner` | shots[id].owner | shots[id].owner |
| `brollShots[].origin` | shots[id].origin | shots[id].origin |
| `brollShots[].props[]` | shots[id].props map keyed by brollPropKey, each value plus rank | shots[id].props map keyed by brollPropKey, each value plus rank |
| Characters and line breaks | Y.Text characters; newline projects to br; bodies atomic HTML | Y.Text characters; newline projects to br; bodies atomic HTML |
| Bold, italic, underline, strike, highlight | Y.Text b,i,u,s,hl attributes; bodies atomic HTML | Y.Text b,i,u,s,hl attributes; bodies atomic HTML |
| Link | Y.Text l:occurrence attributes; bodies atomic HTML | Y.Text l:occurrence attributes; bodies atomic HTML |
| Comment mark | Y.Text c:commentId attributes; anchorId restored at projection | Y.Text c:commentId attributes; anchorId restored at projection |
| Tag | Y.Text t:occurrence attributes referencing tag ids | Y.Text t:occurrence attributes referencing tag ids |
| Stage direction | Y.Text dir attribute | Y.Text dir attribute |
| Audio cue | Y.Text cue attribute; core settleCues may normalize | Y.Text cue attribute; core settleCues may normalize |
| B-roll key | Y.Text embed {k:shotId,label:original marker text} | Y.Text embed {k:shotId,label:original marker text} |
| `@Name` | Y.Text embed {w:name}; rendered @ + name | Y.Text embed {w:name}; rendered @ + name |
| Image | comment/reply atomic HTML; blob bytes external | comment/reply atomic HTML; blob bytes external |
| Video card | comment/reply atomic HTML | comment/reply atomic HTML |

## Concurrent field projection

64/64 candidate/case/order/client-id runs match the hand-written field outcomes: different scalars on one beat, fields on different beats, one narration character against a scalar edit, and known metadata edits on records carrying unknown extras. D1, duplicate, reverse and late-C delivery all pass, with both client-id assignments. The exact complete documents are checked before app normalization, so equally wrong replicas fail. All 64 app-reference results parse and resave stably.

Unknown extras survive known-field edits on the document, beat, comment, reply, person, tag and shot. The concurrent seed includes own __proto__ keys on all seven kinds and constructor/prototype at the document level. This confirms PROJ-unknown for these edits, not concurrent editing of extra JSON itself.

16/16 PROJ-detached runs pass both candidates, four delivery orders and both client-id assignments. Alice deletes every original marked character while Bob explicitly moves the mark to R2; the live anchor derives R2/audioText, and a subsequent deletion of the moved words retains R2/audioText. The media input is produced by core mediaComments from a hash-only image and keeps its literal null anchor, body and load row/field. The move command records the fallback inside its transaction; removing that write fails the subsequent-detachment oracle. A separate test leaves the stored fallback stale, proves live marks determine the projected row, and verifies projection does not repair shared state. Several simultaneous movers, fallback arbitration across different fields, joins and recovery UI are not established.

Tests: test/proj/concurrency.test.ts. No real editor hook was added. Production would need validated semantic mark-move commands to maintain last-location fallback; arbitrary raw formatting operations do not provide that contract.

## Merged-state limits

520 deterministic runs: seeds 1, 7, 23, 91, 313; both candidates; D1, duplicate, reverse and late-C. The generator varies ranks and operation identities. Each side is checked against the named limit before delivery. Every merged result converges, and every app-produced file parses and resaves stably. Convergence and stable serialization do not establish a valid merged domain.

| Limit | Control | Just past | Projection in both candidates | App load/save |
| --- | --- | --- | --- | --- |
| Unique person names | distinct names, multiplicity 1 | two ids with one name | retains both, multiplicity 2 | retains both; uniqueness remains broken |
| Unique tag keys per category | different existing tags renamed to distinct keys | different existing tags concurrently renamed to one category/name | retains both, multiplicity 2 | retains both; uniqueness remains broken |
| Pictures | 60 and 61 total | 62 total | returns all 62, no recovery entry | keeps first 61, drops the last from the plain export |
| Shot props | 40 | 41 | retains all 41 set members | keeps first 40, drops the last from the plain export |
| Poster per link list | both writers select the same poster, 1 | writers select different posters, 2 | returns both true flags | keeps first poster, clears the later flag |
| Header per beat | two headers on different beats, 1 per beat | two headers before one beat | returns the later heading, omits the earlier one; no recovery entry | cannot restore the omitted heading |

Artifact 2's open question says 60 pictures; its field row allows 60 moreImages after the first picture, and artifact 8 explicitly says 61 total. The experiment covers 60, 61 and 62 rather than silently choosing one wording. No limit was invented or changed.

These are negative feasibility findings. The projection does not implement a complete overflow/recovery or uniqueness policy. Gallery state keeps the extra slot, props state keeps the extra member, and both heading objects/text remain in Yjs, but the plain projection/export cannot claim to include unresolved material it omits. Minimized seed-1 D1 histories are histories/PROJ-limit-{people,tags,gallery,props,poster,heading}-{A,B}.md; exact normalization paths and all delivery observations are in src/proj/experiment-results.json. Tests: test/proj/limits.test.ts. This does not establish status conflicts, duplicate b-roll-key reassignment or gallery replacement-versus-reorder semantics.

## Cue hypothesis

All six canonical documents holding cue spans were transferred to initialized receiving replicas under both candidates, then projected with stored cues and with line-derived cues. The two modes produce identical documents on this corpus: the known mid-line cue loss remains, as do unrelated U+200B differences. A literal control with one marked SFX line and one intentionally unmarked SFX line proves full derivation invents a cue flag on the unmarked line. Thus PROJ-cue is not confirmed as byte-identical with this writer, and the flag is not generally derivable from line text alone. Tests: test/proj/cues.test.ts; exact differences in experiment-results.json.

## Measured cost

Measured 2026-11-10T02:54:48.222Z on DESKTOP-NEFVS90, AMD Ryzen 9 9950X3D2 16-Core Processor, win32 10.0.26300 x64, Node v24.22.1, Yjs 13.6.33. 5 measured runs per fixture/candidate, one declared warmup each, A/B order alternated by round. All samples are retained in src/proj/cost-results.json; table entries are median [min–max], milliseconds.

Free RAM before/after: 5.15/5.06 GiB. Aggregate CPU busy during the batch: 14.4%. Other lanes were running. No browser, server, app or renderer was used for these measurements.

| Fixture | Candidate | .splitpage bytes | Encoded state bytes | Ratio | fromDocument ms | Full toDocument ms | After one character ms |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| largest canonical | A | 38432 | 48649 | 1.266x | 1.393 [1.075–2.035] | 1.936 [1.258–2.540] | 1.370 [1.300–2.047] |
| largest canonical | B | 38432 | 50252 | 1.308x | 1.355 [1.129–2.078] | 1.641 [1.459–2.222] | 1.483 [1.206–1.561] |
| large | A | 334208 | 427695 | 1.280x | 10.670 [10.032–11.847] | 63.230 [59.666–66.018] | 60.660 [59.553–63.193] |
| large | B | 334208 | 445329 | 1.332x | 9.185 [7.744–9.757] | 64.139 [61.233–65.460] | 59.980 [59.565–65.721] |

The largest canonical fixture is the 30-beat long demo. large uses the recorder's SCALE.grow algorithm: ten copies, fresh row/comment/shot ids and markup references, people/tags kept once. It has 300 beats and the same 334,208 .splitpage bytes as Stage 0. The producer and its input hash are checked against the independent app manifest. A generator test pins suffix behavior and registry sharing.

fromDocument includes fresh document construction and rich-text hydration, but excludes file parsing, app migration, encoding and network decode. Projection timings call toDocument on the imported writer replica; encodeStateAsUpdate is measured for size outside the timing. Untimed checks require exact full-document equality before measurement and exactly one changed narration field after the edit. The edit is one character in the middle beat, with explicit empty attributes; the after-edit timing excludes the edit itself and those checks. Both implementations still perform a full projection. Neither exposes an incremental projection API; stable segments alone have not made Candidate B incremental. Repeated global component/gallery sorting and scanning are prototype costs, not a lower bound for either representation.

All four fresh-state ratios are below Stage 0's provisional 3x import bound on these reference-only fixtures. No heavily edited 10x-growth or 2 MiB case, available image bytes, heap, server, rendering, join load or standalone A/B budget is measured. The large full/after-edit CPU medians exceed the 30 ms visible-character projection budget before any paint, so these implementations do not establish that budget. Node warm timings cannot be substituted for the required message-to-frame p50/p95 browser measurements. No outliers were discarded; the min–max ranges show the local noise. These are prototype-quality numbers and do not select a schema.

## Reproduction and remaining limits

From the repository root, with root dependencies installed only for the app-reference producer:

```text
node prototypes/collab/src/proj/experiment-inputs.ts --write
node tools/projection-reference.mjs --write --input prototypes/collab/test/proj/experiment-inputs.json --manifest prototypes/collab/test/proj/experiment-reference.json
node tools/projection-reference.mjs --check
node tools/projection-reference.mjs --check --input prototypes/collab/test/proj/experiment-inputs.json --manifest prototypes/collab/test/proj/experiment-reference.json
node prototypes/collab/src/proj/costs.ts --write
node prototypes/collab/src/proj/report.ts --write
cd prototypes/collab
npm test -- --test-concurrency=1
```

The root tool consumes data files only; no tool imports the prototype and no prototype imports app/bootstrap/adapters. Its experiment mode checks parse, load, save, reopen and resave using the real app, and a stale input digest fails prototype tests. All projection-created documents, including receiving and late-joining replicas, use the initialized SchemaReplica constructor plus the projection's headings root. No schema/model/reader/oracle/structure file from another lane was edited.

Neither candidate's full-document layout is a production integration of the structural/mark/status trace reader. The five canonical differences, device-local locations, absent blob resolution, unresolved merged limits, full-scan projection, coupled/opaque field granularity and unproven multi-mover fallback remain explicit limitations. No schema is recommended.
