import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import { replacementIntentFixtures } from "../../test/buffer-replacements.ts";
import { attempt, bufferOrders, runBufferTrace, runReplacement } from "../../test/undo-records/buffer-runner.ts";
import { runDoubleDelete, runEmptyBeatInsert, runHeldSelection, runIdenticalRemoval, runIdenticalTag, runInsideRange, runJoinRedo, runLaterFormat, runLongChain, runPositionControl, runRedoAfterRemote, runRedoneRecovery, runRejoin, runReRemoval, runRestoredChain, runSequentialStatus, runSplitAtEnd, runStatusRedo, runThrowingUndo } from "../../test/undo-records/cases.ts";
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
  const every = ["D1", "D2", "dup", "rev", "late-C"] as const;
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
    caseRow("Redo after undo with a remote insertion at the undone gap (full model, observed outcome of open question 2)", follow.join(", "), follow.map(order => runRedoAfterRemote(order, true))),
    caseRow("Insert, bold and delete one character, then three undos and three redos", follow.join(", "), follow.map(order => runRestoredChain(order))),
    caseRow("Split at the end of a beat, then undo (caret at the end)", every.join(", "), every.map(order => runSplitAtEnd(order))),
    caseRow("Insert into an empty beat, then undo (caret in the empty beat)", every.join(", "), every.map(order => runEmptyBeatInsert(order))),
    caseRow("Bold one character, delete and undo it 64 times, then undo the bold", every.join(", "), every.map(order => runLongChain(order))),
    caseRow("A selection held outside the history, mapped through it after delete and undo", every.join(", "), every.map(order => runHeldSelection(order))),
    caseRow("Join redo after the other writer joined the same beat elsewhere: the earlier winner wins again", every.join(", "), every.map(order => runJoinRedo(order))),
    caseRow("An undo whose record cannot be resolved throws and keeps its entry", "D1", [runThrowingUndo()])
  ];
  cases.push(caseRow("Status redo after concurrent status changes that did not apply (observed outcome of open question 4)", every.join(", "), every.map(order => runStatusRedo(order))));
  const statusRedo = runStatusRedo("D1").observation ?? "";
  const held = runHeldSelection("D1").observation ?? "";
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
  const limits: { title: string; file: string; line: string; run: CaseResult; pattern: RegExp; library: string }[] = [
    { title: "Concurrent undos of a doubly deleted character", file: "UR-concurrent-double-restore.md", line: "Alice and Bob both deleted c and undo without seeing each other's undo: c comes back twice.", run: runDoubleDelete("D1", "Alice", true), pattern: /characters\[3\]/, library: "Also with the library: two `Y.UndoManager`s undoing the same delete give `abccd` (probe, both client-id orders)." },
    { title: "Second status undo by one writer", file: "UR-sequential-status.md", line: "Under main's status rule only frontier events retire, so a writer's second status undo changes nothing.", run: runSequentialStatus("D2"), pattern: /expected "todo", got "ready"/, library: "Also with the library: main's `undoStatus` applies the same retirement." },
    { title: "Format undo over the other writer's later formatting", file: "UR-later-format.md", line: "Alice bolds ab; Bob unbolds then bolds bc; Alice's undo removes Bob's bold from b. Expected (decided row: a person undoes only their own changes): b keeps Bob's bold.", run: runLaterFormat("D1"), pattern: /characters\[1\]\.marks\.b: expected true, got <missing>/, library: "Also with the library: `Y.UndoManager` undoing Alice's bold leaves a, b, c and d all plain (probe)." },
    { title: "Recovery after undo and redo inside a removed beat", file: "UR-redone-recovery.md", line: "Alice inserts x; Bob removes the beat; Alice undoes and redoes: recovery lists the restored x as an edit made after the removal.", run: runRedoneRecovery("D1"), pattern: /edited\[0\]: expected <missing>, got "a1\*"/, library: "Also with the library: after `Y.UndoManager` undo and redo the reader lists the redone x as edited (probe)." }
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
  const counts = boundCounts(bound);
  for (let step = 0; step < 200; step++) bound.history.undo();
  const restoredAfterBound = bound.harness.alice.doc.getMap("restoredIdentities").size;
  const retiredAfterBound = bound.harness.alice.doc.getMap("retiredStatus").size;
  bound.harness.destroy();
  const line = (text: string | null): string => (text ?? "passed").split("\n")[0] ?? "";
  const cell = (row: Row): string => row.failures.length ? `FAIL ${row.passed}/${row.total}: ${row.failures.map(line).join("; ")}` : `PASS ${row.passed}/${row.total}`;
  const familyNames = Object.keys(recordTraces);
  const rowsOf = (name: string): Row[] => fixtures.filter(row => row.name === name || row.name === `${name} (swapped client ids)`);
  const familyRows = familyNames.flatMap(rowsOf);
  const bufferRows = fixtures.filter(row => !familyRows.includes(row));
  const sum = (rows: Row[], field: "passed" | "total"): number => rows.reduce((total, row) => total + row[field], 0);
  const passingFamilies = familyNames.filter(name => rowsOf(name).every(row => !row.failures.length));
  const failingFamilies = familyNames.filter(name => !passingFamilies.includes(name));
  const markdown = [
    "# Command-record undo results", "",
    "Generated by `node src/undo-records/report.ts --write`; `test/undo-records/report.test.ts` requires this file and the `UR-` histories to match. Retained fixtures use their existing literal oracles unchanged. The new cases' expected results are literal data in `test/undo-records/oracles.ts`, written from the decided product rows. One commit cannot show that they were written before the first run: the oracles and the code that passes them land together. Candidate B only; the buffer traces run M1. Status uses main's rule (`statusFrontier`/`statusValue` in `src/marks/commands.ts`); #1413 was still open.", "",
    "## Answer", "",
    `${passingFamilies.length} of ${familyNames.length} retained candidate B families pass (${sum(familyRows, "passed")}/${sum(familyRows, "total")} runs)${failingFamilies.length ? `; failing: ${failingFamilies.join(", ")}` : ""}, and ${sum(bufferRows, "passed")}/${sum(bufferRows, "total")} M1 buffer and replacement runs. The families are every structural and mark trace with an undo step plus the two U-H1 traces, derived from the native runners' trace lists. Undo runs on a per-writer history of command records: each record holds identities and shared record ids, and undo applies its reverse as a new local transaction. No library undo or redo is called; the M1 buffer's inherited constructor still builds a \`Y.UndoManager\`, which is destroyed unused.`, "",
    `${limits.length} limits remain, each with a failing literal test and a minimized history below: concurrent undos of one doubly deleted character restore it twice (a convergent rule is in #1419); main's status rule cannot undo a writer's second status change (#1413); a format undo overwrites the other writer's later formatting; and recovery lists a redone character as an edit made after the removal. Each also occurs with the library's undo stack, so none comes from leaving it. The structural reader's "Structural join target unavailable" error (join R2 into R1, then remove or move R1) is not reached by any retained family.`, "",
    "## Retained candidate B families", "",
    "| Family | Delivery orders | Result |", "| --- | --- | --- |",
    ...familyRows.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "## M1 buffer and replacement fixtures", "",
    "| Fixture | Delivery orders | Result |", "| --- | --- | --- |",
    ...bufferRows.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "## Cases Stage 1 left unproved", "",
    "| Case | Delivery orders | Result |", "| --- | --- | --- |",
    ...cases.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "Each identical-change case also checks that the other writer's later undo writes nothing, consumes one entry and leaves that writer's older step for the next undo.", "",
    "## Open questions", "",
    `1. Undo of a delete the other writer also made. The decided rows list joins, status, tags and beat removals as identical changes, not deleted characters. Plausible outcomes: (a) the first undo restores every character its record deleted, including ones the other writer also deleted, and the other writer's later undo of them changes nothing; (b) it restores only characters nobody else deleted. Observed (a): ${doubleDelete.join("; ")}. Only the final state after both undos is checked. (b) would need shared per-writer deletion attribution.`,
    `2. Redo at the gap where the other writer typed after the undo. Plausible outcomes: redone text before or after the other writer's insertion. Observed ${gap}: redone characters return at their tombstones, ahead of the later insertion, on every replica.`,
    `3. Which writer an identical simultaneous removal names in recovery. Plausible outcomes: either writer, or both. Observed per replica: ${named.join("; ")}. Replicas disagree: \`src/structure-reader.ts\` takes the first removal entry in each replica's local key order. This is a reader convergence defect outside undo; the case's forward check accepts either name and the undo checks are unaffected.`,
    `4. Redo of a status change that had not applied. Alice and Bob change the status at once; under main's rule neither applies (the status stays todo and each gets a notice). Alice's undo retires both frontier events, and the status stays todo. Plausible outcomes of her redo: (a) it writes a fresh event and her status applies (ready); (b) it restores the state before the undo, a conflict in which neither applies (todo), which would need the record to keep the conflicting events and redo to make them the frontier again. Observed (a) on every order: ${statusRedo}, final status ready. Both outcomes are literal data in \`statusRedoObserved\`; re-run after #1413 merges.`, "",
    "## Controls", "",
    "Each control must fail its test in `test/undo-records/cases.test.ts`; all do.", "",
    "| Control | Shows | Failure | History |", "| --- | --- | --- | --- |",
    ...controls.map(probe => `| ${probe.title} | ${probe.line} | ${line(probe.run.failure)} | [history](histories/${probe.file}) |`), "",
    "## Limits", "",
    "| Case | Shows | Failure | With the library's undo stack | History |", "| --- | --- | --- | --- | --- |",
    ...limits.map(probe => `| ${probe.title} | ${probe.line} | ${line(probe.run.failure)} | ${probe.library} | [history](histories/${probe.file}) |`), "",
    "- Double restore needs a convergent rule for two restorations of one identity; #1419 keeps one restoration per identity.",
    "- Second status undo is the status rule's retirement, which `undoStatus` on main uses too; it belongs with the status fix in #1413.",
    "- Format overwrite is a design question. Expected: b keeps Bob's bold. Plausible rules: (a) undo reverts only characters whose current value this change set last, which needs every format command to record, per character and key in shared state, the id of the change that set the value; (b) the current rule, undo sets the recorded prior over the recorded span, which needs nothing more and overwrites later formatting by others.",
    "- Redone recovery is a design question. Expected: x was inserted before the removal, so recovery lists no edit. Plausible rules: (a) the reader treats a restored identity whose original predates the removal as not edited, which needs the reader to follow the restoration map; (b) the current rule, any item created after the removal is an edit, so the redone x is listed.", "",
    "## Counts", "",
    "Record bytes are the UTF-8 length of the record's JSON, a proxy for what the history keeps in memory, not a heap measurement. Undo update bytes are what the undo transaction sends. State growth is the change in `Y.encodeStateAsUpdate` length; negative values are deleted format markers and text collapsing into deletion ranges. Durable records are entries the undo adds to shared maps; only a join redo removes any, the retirements its undo wrote.", "",
    "| Command | Record bytes | Undo update bytes | State growth | Durable records written by undo |", "| --- | --- | --- | --- | --- |",
    ...kinds.map(kind => `| ${kind.kind} | ${kind.recordBytes} | ${kind.undoUpdateBytes} | ${kind.stateGrowthBytes} | ${Object.entries(kind.durable).map(([root, count]) => `${count} in \`${root}\``).join(", ") || "none"} |`), "",
    `Each restored character costs one \`restoredIdentities\` entry: undoing a one-character delete grows the shared state by ${growth("range delete, 1 character")} bytes, a ten-character delete by ${growth("range delete, 10 characters")}. Recording one entry per contiguous run would cut this; not tried.`, "",
    "### A 200-entry bound per writer", "",
    `Alice runs 250 commands: 50 single-character inserts, one status change, then 199 commands cycling insert, bold, tag, whole-segment move and delete, while Bob inserts ${bound.bobInserts.length} characters. With a bound of 200 the history drops the ${counts.dropped} oldest records (${counts.droppedBytes} bytes) and releases them, keeping only that count; it keeps ${counts.kept} (${counts.keptBytes} bytes: ${Object.entries(counts.keptByKind).map(([kind, count]) => `${count} ${kind}`).join(", ")}). The kept records name ${counts.referencedIdentities} distinct identities and ${counts.referencedStatusEvents} status event. All 200 undo, the oldest kept entry (the status change) included, on every replica and on a late joiner; a 201st undo finds nothing. Undoing them writes ${restoredAfterBound} \`restoredIdentities\` entries and ${retiredAfterBound} \`retiredStatus\` entry. The same 200 records, copied as JSON into a history on a fresh replica loaded from Alice's encoded state, undo the same way.`, "",
    "So a bound drops only local records. Nothing shared has to be kept for the dropped entries. For the kept ones to work, these must stay durable: the document's deleted items (their positions; their text is in the record), every `restoredIdentities` and `retiredStatus` entry and status event, every removal record, and the comment and reply records. A `retiredJoins` entry must stay until a join redo deletes it, which is the only removal. Any writer's kept entry may follow a restoration chain or test a retirement written by another writer. No entry in those maps can be compacted until no history, including a reloaded one, can name it.", "",
    "## What the command layer must record", "",
    "Each command records, when it runs and in the same local transaction:", "",
    "- Text insert: the identities of the inserted characters, and the caret before the command as an identity with its side.",
    "- Range delete: each deleted character's identity, value and attributes in document order, and the selection as identities with sides. Undo restores each at its own tombstone; a run with no live text between tombstones stays together.",
    "- Replacement (one native commit): both of the above in one record.",
    "- Split: the new boundary embed's identity and the caret before the split, held as identities with sides; a caret at the end of a beat is held by the character before it, and an empty beat by its container. Undo deletes the embed and leaves the beat record; redo restores the embed as a new identity.",
    "- Join: the join entry id and its two beats. Undo checks that its own entry is live, then retires every live matching entry and records which entries it retired; redo deletes those retirements, so the join that won before the undo wins again.",
    "- Heading create or remove: the deleted or restored marker characters, the boundary embed or the segment's `head` key with its prior value, the beat record's presence, and the removal record the heading replaced.",
    "- Range replacement across beats (cut and paste, header rewrite): the deleted characters as identities with values and attributes, the beats removed whole, and the inserted identities.",
    "- Plain key of a shared map (segment head, paragraph start): the path, the prior and the written value; undo writes the prior only while the current value is still the written one.",
    "- Soft removal: the beat and the removal entry id. Undo checks that its own entry exists, then deletes every beat removal entry of that beat; redo sets its entry again.",
    "- Whole-segment move: the identities and values of the deleted order entries and the identity of the inserted one.",
    "- Mark add or remove (bold, link, comment highlight, tag): the key, the first and last identity, and each character's prior value. Undo sets every character now between the two identities to the prior value of the nearest recorded character on its left (the first one if none), which also clears a mark another writer's concurrent insertion picked up. A tag's key is derived from the tag and its first and last identity, so identical simultaneous tags are one mark.",
    "- Comment or reply creation: the record id and its fields, so redo can recreate them.",
    "- Status: the event id. Undo applies main's frontier retirement.",
    "- Plain scalar (LWW) value: the prior and the written value. Undo writes the prior only if the current value is still the written one.", "",
    "The history then needs three shared mechanisms, each with a control above: a shared `restoredIdentities` map that every restore writes and the history follows whenever it resolves a record or returns a selection, with no fixed chain length; an ineffective undo that consumes exactly its own entry, while an undo that throws keeps it; and own-entry checks before retiring joins or removals. Records and the selections the history returns follow restorations through that map, not Yjs `redone` links.", "",
    `What does not follow restorations: a selection held outside the history follows them only when passed through \`history.mapAnchor\`; read without mapping after Alice deletes bc and undoes, a selection held over bc is ${held}. The recovery reader does not follow them (limit above). This prototype has no typing groups, redo parking or save hold; one command is one entry.`, ""
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
