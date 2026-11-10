import { writeFileSync } from "node:fs";
import { runRoundTrips } from "./experiment.ts";
import { projectionFieldMapping } from "./mapping.ts";
import { isProjectionEntry } from "./entry.ts";
import { projectionExtendedReport } from "./evidence.ts";

export function projectionReport(): string {
  const results = runRoundTrips();
  writeFileSync(new URL("results.json", import.meta.url), "[\n" + results.map(result => JSON.stringify(result)).join(",\n") + "\n]\n");
  for (const candidate of ["A", "B"] as const) {
    const losses = results.filter(result => result.candidate === candidate && !result.sameAsAppSave);
    writeFileSync(new URL(`../../histories/PROJ-roundtrip-${candidate}.md`, import.meta.url), [
      `# PROJ round-trip ${candidate}`, "",
      "Shows projection loss relative to a direct app save; replay with node src/proj/report.ts --write.", "",
      ...losses.flatMap(result => [result.fixture, "", "```json", JSON.stringify(result.savedDifferences, null, 2), "```", ""])
    ].join("\n"));
  }
  const lines = [
    "# Full-document projection experiment results", "",
    "Integration finding fixed in this PR: a new probe found #1392 reused imported tag/link occurrence counters across different fields under both candidates (one identity instead of three). Hydration now namespaces those occurrence keys by origin row and field; the same probe passes after encoded transfer. Existing main at e5b3306a (#1391 plus #1392) passed all 876 pre-existing prototype tests and the 291-fixture app-reference check before this work. This follow-up also makes every projection document use the initialized replica constructor, including receiving and late-joining documents. No established expected trace result changed.", "",
    "## Result", "",
    "The field inventory has **96 rows**. All 96 have locations below, checked against the inventory text. No inventory document was changed.", "",
    "| Candidate | Documents | Original bytes identical | Same bytes as direct app save | Projection-only differences |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];
  for (const candidate of ["A", "B"] as const) {
    const runs = results.filter(result => result.candidate === candidate);
    lines.push(`| ${candidate} | ${runs.length} | ${runs.filter(result => result.byteIdentical).length} | ${runs.filter(result => result.sameAsAppSave).length} | ${runs.filter(result => !result.sameAsAppSave).length} |`);
  }
  lines.push("", "The source bytes are the oracle. `.splitpage` files are read verbatim, including whitespace; JSON fixture subdocuments are rendered with the app's two-space JSON convention before loading. They are not represented as byte goldens the repository never had. Every source path and subdocument is listed below.", "",
    "[`src/proj/results.json`](src/proj/results.json) records every exact changed JSON path with before/after values, all direct-save normalizations and the first differing UTF-8 byte with its surrounding text. A byte difference with no JSON value difference is formatting or key order. These results do not waive the byte-identical requirement.", "",
    "## Mechanisms and departures from artifact 8", "",
    "- A uses the exported SchemaReplica's document with one flow Y.Text and boundary embeds. B uses segments with head fields and one order array. Both use separate visual components, gallery slots, comment/reply maps and ranked registries. No file in the other lane was changed.",
    "- Both preserve import key order in record keys arrays. This is required by the JSON serializer's byte contract; these arrays contain names, never duplicate field values. Unknown data lives only in each record's extra JSON string. defineProperty retains every key during assembly; JSON string encoding avoids both Yjs constructor dispatch and unsafe object-key decoding for arbitrary names.",
    "- Legacy rev, lastEditedAt, lastEditedBy and personColors live in meta.capture. The proposed absence/export regeneration and deriving personColors from people cannot reproduce a historical capture. This is import/export evidence, not a shared edit-stamp policy.",
    "- Comment updatedAt is retained; deriving it from replies cannot reproduce an assignment or reopening timestamp without a change history. Comments keep load rowId/field as fallback; live marks determine the projected anchor and the explicit mark-move command records its new fallback. The concurrent detachment scope is below.",
    "- Comment bodies/replies are atomic sanitized HTML, as the shared-layer write-once body contract specifies. Resolution is one atomic group. Reply keys include commentId to avoid cross-comment id collisions; import rank retains file order rather than sorting existing replies by time.",
    "- Gallery picture data is one coupled JSON value (imageRef, name, annotation); slot identity is minted from origin row and import index, never from content. Links are keyed by the existing href/name/size key. Location stays device-local and is excluded from Yjs; a Yjs-only transfer cannot carry it. Blob bytes also remain external; encoded Yjs sizes exclude them. This corpus carries references, not a successful available-blob byte transfer.",
    "- B-roll embeds retain a label in addition to k because the format accepts marker spelling/case variants. Who embeds retain w. Text attributes use one c:commentId, t:occurrenceId and l:occurrenceId per mark; tag registry ids resolve back to names on export. Rich-text decoding is a bounded prototype parser for already-sanitized app documents, not a replacement sanitizer.",
    "- No joins, soft removals, structural recovery or conflicting status semantics are claimed by this full-document layout. Existing trace lanes own those mechanisms. Shot props now form a map keyed by brollPropKey, with atomic value/rank per member, so independent additions can exceed the format limit without overwriting each other.", "",
    "## Hypotheses", "",
    "| Hypothesis | Evidence in PR 1 |",
    "| --- | --- |",
    "| A-H10 | Refuted as byte-identical for both candidates: projection-only changes listed below, even against a direct app save. Most raw legacy/merge inputs also undergo app migration or JSON formatting. |",
    "| PROJ-cue | Refuted as fully byte-identical with this writer: one stored mid-line cue is removed. Stored/derived comparison covers all six cue-bearing fixtures; the literal unmarked-line test proves line text cannot generally derive the flag. test/proj/cues.test.ts. |",
    "| PROJ-detached | Confirmed for the specified delete-versus-explicit-mark-move scenario with stored fallback, both candidates, D1/dup/rev/late-C and swapped ids. Media null anchor/load location retained; several simultaneous movers remain unproved. test/proj/concurrency.test.ts. |",
    "| PROJ-unknown | Confirmed for encoded transfer and concurrent known-field edits on all seven record kinds, including special-key payloads. Concurrent editing of extra JSON itself is not established. test/proj/review.test.ts and concurrency.test.ts. |", "",
    "Tests: `test/proj/projection.test.ts`. Every candidate has 96 generated missing-mapping declaration checks, independently compared with artifact 2. They do not mutate transport and do not prove it. Behavioral protection is the full exact fixture equality test, the unknown-record transfer test and the explicit titleVersion/paragraphStart/shot-props and highlight-annotation transport tests. A separate deliberate lengthSeconds deletion fails equality with literal R1 lengthSeconds:12.", "",
    "## Opaque values and limits of this evidence", "",
    "Both candidates carry the same opaque values: meta.capture (rev, lastEditedBy, lastEditedAt, personColors); beat stamp (updatedBy, updatedAt); gallery picture groups (imageRef, name, annotation, including annotation.imageRef and the full marks/points array); each record's extra JSON string; gallery extra JSON string; comment resolution group (resolved, resolvedAt, resolvedBy); comment imageValue; each shot-prop member's id/name value; comment and reply body HTML. Prop membership is a keyed set with rank, not one opaque array. Quoted text is a stored immutable snapshot. Import key-order arrays and Candidate B segment heads are atomic metadata; b-roll/who and structural embeds are atomic objects. All other named scalar fields are individual map entries, and text/mark attributes are represented separately.", "",
    "A successful round trip proves these opaque values can be stored and recovered. It says nothing about concurrent edits inside picture/annotation groups, one prop member, color maps, capture/stamp/resolution groups, unknown JSON or body HTML. Their merge granularity is the whole value, and no fine-grained merge claim is made. Highlight marks are exercised by the supplement and a literal marks-array equality test.", "",
    "## Projection-only differences", "",
    "| Candidate | Fixture | Paths |",
    "| --- | --- | --- |"
  );
  for (const result of results.filter(result => !result.sameAsAppSave)) lines.push(`| ${result.candidate} | ${result.fixture} | ${result.savedDifferences.map(diff => diff.path).join(", ")} |`);
  lines.push("", "The unicode-and-atoms fixtures lose a U+200B inside visual text: normalizeCell removes it, while direct migrate/save keeps it. The media-in-cells output loses an audio-cue span on a mid-line SFX fragment: settleCues removes that flag, while direct save retains it. The supplement loses two local link locations, deliberately excluded from shared state by the proposed layout. These are projection differences, not normalizations the app's save applies. The exact strings are in results.json and the minimized histories are histories/PROJ-roundtrip-A.md and histories/PROJ-roundtrip-B.md.", "",
    "## Fixture selection", "",
    "The two immutable v0.3.0 files exercise actual historical on-disk input. Seed plus all starters include the long demo, script formatting, tags, galleries, comments and production lists used by exports-golden. Every complete document under merge goldens exercises input/base/mine/theirs and expected output states, including conflict cards, stamps, ids, ordering, gallery links and sections. Every migrate-golden output exercises the app's already-normalized shapes, including images, annotations and unknown keys. Non-document arrays and hash-only export summaries are not mistaken for full documents.", "",
    "test/proj/supplement.splitpage covers who-anchor, stored paragraph flags, path/bundled locations, hash-only body images, highlight annotations and unknown keys on nested record kinds. Existing fixtures cover full image references and pen/text annotations. The local-location loss is asserted as literal before-values with no after-value. The supplement is not silently normalized to become byte-identical.", "",
    "Review fixtures add the previously missing values A > B and Mira > Nia in quoted attributes, with literal expected complete file bytes. attribute-cases.splitpage checks literal less-than, ampersand, double and single quotes, literal entity text, numeric entities, supplementary Unicode, nonbreaking whitespace and an allowed HTTP href containing quoted-attribute metacharacters. The sanitizer's outputs are checked against literal expected HTML before projection, then again after encoded transfer. special-keys.splitpage checks __proto__, constructor and prototype on documents, rows, comments, replies, people, tags and shots. Those four regressions failed under both candidates before their fixes. No established trace oracle was changed.", "",
    "The sole permitted non-prototype addition is tools/projection-reference.mjs and its tool test. Run `node tools/projection-reference.mjs --write` at the repository root to generate test/proj/app-reference.json from the actual parseSplitpageFile, migrateDocument(file), migrateRows and buildSplitpageFile. Each entry has source and saved byte lengths/SHA-256, the normalized input document, and full saved bytes only when the app save differs from the source. `--check` regenerates and compares the manifest; the tool test checks both a current and deliberately stale manifest. Tools may import the app under the dependency gate; the prototype may not. The prototype no longer imports or launches bootstrap, adapters, a DOM shim or a subprocess, and its tests need only its own npm ci.", "",
    "The prototype serializer accepts those validated plain documents and performs JSON file encoding, including null imageRef to visualImage. Before every experiment it must match the independent app manifest byte length and SHA-256 on every normalized source; otherwise the experiment fails. Projected bytes are compared independently with the app manifest and the original source. This is not evidence for input sanitization, migration of arbitrary merged states, or resolution of available blob bytes.", "",
    "## Per-fixture byte results", "",
    "| Candidate | Fixture | Original bytes identical | Direct app save identical | Projection equals app save |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const result of results) lines.push(`| ${result.candidate} | ${result.fixture} | ${result.byteIdentical ? "yes" : "no"} | ${result.appSaveIdentical ? "yes" : "no"} | ${result.sameAsAppSave ? "yes" : "no"} |`);
  lines.push("", "## Checked field locations", "", "| Inventory field | Candidate A | Candidate B |", "| --- | --- | --- |");
  for (const entry of projectionFieldMapping) lines.push(`| ${entry.field} | ${entry.A} | ${entry.B} |`);
  lines.push("", projectionExtendedReport());
  return lines.join("\n");
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) writeFileSync(new URL("../../projection-results.md", import.meta.url), projectionReport());
