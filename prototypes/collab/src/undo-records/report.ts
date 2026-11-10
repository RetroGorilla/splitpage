import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import { replacementIntentFixtures } from "../../test/buffer-replacements.ts";
import { attempt, bufferOrders, runBufferTrace, runReplacement } from "../../test/undo-records/buffer-runner.ts";
import { runDoubleDelete, runIdenticalRemoval, runIdenticalTag, runInsideRange, runPositionControl, runRedoAfterRemote, runRejoin, runReRemoval, runRestoredChain, runSequentialStatus } from "../../test/undo-records/cases.ts";
import type { CaseResult } from "../../test/undo-records/cases.ts";
import { recordTraces, runRecord } from "../../test/undo-records/runner.ts";
import { boundCounts, measureKinds, runBoundHistory } from "./measure.ts";

interface Row {
  name: string;
  orders: string;
  passed: number;
  total: number;
  failures: string[];
}

function fixtureRows(): Row[] {
  const rows: Row[] = [];
  for (const [trace, orders] of Object.entries(recordTraces)) {
    for (const swapped of trace === "T06" ? [false, true] : [false]) {
      const runs = orders.map(order => runRecord(trace, order, swapped));
      rows.push({ name: `${trace}${swapped ? " (swapped client ids)" : ""}`, orders: orders.join(", "), passed: runs.filter(run => !run.failure).length, total: runs.length, failures: runs.flatMap(run => run.failure ? [`${run.order}: ${run.failure}`] : []) });
    }
  }
  for (const trace of bufferTraceOrder) {
    const orders = bufferOrders(bufferOracles[trace].orders);
    const failures = orders.flatMap(order => { const failure = attempt(() => runBufferTrace(trace, order)); return failure ? [`${order}: ${failure}`] : []; });
    rows.push({ name: `${trace} undo half, M1`, orders: orders.join(", "), passed: orders.length - failures.length, total: orders.length, failures });
  }
  for (const fixture of replacementIntentFixtures) {
    const orders = bufferOrders(fixture.orders);
    const failures = orders.flatMap(order => { const failure = attempt(() => runReplacement(fixture, order)); return failure ? [`${order}: ${failure}`] : []; });
    rows.push({ name: `replacement: ${fixture.name}, M1`, orders: orders.join(", "), passed: orders.length - failures.length, total: orders.length, failures });
  }
  return rows;
}

function caseRow(name: string, orders: string, runs: CaseResult[]): Row {
  return { name, orders, passed: runs.filter(run => !run.failure).length, total: runs.length, failures: runs.flatMap(run => run.failure ? [run.failure] : []) };
}

function history(title: string, line: string, run: CaseResult): string {
  return [`${line}`, "", "Replay: `node --test test/undo-records/cases.test.ts`.", "", `# ${title}`, "", `Failure: ${run.failure ?? "unexpected pass"}`, "", "```text", ...run.history, "```", ""].join("\n");
}

export function undoRecordReport(): { files: Map<string, string>; markdown: string; failures: string[] } {
  const files = new Map<string, string>();
  const identical = ["D1", "dup", "rev", "late-C"] as const;
  const follow = ["D2", "dup", "late-C"] as const;
  const fixtures = fixtureRows();
  const both = [false, true].flatMap(swapped => (["Alice", "Bob"] as const).map(first => ({ swapped, first })));
  const removals = identical.flatMap(order => both.map(({ swapped, first }) => runIdenticalRemoval(order, swapped, first)));
  const cases = [
    caseRow("Identical simultaneous removal; either writer undoes first; both client-id orders", identical.join(", "), removals),
    caseRow("Identical simultaneous tag; either writer undoes first; both client-id orders", identical.join(", "), identical.flatMap(order => both.map(({ swapped, first }) => runIdenticalTag(order, swapped, first)))),
    caseRow("Intentional rejoin after both joins were retired; the other writer's stale undo", identical.join(", "), identical.map(order => runRejoin(order))),
    caseRow("Intentional re-removal after both removals were undone; the other writer's stale undo", identical.join(", "), identical.map(order => runReRemoval(order))),
    caseRow("Undo after the other writer typed inside the undone insertion", follow.join(", "), follow.map(order => runInsideRange(order))),
    caseRow("Undo of a delete the other writer also made; final state after both undos; either first", identical.join(", "), identical.flatMap(order => (["Alice", "Bob"] as const).map(first => runDoubleDelete(order, first, false)))),
    caseRow("Redo after undo with a remote insertion elsewhere", follow.join(", "), follow.map(order => runRedoAfterRemote(order, false))),
    caseRow("Redo after undo with a remote insertion at the undone gap (characters once, replicas agree)", follow.join(", "), follow.map(order => runRedoAfterRemote(order, true))),
    caseRow("Insert, bold and delete one character, then three undos and three redos", follow.join(", "), follow.map(order => runRestoredChain(order)))
  ];
  const named = [...new Set(removals.flatMap(run => run.observation ? [run.observation] : []))];
  const doubleDelete = (["Alice", "Bob"] as const).map(first => runDoubleDelete("D1", first, false).observation ?? "");
  const gap = runRedoAfterRemote("D2", true).observation ?? "";
  const controls: { title: string; file: string; line: string; run: CaseResult; pattern: RegExp }[] = [
    { title: "Record stores positions", file: "UR-position-record.md", line: "A record holding beat and offset deletes the wrong characters once the other writer inserts before them.", run: runPositionControl("positions"), pattern: /characters/ },
    { title: "Undo deletes the whole inserted span", file: "UR-span-delete.md", line: "Deleting from the first to the last inserted identity also removes Bob's character typed inside it.", run: runInsideRange("D2", "span-delete"), pattern: /characters\[2\]/ },
    { title: "Ineffective undo falls through", file: "UR-fall-through.md", line: "When an ineffective identical undo pops the next entry, Bob's consumed undo removes his older insertion.", run: runIdenticalRemoval("D1", false, "Alice", "fall-through"), pattern: /reached an older step/ },
    { title: "No shared restoration record", file: "UR-no-restoration-record.md", line: "Without the shared map of restored identities, Bob's later undo restores a character Alice already restored.", run: runDoubleDelete("D1", "Alice", false, "no-restoration-record"), pattern: /characters/ },
    { title: "Older records do not follow restorations", file: "UR-no-restoration-chain.md", line: "Without following restored identities, undoing the bold after undoing the delete changes nothing.", run: runRestoredChain("D2", "no-restoration-record"), pattern: /changed nothing/ },
    { title: "Join undo without its own-entry check", file: "UR-rejoin-retired.md", line: "Retiring every matching join without checking the writer's own entry lets Bob's stale undo split Alice's later rejoin.", run: runRejoin("D1", "retire-without-own-entry"), pattern: /older step or wrote state/ },
    { title: "Removal undo without its own-entry check", file: "UR-re-removal-restored.md", line: "Deleting every removal entry of the beat without checking the writer's own entry lets Bob's stale undo restore Alice's later re-removal.", run: runReRemoval("D1", "retire-without-own-entry"), pattern: /older step or wrote state/ },
    { title: "Per-writer tag occurrence keys", file: "UR-per-writer-tag-keys.md", line: "With one occurrence key per writer, identical simultaneous tags show as a tag nested in itself.", run: runIdenticalTag("D1", false, "Alice", undefined, true), pattern: /marks/ }
  ];
  const limits: { title: string; file: string; line: string; run: CaseResult; pattern: RegExp }[] = [
    { title: "Concurrent undos of a doubly deleted character", file: "UR-concurrent-double-restore.md", line: "Alice and Bob both deleted c and undo without seeing each other's undo: c comes back twice.", run: runDoubleDelete("D1", "Alice", true), pattern: /characters\[3\]/ },
    { title: "Second status undo by one writer", file: "UR-sequential-status.md", line: "Under main's status rule only frontier events retire, so a writer's second status undo changes nothing.", run: runSequentialStatus("D2"), pattern: /expected "todo", got "ready"/ }
  ];
  const failures: string[] = [];
  for (const row of [...fixtures, ...cases]) if (row.failures.length) failures.push(`${row.name}: ${row.failures.join("; ")}`);
  for (const probe of [...controls, ...limits]) {
    if (!probe.pattern.test(probe.run.failure ?? "")) failures.push(`${probe.title} did not fail as expected: ${probe.run.failure ?? "passed"}`);
    files.set(`histories/${probe.file}`, history(probe.title, probe.line, probe.run));
  }
  const kinds = measureKinds();
  const growth = (kind: string): number => {
    const found = kinds.find(entry => entry.kind === kind);
    if (!found) throw new Error(`Missing measurement ${kind}`);
    return found.stateGrowthBytes;
  };
  const bound = runBoundHistory();
  const counts = boundCounts(bound.history);
  for (let step = 0; step < 200; step++) bound.history.undo();
  const restoredAfterBound = bound.harness.alice.doc.getMap("restoredIdentities").size;
  const retiredAfterBound = bound.harness.alice.doc.getMap("retiredStatus").size;
  bound.harness.destroy();
  const line = (text: string | null): string => (text ?? "passed").split("\n")[0] ?? "";
  const cell = (row: Row): string => row.failures.length ? `FAIL ${row.passed}/${row.total}: ${row.failures.map(line).join("; ")}` : `PASS ${row.passed}/${row.total}`;
  const fixtureTotal = fixtures.reduce((sum, row) => sum + row.total, 0);
  const fixturePassed = fixtures.reduce((sum, row) => sum + row.passed, 0);
  const markdown = [
    "# Command-record undo results", "",
    "Generated by `node src/undo-records/report.ts --write`; `test/undo-records/report.test.ts` requires this file and the `UR-` histories to match. Retained fixtures use their existing literal oracles unchanged. The new cases' expected results are literal data in `test/undo-records/oracles.ts`, written from the decided product rows before the first run. Candidate B only; the buffer traces run M1. Status uses main's rule (`statusFrontier`/`statusValue` in `src/marks/commands.ts`); #1413 was still open.", "",
    "## Answer", "",
    `Yes, except two named cases, neither caused by leaving the library stack. ${fixturePassed}/${fixtureTotal} retained undo runs pass on a per-writer history of command records with no \`Y.UndoManager\`: each record holds identities and shared record ids, and undo applies its reverse as a new local transaction. The two cases that fail are listed under Limits: concurrent undos of one doubly deleted character restore it twice, and main's status rule cannot undo a writer's second status change.`, "",
    "## Retained undo fixtures", "",
    "| Fixture | Delivery orders | Result |", "| --- | --- | --- |",
    ...fixtures.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "## Cases Stage 1 left unproved", "",
    "| Case | Delivery orders | Result |", "| --- | --- | --- |",
    ...cases.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "Each identical-change case also checks that the other writer's later undo writes nothing, consumes one entry and leaves that writer's older step for the next undo.", "",
    "## Open questions", "",
    `1. Undo of a delete the other writer also made. The decided rows list joins, status, tags and beat removals as identical changes, not deleted characters. Plausible outcomes: (a) the first undo restores every character its record deleted, including ones the other writer also deleted, and the other writer's later undo of them changes nothing; (b) it restores only characters nobody else deleted. Observed (a): ${doubleDelete.join("; ")}. Only the final state after both undos is checked. (b) would need shared per-writer deletion attribution.`,
    `2. Redo at the gap where the other writer typed after the undo. Plausible outcomes: redone text before or after the other writer's insertion. Observed ${gap}: redone characters return at their tombstones, ahead of the later insertion, on every replica.`,
    `3. Which writer an identical simultaneous removal names in recovery. Plausible outcomes: either writer, or both. Observed per replica: ${named.join("; ")}. Replicas disagree: \`src/structure-reader.ts\` takes the first removal entry in each replica's local key order. This is a reader convergence defect outside undo; the case's forward check accepts either name and the undo checks are unaffected.`, "",
    "## Controls", "",
    "Each control must fail its test in `test/undo-records/cases.test.ts`; all do.", "",
    "| Control | Shows | Failure | History |", "| --- | --- | --- | --- |",
    ...controls.map(probe => `| ${probe.title} | ${probe.line} | ${line(probe.run.failure)} | [history](histories/${probe.file}) |`), "",
    "## Limits", "",
    "| Case | Shows | Failure | History |", "| --- | --- | --- | --- |",
    ...limits.map(probe => `| ${probe.title} | ${probe.line} | ${line(probe.run.failure)} | [history](histories/${probe.file}) |`), "",
    "The first needs a convergent rule for two restorations of one identity, for example a reader that shows only the restoration the shared map keeps. The second is the status rule's retirement, which `undoStatus` on main uses too; it belongs with the status fix in #1413.", "",
    "## Counts", "",
    "Record bytes are the UTF-8 length of the record's JSON, a proxy for what the history keeps in memory, not a heap measurement. Undo update bytes are what the undo transaction sends. State growth is the change in `Y.encodeStateAsUpdate` length; negative values are deleted format markers and text collapsing into deletion ranges. Durable records are entries the undo adds to shared maps that are never removed.", "",
    "| Command | Record bytes | Undo update bytes | State growth | Durable records written by undo |", "| --- | --- | --- | --- | --- |",
    ...kinds.map(kind => `| ${kind.kind} | ${kind.recordBytes} | ${kind.undoUpdateBytes} | ${kind.stateGrowthBytes} | ${Object.entries(kind.durable).map(([root, count]) => `${count} in \`${root}\``).join(", ") || "none"} |`), "",
    `Each restored character costs one \`restoredIdentities\` entry: undoing a one-character delete grows the shared state by ${growth("range delete, 1 character")} bytes, a ten-character delete by ${growth("range delete, 10 characters")}. Recording one entry per contiguous run would cut this; not tried.`, "",
    "### A 200-entry bound per writer", "",
    `Alice runs 250 commands: 50 single-character inserts, one status change, then 199 commands cycling insert, bold, tag, whole-segment move and delete, while Bob inserts ten characters. With a bound of 200 the history drops the ${counts.dropped} oldest records (${counts.droppedBytes} bytes) and keeps ${counts.kept} (${counts.keptBytes} bytes: ${Object.entries(counts.keptByKind).map(([kind, count]) => `${count} ${kind}`).join(", ")}). The kept records name ${counts.referencedIdentities} distinct identities and ${counts.referencedStatusEvents} status event. All 200 undo, the oldest kept entry (the status change) included, on every replica and on a late joiner; a 201st undo finds nothing. Undoing them writes ${restoredAfterBound} \`restoredIdentities\` entries and ${retiredAfterBound} \`retiredStatus\` entry. The same 200 records, copied as JSON into a history on a fresh replica loaded from Alice's encoded state, undo the same way.`, "",
    "So a bound drops only local records. Nothing shared has to be kept for the dropped entries. For the kept ones to work, these must stay durable: the document's deleted items (their positions; their text is in the record), every `restoredIdentities`, `retiredJoins` and `retiredStatus` entry and status event, every removal record, and the comment and reply records. Any writer's kept entry may follow a restoration chain or test a retirement written by another writer. No entry in those maps can be compacted until no history, including a reloaded one, can name it.", "",
    "## What the command layer must record", "",
    "Each command records, when it runs and in the same local transaction:", "",
    "- Text insert: the identities of the inserted characters, and the caret before the command as an identity with its side.",
    "- Range delete: each deleted character's identity, value and attributes in document order, and the selection as identities with sides. Undo restores each at its own tombstone; a run with no live text between tombstones stays together.",
    "- Replacement (one native commit): both of the above in one record.",
    "- Split: the new boundary embed's identity and the caret before the split. Undo deletes the embed and leaves the beat record; redo restores the embed as a new identity.",
    "- Join: the join entry id and its two beats. Undo checks that its own entry is live, then retires every live matching entry.",
    "- Soft removal: the beat and the removal entry id. Undo checks that its own entry exists, then deletes every beat removal entry of that beat; redo sets its entry again.",
    "- Whole-segment move: the identities and values of the deleted order entries and the identity of the inserted one.",
    "- Mark add or remove (bold, link, comment highlight, tag): the key, the first and last identity, and each character's prior value. Undo sets every character now between the two identities to the prior value of the nearest recorded character on its left (the first one if none), which also clears a mark another writer's concurrent insertion picked up. A tag's key is derived from the tag and its first and last identity, so identical simultaneous tags are one mark.",
    "- Comment or reply creation: the record id and its fields, so redo can recreate them.",
    "- Status: the event id. Undo applies main's frontier retirement.",
    "- Plain scalar (LWW) value: the prior and the written value. Undo writes the prior only if the current value is still the written one.", "",
    "The history then needs three shared mechanisms, each with a control above: a shared `restoredIdentities` map that every restore writes and every resolution follows; an ineffective undo that consumes exactly its own entry; and own-entry checks before retiring joins or removals. Selections restore by following restored identities through that map, not Yjs `redone` links. This prototype has no typing groups, redo parking or save hold; one command is one entry.", ""
  ].join("\n");
  files.set("undo-records-results.md", markdown);
  return { files, markdown, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = undoRecordReport();
  if (process.argv.includes("--write")) {
    for (const [path, content] of report.files) writeFileSync(new URL(`../../${path}`, import.meta.url), content);
  } else if (process.argv.includes("--check")) {
    for (const [path, content] of report.files) {
      if (readFileSync(new URL(`../../${path}`, import.meta.url), "utf8") !== content) throw new Error(`Stale ${path}`);
    }
  }
  console.log(report.markdown);
  for (const failure of report.failures) console.log(`UNEXPECTED ${failure}`);
}
