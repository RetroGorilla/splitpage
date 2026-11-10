import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isProjectionEntry } from "../../proj/entry.ts";
import { percentile } from "../measure.ts";
import { lifetimeCategories } from "./attribution.ts";
import { lifetimeTyped } from "./counts.ts";
import { readLifetimeCounts, validateLifetimeCounts, validateLifetimeTimings } from "./record.ts";
import type { LifetimeCountEvidence, LifetimeTimingEvidence } from "./record.ts";
import { readLifetimeSensitivity } from "./sensitivity.ts";
import { statusOrderEvidence } from "./status-order.ts";

const number = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const median = (values: number[]): number => percentile(values, 0.5);
const spread = (values: number[]): string => `${median(values).toFixed(3)} [${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)}]`;

export function lifetimeGrowthSvg(counts: LifetimeCountEvidence): string {
  const colors = ["#2563eb", "#b45309"], width = 760, height = 300, top = 34, bottom = 250, left = 70, right = 720;
  const points = counts.data.realistic.flatMap(row => row.checkpoints), maxX = Math.max(...points.map(point => point.typedCharacters));
  const maxY = Math.max(2 * 1024 ** 2, ...points.map(point => point.bytes.encodedBytes)) * 1.08;
  const x = (value: number): number => left + value / maxX * (right - left), y = (value: number): number => bottom - value / maxY * (bottom - top);
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Candidate B retained state under script-shaped writing</title>',
    '<desc id="desc">Deterministic encoded byte counts against cumulative typed characters for two and six writers; dashed line is the fixed 2 MiB cap.</desc>',
    '<rect width="760" height="300" fill="white"/>', '<g font-family="sans-serif" font-size="12" fill="#172033">',
    `<path d="M${left} ${top}V${bottom}H${right}" fill="none" stroke="#64748b"/>`,
    `<path d="M${left} ${y(2 * 1024 ** 2).toFixed(2)}H${right}" stroke="#b91c1c" stroke-dasharray="5 4"/>`,
    `<text x="${left + 5}" y="${(y(2 * 1024 ** 2) - 6).toFixed(2)}">2 MiB</text>`,
    '<text x="270" y="289">Cumulative typed UTF-16 characters</text>', '<text x="12" y="20">Encoded bytes</text>'];
  for (let index = 0; index < counts.data.realistic.length; index++) {
    const row = counts.data.realistic[index]; assert.ok(row);
    svg.push(`<polyline fill="none" stroke="${colors[index]}" stroke-width="2" points="${row.checkpoints.map(point => `${x(point.typedCharacters).toFixed(2)},${y(point.bytes.encodedBytes).toFixed(2)}`).join(" ")}"/>`,
      `<text x="${90 + index * 140}" y="20" fill="${colors[index]}">${row.writers} writers</text>`);
    for (const point of row.checkpoints) svg.push(`<circle cx="${x(point.typedCharacters).toFixed(2)}" cy="${y(point.bytes.encodedBytes).toFixed(2)}" r="3" fill="${colors[index]}"/>`);
  }
  for (const fraction of [0, 0.5, 1]) svg.push(`<text x="${x(maxX * fraction).toFixed(2)}" y="270" text-anchor="middle">${number(maxX * fraction)}</text>`);
  svg.push("</g>", "</svg>", ""); return svg.join("\n");
}

function timingReport(timing: LifetimeTimingEvidence | undefined, counts: LifetimeCountEvidence): string[] {
  if (!timing || timing.runs.filter(run => run.valid).length !== 5) return ["No complete accepted timing set exists. Counts establish the work removed, not the 30 ms component cap. Any partial/void samples remain excluded from tables.", ""];
  validateLifetimeTimings(timing, counts);
  const valid = timing.runs.filter(run => run.valid), machine = timing.machine;
  const lines = [`Machine: ${machine.cpu?.trim()}, ${machine.platform} ${machine.osRelease} ${machine.architecture}, Node ${machine.node}, ${(machine.totalMemoryBytes / 1024 ** 3).toFixed(2)} GiB RAM, Yjs ${machine.yjs}. Machine/user identifiers and local paths are absent.`, "",
    `Timed source head: ${timing.sourceHead}; source SHA-256: ${timing.source.sha256}. These rows use the merged stored U+200B/cue export repair, superseding the affected historical B remote-character component row. The original perf evidence is retained unchanged.`, "",
    "These are the retained pre-review remote-character rows. The index repair changes only the status-map-change notification handler, which no sampled character transaction invokes. timed-implementation.json archives all nine measured source files; audit.ts verifies their hashes, unchanged sampled projector/driver code and dependencies, and the untouched timing file. All fourteen default attribution/counter checkpoints regenerate identically. No sampled code path's work changed and no rows require retiming. Changed status-notification work is not measured: a status-map change now scans the live event map once to rebuild affected targets in local legacy order.", "",
    "Five whole-set runs, alternating legacy/indexed order each round, three warm-up edits per case and eleven recorded samples per case/run. Reported values are the median of five per-run p50s [min–max]; p95 uses the same per-run aggregation. No pooled samples, discarded outliers or timing assertions in npm test. Background load may have affected accepted runs. A game was running on this PC during the session; the unchanged guards require at least 3 GiB free before each run, CPU at most 35% before/after, no forbidden Edge/pc-hold/heavy-game process, and stop after three consecutive refusals. Locks: perf and smoke. RAM is checked again before each state. Raw samples and void/refusal evidence: src/perf/lifetime/timings.json.", "",
    "| Run | Free GiB before | Background CPU before / after % |", "| --- | ---: | ---: |"];
  for (const run of valid) lines.push(`| ${run.round + 1} | ${(run.before.freeMemoryBytes / 1024 ** 3).toFixed(3)} | ${run.before.cpuBefore.toFixed(2)} / ${run.cpuAfter.toFixed(2)} |`);
  lines.push("", `Refused starts: ${timing.refused.length}; void runs retained: ${timing.runs.filter(run => !run.valid).length}.`, "",
    "| State / phase | Legacy ms p50 [range] | Indexed ms p50 [range] | Legacy / indexed | Beyond fixed noise |", "| --- | ---: | ---: | ---: | --- |");
  const names = valid[0]?.points.map(point => point.name) ?? [];
  for (const name of names) for (const phase of ["applyExcludingIncremental", "incremental", "structure", "component", "capture", "resolve", "withIdentity"]) {
    const samples = (mode: string, quantile: "p50" | "p95" = "p50") => valid.map(run => {
      const value = run.points.find(point => point.name === name)?.modes.find(value => value.mode === mode)?.[quantile][phase]; assert.ok(value !== undefined); return value;
    });
    const a = samples("legacy"), b = samples("indexed"), tolerance = (values: number[]) => Math.max(Math.max(...values) - Math.min(...values), 0.15 * median(values), 0.5);
    const different = Math.abs(median(a) - median(b)) > Math.max(tolerance(a), tolerance(b));
    lines.push(`| ${name} / ${phase} | ${spread(a)} | ${spread(b)} | ${(median(a) / median(b)).toFixed(3)}x | ${different ? `${median(a) > median(b) ? "indexed" : "legacy"} cheaper` : "no difference beyond noise"} |`);
  }
  lines.push("", "| State | Indexed component p50 [range] ms | Indexed component p95 [range] ms | p50 ≤30 ms / p95 ≤50 ms (Node component) |", "| --- | ---: | ---: | --- |");
  for (const name of names) {
    const samples = (quantile: "p50" | "p95") => valid.map(run => { const value = run.points.find(point => point.name === name)?.modes.find(mode => mode.mode === "indexed")?.[quantile].component; assert.ok(value !== undefined); return value; });
    const p50 = samples("p50"), p95 = samples("p95");
    lines.push(`| ${name} | ${spread(p50)} | ${spread(p95)} | ${median(p50) <= 30 ? "met" : "FAILED"} / ${median(p95) <= 50 ? "met" : "FAILED"} |`);
  }
  lines.push("", "applyExcludingIncremental is the outer Yjs apply interval minus measured projector callbacks; it includes decoding, integration and transaction cleanup. incremental is those synchronous callbacks. structure is the old diagnostic reader or its indexed replacement. component sums apply, incremental and structure; capture/resolve are separate editing-buffer identity passes, withIdentity also includes them. The timer brackets identity verification. Preparation, state load, initial full projection and index construction are outside samples; every mode starts from the same hashed state, then accumulates the declared warm-up/sample x characters.", "");
  return lines;
}

export function lifetimeReport(counts: LifetimeCountEvidence, timing?: LifetimeTimingEvidence): string {
  validateLifetimeCounts(counts);
  const lines = ["# Candidate B: writing lifetime, retained bytes and remote-character work", "",
    "**Blocking T21 scalar finding:** the unchanged legacy status fallback depends on replica-local map iteration order. Two replicas with byte-identical encoded state read ready and shot; a late joiner reads shot in the minimized author-1/author-2 example. Across 24 delivery permutations, two author-id assignments, and with/without deleting and recreating c, 80 of 96 cases disagree (40/48 in each recreation condition). This is a status-design finding, not an index resolution policy. The index now matches each replica's local legacy result; the legacy reader remains unchanged. Minimized history: [T21-scalar-map-order.md](histories/T21-scalar-map-order.md); every observation: src/perf/lifetime/status-order.json. Byte-identical state and identical event records do not imply identical order for this fallback.", "",
    "This follow-up studies the selected stable-segment candidate B. It does not select a schema, design compaction or establish a production lifetime. One modeled canonical draft plus its stated revision is the small lifetime control; larger horizons append the same canonical structure as the existing SCALE fixture does. Two/six writers alternate whole beats with causal delivery between turns, not simultaneous conflicting keystrokes. The M1 queue and app binding are not instantiated here.", "",
    `Source SHA-256: ${counts.source.sha256}; dependency SHA-256: ${counts.source.dependencies}; canonical input SHA-256: ${counts.source.fixture}. Counts have no clock. Node ${counts.node}; pinned Yjs 13.6.33. All limits remain those of artifact 7: 2,097,152 encoded bytes, fresh ≤3x/export and heavily edited ≤10x/export, remote visible-character p50 ≤30 ms / p95 ≤50 ms. A Node component can fail these latency ceilings; passing it does not prove message-to-frame.`, "",
    "## Stated writing scenario", "",
    "The repository contains no observed human correction or revision rate. These are reproducible scenario parameters derived from its fixture/trace/recorder constants, not a claim about typical writers. They replace the earlier metadata-heavy stress mix, not its findings.", "",
    "| Parameter | Literal value and repository justification |", "| --- | --- |"];
  for (const [key, value] of Object.entries(counts.data.plan.sources)) lines.push(`| ${key} | ${value} |`);
  lines.push("", "The canonical 30-beat long demo supplies both narration and visuals, marks, four comment records, 31 tag records, two people and shot metadata. The structure/registries are created first with empty text. Each text string is inserted one UTF-16 unit per transaction, consecutive positions by one writer; protected who/b-roll atoms are inserted as atoms. After each 55 original text units, backspace/retype that unit. Later, five beats have the first half of narration replaced by text from the following canonical beat, typed in a run. Each block then receives five splits and five per-writer joins followed by semantic retirement; the split boundaries remain. Five unsplit last beats move to the front through the existing first-occurrence segment-order mechanism. Two beats are soft-removed; one is explicitly restored. Each original beat receives ready then shot, each comment/tag one review update. Ten hash-only pictures are inserted once for the entire script. Blocks after the first reuse people/tags and retarget canonical beat/comment/shot ids.", "",
    "A backspace is one character deletion; each revision deletion is one range command. Operation counts below exclude delivery/initial metadata and count character insert transactions individually. Typed characters include original typing, correction retyping and revision typing, excluding protected-atom labels. Final-script characters include displayed atom labels and both text cells of active beats, excluding title/headings and soft-removed content. They are UTF-16 units. Contiguous typing share counts character inserts in those runs, including retyping; it is not an observed human activity share.", "",
    "| Writers / blocks | Typed characters | Final-script characters | Character-insert operations / all operations | Contiguous typing share |", "| --- | ---: | ---: | ---: | ---: |");
  for (const row of counts.data.realistic) for (const point of row.checkpoints) {
    const total = Object.values(point.operations).reduce((sum, value) => sum + value, 0), typed = lifetimeTyped(point.operations);
    lines.push(`| ${row.writers} / ${point.blocks} | ${number(typed)} | ${number(point.finalCharacters)} | ${number(typed)} / ${number(total)} | ${(100 * typed / total).toFixed(3)}% |`);
  }
  lines.push("", "The earlier 50,100-operation stress history has 45,000 character inserts in 60-character typing and 15-character retyping runs: 89.820% contiguous inserts (60% original typing within each nominal 100-operation cycle). It starts with large already imported, uses 500 split/join/retire cycles, 600 retained removal records and 1,000 status events. Its removals capture one identity object per observed unit and repeatedly retain this data; the writing-shaped scenario removes two beats per 30-beat block instead.", "",
    "## Encoded growth and the fixed cap", "", "![Deterministic writing growth](src/perf/lifetime/growth.svg)", "",
    "| Writers / blocks | Encoded bytes | Bytes / 1,000 final characters | Bytes / 1,000 typed characters | Active export bytes | Encoded / export | ≤2 MiB / ≤10x |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const row of counts.data.realistic) for (const point of row.checkpoints) lines.push(`| ${row.writers} / ${point.blocks} | ${number(point.bytes.encodedBytes)} | ${(1000 * point.bytes.encodedBytes / point.finalCharacters).toFixed(1)} | ${(1000 * point.bytes.encodedBytes / point.typedCharacters).toFixed(1)} | ${number(point.exportedFileBytes)} | ${(point.bytes.encodedBytes / point.exportedFileBytes).toFixed(3)}x | ${point.bytes.encodedBytes <= 2 * 1024 ** 2 ? "met" : "FAILED"} / ${point.bytes.encodedBytes <= 10 * point.exportedFileBytes ? "met" : "FAILED"} |`);
  lines.push("", "Active export is the prototype's .splitpage serialization with removed rows omitted, retaining registries/comments; it is not an integrated production recovery export. Raw evidence also keeps full projected-file bytes. Neither ratio hides the independent 2 MiB limit. No blob payload is encoded.", "",
    "| Writers | First edit-group checkpoint ≥2 MiB | Final-script characters then | Typed characters then | Previous checkpoint bytes / typed characters |", "| --- | ---: | ---: | ---: | ---: |");
  for (const row of counts.data.realistic) lines.push(`| ${row.writers} | ${number(row.firstCap.encodedBytes)} | ${number(row.firstCap.finalCharacters)} | ${number(row.firstCap.typedCharacters)} | ${number(row.firstCap.previousStep?.encodedBytes ?? 0)} / ${number(row.firstCap.previousStep?.typedCharacters ?? 0)} |`);
  const sensitivity = readLifetimeSensitivity(); assert.deepEqual(sensitivity.source, counts.source);
  lines.push("", "### Sensitivity to stated intervention frequencies", "",
    "These reproduce the reviewer's sensitivity results with the committed generator: two writers, one parameter changed at a time, identical canonical fixture and all remaining interventions unchanged. Doubling corrections means two per 55 original text units, spaced at alternating 28/27-unit intervals. Borrowing intervention frequencies from fixtures does not establish human writing rates; the block-36 baseline is scenario-dependent, not a human-lifetime guarantee.", "",
    "| Scenario | Corrections / 55 original units | Status changes / beat | Removals / block | Partly revised beats / 30 | First ≥2 MiB block |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of sensitivity.rows) lines.push(`| ${row.name} | ${row.parameters.correctionsPer55} | ${row.parameters.statusesPerBeat} | ${row.parameters.removals} | ${row.parameters.revisionBeats} | ${row.firstCap.block} |`);
  lines.push("", "Encoded size is checked after every causal edit group (one beat's typing, one revision, one structural/review command group), including creation of blank block metadata. The crossing is bracketed by adjacent group checkpoints, not interpolated to an unmeasured keystroke. Writing stops after finishing the first crossing block; maxBlocks=80 is a fail-fast harness horizon, not a product limit.", "",
    "## What occupies the encoded state", "",
    "The diagnostic wraps pinned Yjs Item.write while encodeStateAsUpdate emits V1 bytes. Encoder length before/after each actual write measures that item's wire bytes, including identity/origin/parent and content encoding. No root is destructively edited and no estimate or counterfactual is used. Attribution is exclusive: removal records; join entry bodies/retired ids; status events/retired status; soft-removed beat metadata, text, visuals/gallery; remaining deleted text; live formatting items; live text/atoms; order; other. Boundaries and shared container metadata can be in other. Other also includes the residual client/struct framing, delete sets and GC structs. The nine categories sum exactly to the encoded byte length; root-removal marginal differences would overlap through shared framing, so they are not presented as additive categories.", "",
    "The synthetic history's 77.03% removal-record share reflects this prototype recording and retaining one identity object per removed character. That representation/retention cost has not been shown inherent to stable segments or to Yjs.", "",
    "| State | " + lifetimeCategories.join(" | ") + " | Total bytes |", "| --- | " + lifetimeCategories.map(() => "---:").join(" | ") + " | ---: |");
  const points = [...counts.data.realistic.flatMap(row => row.checkpoints.map(point => ({ name: `${row.writers} writers / ${point.blocks} blocks`, point }))),
    ...counts.data.synthetic.checkpoints.map(point => ({ name: `synthetic / ${point.operations} operations`, point }))];
  for (const { name, point } of points) lines.push(`| ${name} | ${lifetimeCategories.map(key => number(point.bytes.categories[key])).join(" | ")} | ${number(point.bytes.encodedBytes)} |`);
  lines.push("", "Other is broken down below so live schema/container/registry overhead is visible. These are only the items assigned to other, grouped by their actual root; framing/delete-set/GC bytes are a separate residual. Marks are live Yjs ContentFormat items; registry bodies are other. Deleted text tombstones include deleted items in text types whose original content/format distinction may already be erased by GC. Soft-removed content includes its associated old text/formatting items and beat/visual/gallery records; persistent removal observations have their own category.", "",
    "| State | Other item bytes by root | Framing / delete sets / GC bytes |", "| --- | --- | ---: |");
  for (const { name, point } of points) lines.push(`| ${name} | ${Object.entries(point.bytes.otherRoots).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}: ${number(value)}`).join("; ")} | ${number(point.bytes.framingDeleteSetAndGcBytes)} |`);
  lines.push("", "### Undo retention", "",
    "The main growth rows use gc=true with no active UndoManager, as the earlier growth run did. Durable per-writer joins, retirement ids, status events/retirements and removal observations remain encoded. They do not rely on an in-memory undo stack. The separate one-block control creates one origin-filtered UndoManager per writer, stops capture at each deterministic command/beat boundary, and stays below the plan's 200-entry bound. It does not establish long-session grouping, parking or production history ownership.", "",
    "| Writers / local writer | Stack entries | Insert / delete ranges held | Local encoded bytes while undo retained | Server/master encoded bytes |", "| --- | ---: | ---: | ---: | ---: |");
  for (const row of counts.data.undo) for (const writer of row.localWriters) lines.push(`| ${row.writers} / ${writer.writer} | ${writer.stackEntries} | ${writer.insertionRanges} / ${writer.deletionRanges} | ${number(writer.encodedBytesWhileUndoRetained)} | ${number(row.masterBytes)} |`);
  lines.push("", "The stack adds in-memory insertion/deletion ranges, metadata and kept deleted items; it is not serialized by encodeStateAsUpdate. Kept deleted payload and associated item fragmentation can enlarge a writer's encoded local state while its stack is live, as measured here. A server/late joiner does not obtain that stack. Heap bytes and long-lived bounded undo retention are not measured; the no-stack horizon must not be sold as a complete persisted-undo lifetime.", "",
    "## Remote-character work before clocks", "",
    "Counters wrap the actual Y.Map iterators/get/has, order toArray and text toDelta calls. A record scan is a yielded map entry; order/text item visits count physical linked-list nodes including formatting/deleted nodes in those named traversals, not characters. Separate pinned-source instrumentation counts public relative/absolute identity loops and struct-store probes. Counter overhead is excluded from timing runs. Remote update construction is explicitly a prepare phase and excluded from the displayed apply/projector counts. Yjs integrate counts newly integrated Item structs. The delivered update is the actual Yjs update event emitted by one character transaction, as in the original edit recorder; a full-state-vector diff would unnecessarily resend historical deletion ranges. Its decoded delete-set range count is shown.", "",
    "| State | Update bytes / delete ranges | Legacy status records scanned | Indexed status records scanned | Incremental order values / physical items | Incremental text reads / item visits | Join keys / retired-id probes | Removal-record scans |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { name, point } of points) {
    const legacy = point.legacy.work, indexed = point.indexed.work;
    lines.push(`| ${name} | ${number(point.indexed.value.updateBytes)} / ${point.indexed.value.deleteSetRanges} | ${number(legacy.structure.records.statusEvents ?? 0)} | ${number(indexed.structure.records.statusEvents ?? 0)} | ${indexed.incremental.orderValues} / ${indexed.incremental.orderItems} | ${indexed.incremental.textReads} / ${indexed.incremental.textItems} | ${indexed.structure.records.joins ?? 0} / ${indexed.structure.gets.retiredJoins ?? 0} | ${(indexed.incremental.records.removalRecords ?? 0) + (indexed.structure.records.removalRecords ?? 0)} |`);
  }
  lines.push("", "| State | Apply integrated items / store probes | Incremental records scanned: visuals / gallery / comments / replies / shots / tags |", "| --- | ---: | ---: |");
  for (const { name, point } of points) {
    const work = point.indexed.work;
    lines.push(`| ${name} | ${work.apply.integratedItems} / ${work.apply.storeProbes} | ${["visuals", "gallery", "comments", "replies", "shots", "tags"].map(root => work.incremental.records[root] ?? 0).join(" / ")} |`);
  }
  lines.push("", "| State | Painted units / public captures | Capture forward item visits | Resolve backward / verification-forward / store probes | Remote apply / projector identity visits |", "| --- | ---: | ---: | ---: | ---: |");
  for (const { name, point } of points) {
    const work = point.indexed.work;
    lines.push(`| ${name} | ${point.indexed.value.characters} | ${number(work.capture.relativeItems)} | ${work.resolve.absoluteItems} / ${work.resolve.relativeItems} / ${work.resolve.storeProbes} | ${work.apply.relativeItems + work.apply.absoluteItems} / ${work.incremental.relativeItems + work.incremental.absoluteItems} |`);
  }
  lines.push("", "The repeated all-events scan belongs to perfStructureView/statusValue in this prototype, not the segment schema or a Yjs requirement. IndexedStructureProjection keeps events by target and a cached resolved frontier value, invalidating only targets changed by status/retirement events. Initial construction scans all current events once outside edits. A status-map change now rebuilds affected target lists with one traversal of the live event map, preserving that replica's key order even after deletion/recreation; its changed cost is unmeasured. Resolution then examines that target's causal history; no causal event is reclaimed. Per-character status-history scans remain zero. The view, resolution, character probe and sampled driver methods remain unchanged, as the source audit verifies. Full-document and structural-reader agreement are checked after every step of literal seeds 17, 1376 and 50100, including deletion and recreation of status events and a separate check between those two transactions. Local equivalence does not repair the cross-replica T21 finding at the top.", "",
    "Remaining scans include global order/spans and plain-record/visual/gallery/comment projection, plus current-beat join entries and retirement membership probes. They grow with script/retained structure in this projector; indexes and affected-beat publication could reduce them. RemovalRecords are not scanned on this remote-character path, so a large byte cost is not evidence of a time cost here. Yjs still integrates the update and its delete set and performs identity-store searches; those library costs are distinguished from the prototype's avoidable repeated status scan. No claim is made that every internal Yjs traversal is counted.", "",
    "## One guarded Node timing set", "", ...timingReport(timing, counts),
    "## Bounded conclusion and retention question", "");
  for (const row of counts.data.realistic) {
    const first = row.checkpoints[0], last = row.checkpoints.at(-1); assert.ok(first && last);
    const retention = (["deleted text tombstones", "soft-removed beat content", "removal records", "join records and retired ids", "status events"] as const)
      .map(category => ({ category, bytes: last.bytes.categories[category] })).sort((a, b) => b.bytes - a.bytes)[0]; assert.ok(retention);
    lines.push(`With ${row.writers} writers, one canonical draft plus revision retains ${number(first.bytes.encodedBytes)} bytes for ${number(first.finalCharacters)} final-script / ${number(first.typedCharacters)} typed characters. The first observed 2 MiB crossing is ${number(row.firstCap.finalCharacters)} final-script / ${number(row.firstCap.typedCharacters)} typed characters, at ${number(row.firstCap.encodedBytes)} encoded bytes. At the final checkpoint the largest named durable-history category is ${retention.category}, ${number(retention.bytes)} bytes.`, "");
  }
  lines.push("This is evidence for the stated script-shaped history, not a general human lifetime or unlimited revisions. One block and the ten-block large analogue are separately reported, and the timing table, when complete, states exactly which Node components meet 30/50 ms. It cannot establish a browser message-to-frame pass, full M1 behavior or heap/load budgets. The encoded-state cap remains a real visible capacity limit even where the export ratio passes; neither live script content nor unresolved recovery may be silently dropped to get under it.", "",
    "The first policy question concerns the measured growing history categories: removal records retain observed identities/context after restore, soft-removed text stays recoverable, joins/retired ids preserve semantic undo, and status events preserve causal frontier/prior choices. A retention rule would have to say which of that information remains recoverable/undoable and which historical records may be dropped; current live text, marks, registries and active order are not disposable history. No reclamation algorithm or change to the provisional caps is proposed.", "",
    "## Reproduction", "", "```text", "node src/perf/lifetime/status-order.ts --write", "node src/perf/lifetime/sensitivity.ts --write", "node src/perf/lifetime/record.ts --counts", "node src/perf/lifetime/record.ts --check", "node src/perf/lifetime/report.ts --write", "node src/perf/lifetime/report.ts --check", "npm test -- --test-concurrency=1", "```", "",
    "Run from prototypes/collab with Node 24.22.1. Set TEMP/TMP to <temp>/splitpage-lanes/s1a-perf. Count snapshots are temporary and hashed in counts.json. For the single authorized timing set, hold perf,smoke through <lane-tools>/with-lock.ps1 and run node --expose-gc src/perf/lifetime/record.ts --time. Do not run tests concurrently. --check validates source/method/shape, never wall-clock thresholds. No app, browser or server suite is part of this experiment.", "");
  const statusOrder = statusOrderEvidence(); assert.equal(statusOrder.total, 96); assert.equal(statusOrder.disagreements, 80);
  return lines.join("\n");
}

if (isProjectionEntry(import.meta.url)) {
  const counts = readLifetimeCounts(), timing = existsSync(new URL("timings.json", import.meta.url)) ? JSON.parse(readFileSync(new URL("timings.json", import.meta.url), "utf8")) as LifetimeTimingEvidence : undefined;
  const report = lifetimeReport(counts, timing), svg = lifetimeGrowthSvg(counts);
  if (process.argv.includes("--write")) { writeFileSync(new URL("../../../lifetime-results.md", import.meta.url), report); writeFileSync(new URL("growth.svg", import.meta.url), svg); }
  if (process.argv.includes("--check")) { assert.equal(readFileSync(new URL("../../../lifetime-results.md", import.meta.url), "utf8"), report); assert.equal(readFileSync(new URL("growth.svg", import.meta.url), "utf8"), svg); }
}
