import { readFileSync, writeFileSync } from "node:fs";
import { runConcurrentProjections } from "./concurrency.ts";
import { runDetachedProjections } from "./detached.ts";
import { runProjectionLimits } from "./limits.ts";
import { runCueProjections } from "./cues.ts";
import { differences } from "./experiment.ts";
import { records } from "./value.ts";
import type { measureProjectionCosts } from "./costs.ts";

export function projectionEvidence() {
  const concurrent = runConcurrentProjections().map(result => ({
    candidate: result.candidate, order: result.order, swapped: result.swapped, name: result.name,
    replicas: result.documents.length, passed: result.documents.every(document => differences(result.expected, document).length === 0)
  }));
  const detached = runDetachedProjections().map(result => ({
    candidate: result.candidate, order: result.order, swapped: result.swapped,
    moved: result.moved.map(document => ({ rows: records(document.rows).map(row => row.audioText),
      comments: records(document.comments).map(comment => ({ id: comment.id, rowId: comment.rowId, field: comment.field, anchorId: comment.anchorId })) })),
    detached: result.detached.map(document => ({ rows: records(document.rows).map(row => row.audioText),
      comments: records(document.comments).map(comment => ({ id: comment.id, rowId: comment.rowId, field: comment.field, anchorId: comment.anchorId })) }))
  }));
  const limits = runProjectionLimits();
  const cues = runCueProjections();
  return { concurrent, detached, limits, cues };
}

function numeric(value: number): string { return value.toFixed(3); }

function timing(value: { median: number; min: number; max: number }): string {
  return `${numeric(value.median)} [${numeric(value.min)}–${numeric(value.max)}]`;
}

export function projectionExtendedReport(): string {
  const evidence = projectionEvidence();
  const costs = JSON.parse(readFileSync(new URL("cost-results.json", import.meta.url), "utf8")) as ReturnType<typeof measureProjectionCosts>;
  writeFileSync(new URL("experiment-results.json", import.meta.url), "{\n" + Object.entries(evidence).map(([key, values]) =>
    JSON.stringify(key) + ":[\n" + values.map(value => JSON.stringify(value)).join(",\n") + "\n]").join(",\n") + "\n}\n");
  for (const candidate of ["A", "B"] as const) for (const family of ["people", "tags", "gallery", "props", "poster", "heading"] as const) {
    const result = evidence.limits.find(result => result.candidate === candidate && result.family === family && result.seed === 1 && result.order === "D1" && result.level === (family === "gallery" ? 62 : family === "props" ? 41 : 2));
    if (!result) throw new Error("Missing minimized limit history");
    writeFileSync(new URL(`../../histories/PROJ-limit-${family}-${candidate}.md`, import.meta.url), [
      `# PROJ ${family} ${candidate}`, "",
      "Shows a merged domain-limit violation or omitted heading after two individually valid operations.", "",
      `Seed ${result.seed}; per-replica measures before delivery ${result.individually.join(", ")}; limit ${result.limit}.`,
      `Client ids: A=${result.clientA}, B=${result.clientB}, seed=10.`,
      ...result.steps,
      ...result.history,
      `Projection measure ${result.projected}; after app load/save ${result.afterAppSave}; resave stable ${result.stableAppSave}.`,
      `Retained shared objects: ${result.retainedSharedObjects}; full encoded state unchanged by projection.`,
      `Projected heading ids: ${result.headings.join(", ") || "none"}.`, "",
      "App normalization differences:", "```json", JSON.stringify(result.appChanges, null, 2), "```", ""
    ].join("\n"));
  }
  const lines = [
    "## Concurrent field projection", "",
    "64/64 candidate/case/order/client-id runs match the hand-written field outcomes: different scalars on one beat, fields on different beats, one narration character against a scalar edit, and known metadata edits on records carrying unknown extras. D1, duplicate, reverse and late-C delivery all pass, with both client-id assignments. The exact complete documents are checked before app normalization, so equally wrong replicas fail. All 64 app-reference results parse and resave stably.", "",
    "Unknown extras survive known-field edits on the document, beat, comment, reply, person, tag and shot. The concurrent seed includes own __proto__ keys on all seven kinds and constructor/prototype at the document level. This confirms PROJ-unknown for these edits, not concurrent editing of extra JSON itself.", "",
    "16/16 PROJ-detached runs pass both candidates, four delivery orders and both client-id assignments. Alice deletes every original marked character while Bob explicitly moves the mark to R2; the live anchor derives R2/audioText, and a subsequent deletion of the moved words retains R2/audioText. The media input is produced by core mediaComments from a hash-only image and keeps its literal null anchor, body and load row/field. The move command records the fallback inside its transaction; removing that write fails the subsequent-detachment oracle. A separate test leaves the stored fallback stale, proves live marks determine the projected row, and verifies projection does not repair shared state. Several simultaneous movers, fallback arbitration across different fields, joins and recovery UI are not established.", "",
    "Tests: test/proj/concurrency.test.ts. No real editor hook was added. Production would need validated semantic mark-move commands to maintain last-location fallback; arbitrary raw formatting operations do not provide that contract.", "",
    "## Merged-state limits", "",
    "520 deterministic runs: seeds 1, 7, 23, 91, 313; both candidates; D1, duplicate, reverse and late-C. The generator varies ranks and operation identities. Each side is checked against the named limit before delivery. Every merged result converges, and every app-produced file parses and resaves stably. Convergence and stable serialization do not establish a valid merged domain.", "",
    "| Limit | Control | Just past | Projection in both candidates | App load/save |",
    "| --- | --- | --- | --- | --- |",
    "| Unique person names | distinct names, multiplicity 1 | two ids with one name | retains both, multiplicity 2 | retains both; uniqueness remains broken |",
    "| Unique tag keys per category | different existing tags renamed to distinct keys | different existing tags concurrently renamed to one category/name | retains both, multiplicity 2 | retains both; uniqueness remains broken |",
    "| Pictures | 60 and 61 total | 62 total | returns all 62, no recovery entry | keeps first 61, drops the last from the plain export |",
    "| Shot props | 40 | 41 | retains all 41 set members | keeps first 40, drops the last from the plain export |",
    "| Poster per link list | both writers select the same poster, 1 | writers select different posters, 2 | returns both true flags | keeps first poster, clears the later flag |",
    "| Header per beat | two headers on different beats, 1 per beat | two headers before one beat | returns the later heading, omits the earlier one; no recovery entry | cannot restore the omitted heading |", "",
    "Artifact 2's open question says 60 pictures; its field row allows 60 moreImages after the first picture, and artifact 8 explicitly says 61 total. The experiment covers 60, 61 and 62 rather than silently choosing one wording. No limit was invented or changed.", "",
    "These are negative feasibility findings. The projection does not implement a complete overflow/recovery or uniqueness policy. Gallery state keeps the extra slot, props state keeps the extra member, and both heading objects/text remain in Yjs, but the plain projection/export cannot claim to include unresolved material it omits. Minimized seed-1 D1 histories are histories/PROJ-limit-{people,tags,gallery,props,poster,heading}-{A,B}.md; exact normalization paths and all delivery observations are in src/proj/experiment-results.json. Tests: test/proj/limits.test.ts. This does not establish status conflicts, duplicate b-roll-key reassignment or gallery replacement-versus-reorder semantics.", "",
    "## Cue hypothesis", "",
    "All six canonical documents holding cue spans were transferred to initialized receiving replicas under both candidates, then projected with stored cues and with line-derived cues. The two modes produce identical documents on this corpus: the known mid-line cue loss remains, as do unrelated U+200B differences. A literal control with one marked SFX line and one intentionally unmarked SFX line proves full derivation invents a cue flag on the unmarked line. Thus PROJ-cue is not confirmed as byte-identical with this writer, and the flag is not generally derivable from line text alone. Tests: test/proj/cues.test.ts; exact differences in experiment-results.json.", "",
    "## Measured cost", "",
    `Measured ${costs.measuredAt} on ${costs.machine}, ${costs.cpu?.trim()}, ${costs.platform} ${costs.osRelease} ${costs.architecture}, Node ${costs.node}, Yjs ${costs.yjs}. ${costs.rounds} measured runs per fixture/candidate, one declared warmup each, A/B order alternated by round. All samples are retained in src/proj/cost-results.json; table entries are median [min–max], milliseconds.`, "",
    `Free RAM before/after: ${(costs.freeMemoryBefore / 1073741824).toFixed(2)}/${(costs.freeMemoryAfter / 1073741824).toFixed(2)} GiB. Aggregate CPU busy during the batch: ${costs.aggregateCpuBusyPercent.toFixed(1)}%. Other lanes were running. No browser, server, app or renderer was used for these measurements.`, "",
    "| Fixture | Candidate | .splitpage bytes | Encoded state bytes | Ratio | fromDocument ms | Full toDocument ms | After one character ms |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | --- |"
  ];
  for (const cost of costs.rows) lines.push(`| ${cost.fixture} | ${cost.candidate} | ${cost.fileBytes} | ${cost.encodedBytes} | ${cost.ratio.toFixed(3)}x | ${timing(cost.fromDocumentMs)} | ${timing(cost.fullToDocumentMs)} | ${timing(cost.afterCharacterMs)} |`);
  lines.push("",
    "The largest canonical fixture is the 30-beat long demo. large uses the recorder's SCALE.grow algorithm: ten copies, fresh row/comment/shot ids and markup references, people/tags kept once. It has 300 beats and the same 334,208 .splitpage bytes as Stage 0. The producer and its input hash are checked against the independent app manifest. A generator test pins suffix behavior and registry sharing.", "",
    "fromDocument includes fresh document construction and rich-text hydration, but excludes file parsing, app migration, encoding and network decode. Projection timings call toDocument on the imported writer replica; encodeStateAsUpdate is measured for size outside the timing. Untimed checks require exact full-document equality before measurement and exactly one changed narration field after the edit. The edit is one character in the middle beat, with explicit empty attributes; the after-edit timing excludes the edit itself and those checks. Both implementations still perform a full projection. Neither exposes an incremental projection API; stable segments alone have not made Candidate B incremental. Repeated global component/gallery sorting and scanning are prototype costs, not a lower bound for either representation.", "",
    "All four fresh-state ratios are below Stage 0's provisional 3x import bound on these reference-only fixtures. No heavily edited 10x-growth or 2 MiB case, available image bytes, heap, server, rendering, join load or standalone A/B budget is measured. The large full/after-edit CPU medians exceed the 30 ms visible-character projection budget before any paint, so these implementations do not establish that budget. Node warm timings cannot be substituted for the required message-to-frame p50/p95 browser measurements. No outliers were discarded; the min–max ranges show the local noise. These are prototype-quality numbers and do not select a schema.", "",
    "## Reproduction and remaining limits", "",
    "From the repository root, with root dependencies installed only for the app-reference producer:", "",
    "```text",
    "node prototypes/collab/src/proj/experiment-inputs.ts --write",
    "node tools/projection-reference.mjs --write --input prototypes/collab/test/proj/experiment-inputs.json --manifest prototypes/collab/test/proj/experiment-reference.json",
    "node tools/projection-reference.mjs --check",
    "node tools/projection-reference.mjs --check --input prototypes/collab/test/proj/experiment-inputs.json --manifest prototypes/collab/test/proj/experiment-reference.json",
    "node prototypes/collab/src/proj/costs.ts --write",
    "node prototypes/collab/src/proj/report.ts --write",
    "cd prototypes/collab",
    "npm test -- --test-concurrency=1",
    "```", "",
    "The root tool consumes data files only; no tool imports the prototype and no prototype imports app/bootstrap/adapters. Its experiment mode checks parse, load, save, reopen and resave using the real app, and a stale input digest fails prototype tests. All projection-created documents, including receiving and late-joining replicas, use the initialized SchemaReplica constructor plus the projection's headings root. No schema/model/reader/oracle/structure file from another lane was edited.", "",
    "Neither candidate's full-document layout is a production integration of the structural/mark/status trace reader. The five canonical differences, device-local locations, absent blob resolution, unresolved merged limits, full-scan projection, coupled/opaque field granularity and unproven multi-mover fallback remain explicit limitations. No schema is recommended.", ""
  );
  return lines.join("\n");
}
