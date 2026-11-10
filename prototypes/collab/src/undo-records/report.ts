import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoubleDelete, runEmptyBeatInsert, runHeldSelection, runIdenticalRemoval, runIdenticalRemovalRedo, runIdenticalTag, runInsideRange, runJoinRedo, runLongChain, runPositionControl, runRedoAfterRemote, runRejoin, runReRemoval, runRestoredChain, runSplitAtEnd, runStatusRedo, runThrowingUndo } from "../../test/undo-records/cases.ts";
import type { CaseResult } from "../../test/undo-records/cases.ts";
import { commandOps, defaultGeneratorRuns, execute, generate, generatorLength } from "../../test/undo-records/generator.ts";
import { declaredLimits, keptSeeds, limitFor } from "../../test/undo-records/limits.ts";
import { libraryProbes } from "../../test/undo-records/probes.ts";
import { retainedFamilies, retainedUndoSources } from "../../test/undo-records/retained.ts";
import { boundCounts, measureKinds, runBoundHistory } from "./measure.ts";

interface Row {
  name: string;
  orders: string;
  passed: number;
  total: number;
  failures: string[];
}

function caseRow(name: string, orders: string, runs: CaseResult[]): Row {
  return { name, orders, passed: runs.filter(run => !run.failure).length, total: runs.length, failures: runs.flatMap(run => run.failure ? [run.failure] : []) };
}

function history(title: string, line: string, replay: string, failure: string, lines: readonly string[]): string {
  return [line, "", `Replay: \`${replay}\`.`, "", `# ${title}`, "", `Failure: ${failure}`, "", "```text", ...lines, "```", ""].join("\n");
}

function generatorCounts(): { runs: number; executed: Record<string, number>; byLimit: Map<string, { runs: number; violations: number }>; unmatched: number } {
  const executed: Record<string, number> = {};
  const byLimit = new Map<string, { runs: number; violations: number }>();
  let runs = 0;
  let unmatched = 0;
  for (const writers of [2, 3] as const) {
    for (let seed = 1; seed <= defaultGeneratorRuns; seed++) {
      const run = execute(generate(seed, writers, generatorLength));
      runs++;
      for (const [op, count] of Object.entries(run.executed)) executed[op] = (executed[op] ?? 0) + count;
      const hit = new Set<string>();
      for (const violation of run.violations) {
        const limit = limitFor(violation);
        if (!limit) {
          unmatched++;
          continue;
        }
        const entry = byLimit.get(limit.id) ?? { runs: 0, violations: 0 };
        entry.violations++;
        if (!hit.has(limit.id)) entry.runs++;
        hit.add(limit.id);
        byLimit.set(limit.id, entry);
      }
    }
  }
  return { runs, executed, byLimit, unmatched };
}

export function undoRecordReport(): { files: Map<string, string>; markdown: string; failures: string[] } {
  const files = new Map<string, string>();
  const failures: string[] = [];
  const identical = ["D1", "dup", "rev", "late-C"] as const;
  const follow = ["D2", "dup", "late-C"] as const;
  const every = ["D1", "D2", "dup", "rev", "late-C"] as const;
  const familyRows = retainedFamilies.map(family => {
    const runs = family.runs.map(run => ({ label: run.label, result: run.run() }));
    const sources = Object.entries(retainedUndoSources).filter(([, names]) => names.includes(family.name)).map(([file]) => `\`${file}\``);
    const failed = runs.filter(run => run.result.failure);
    for (const run of failed) failures.push(`${family.name} ${run.label}: ${run.result.failure ?? ""}`);
    return { name: family.name, sources: sources.join(", "), passed: runs.length - failed.length, total: runs.length };
  });
  const both = [false, true].flatMap(swapped => (["Alice", "Bob"] as const).map(first => ({ swapped, first })));
  const removals = identical.flatMap(order => both.map(({ swapped, first }) => runIdenticalRemoval(order, swapped, first)));
  const cases = [
    caseRow("Identical simultaneous removal; either writer undoes first; both client-id orders", identical.join(", "), removals),
    caseRow("Identical simultaneous removal; one writer undoes and redoes: both removal entries return", identical.join(", "), identical.map(order => runIdenticalRemovalRedo(order))),
    caseRow("Identical simultaneous tag; either writer undoes first; both client-id orders", identical.join(", "), identical.flatMap(order => both.map(({ swapped, first }) => runIdenticalTag(order, swapped, first)))),
    caseRow("Intentional rejoin after both joins were retired; the other writer's stale undo", identical.join(", "), identical.map(order => runRejoin(order))),
    caseRow("Intentional re-removal after both removals were undone; the other writer's stale undo", identical.join(", "), identical.map(order => runReRemoval(order))),
    caseRow("Undo after the other writer typed inside the undone insertion", follow.join(", "), follow.map(order => runInsideRange(order))),
    caseRow("Undo of a delete the other writer also made; final state after both undos; either first", identical.join(", "), identical.flatMap(order => (["Alice", "Bob"] as const).map(first => runDoubleDelete(order, first, false)))),
    caseRow("Redo after undo with a remote insertion elsewhere", follow.join(", "), follow.map(order => runRedoAfterRemote(order, false))),
    caseRow("Redo after undo with a remote insertion at the undone gap (observed outcome of open question 2)", follow.join(", "), follow.map(order => runRedoAfterRemote(order, true))),
    caseRow("Insert, bold and delete one character, then three undos and three redos", follow.join(", "), follow.map(order => runRestoredChain(order))),
    caseRow("Split at the end of a beat, then undo (caret at the end)", every.join(", "), every.map(order => runSplitAtEnd(order))),
    caseRow("Insert into an empty beat, then undo (caret in the empty beat)", every.join(", "), every.map(order => runEmptyBeatInsert(order))),
    caseRow("Bold one character, delete and undo it 64 times, then undo the bold", every.join(", "), every.map(order => runLongChain(order))),
    caseRow("A selection held outside the history, mapped through it after delete and undo", every.join(", "), every.map(order => runHeldSelection(order))),
    caseRow("Join redo after the other writer joined the same beat elsewhere: the earlier winner wins again", every.join(", "), every.map(order => runJoinRedo(order))),
    caseRow("An undo whose record cannot be resolved throws, keeps its entry and writes nothing; the entry below it still undoes", "D1", [runThrowingUndo()]),
    caseRow("Status redo after concurrent status changes that did not apply (observed outcome of open question 4)", every.join(", "), every.map(order => runStatusRedo(order)))
  ];
  for (const row of cases) if (row.failures.length) failures.push(`${row.name}: ${row.failures.join("; ")}`);
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
  for (const probe of controls) {
    if (!probe.pattern.test(probe.run.failure ?? "")) failures.push(`${probe.title} did not fail as expected: ${probe.run.failure ?? "passed"}`);
    files.set(`histories/${probe.file}`, history(probe.title, probe.line, "node --test test/undo-records/cases.test.ts", probe.run.failure ?? "unexpected pass", probe.run.history));
  }
  const probes = libraryProbes();
  const generatorRows = generatorCounts();
  if (generatorRows.unmatched) failures.push(`${generatorRows.unmatched} generator violations match no declared limit`);
  const limitRows = declaredLimits.map(limit => {
    const found: string[] = [];
    const links: string[] = [];
    let failure = "";
    if (limit.literal) {
      const run = limit.literal.run();
      if (!limit.literal.failure.test(run.failure ?? "")) failures.push(`${limit.id} literal case did not fail as declared: ${run.failure ?? "passed"}`);
      failure = (run.failure ?? "passed").split("\n")[0] ?? "";
      found.push("literal case");
      links.push(`[literal](histories/${limit.literal.file})`);
      files.set(`histories/${limit.literal.file}`, history(limit.title, `Owner: ${limit.owner}.`, "node --test test/undo-records/generator.test.ts", run.failure ?? "unexpected pass", run.history));
    }
    if (limit.minimal) {
      const run = execute(limit.minimal, { actOnPending: limit.actOnPending ?? false });
      const violation = run.violations.find(entry => limit.matches?.(entry));
      if (!violation) failures.push(`${limit.id} minimized history no longer shows it`);
      if (!failure) failure = `${violation?.check ?? "none"}: ${violation?.detail ?? ""}`;
      links.push(`[generator, ${limit.minimal.steps.length} steps](histories/UR-gen-${limit.id}.md)`);
      files.set(`histories/UR-gen-${limit.id}.md`, history(limit.title, `Owner: ${limit.owner}. Minimized generator history (${limit.minimal.writers} writers${limit.actOnPending ? ", acting on a replica that holds an out-of-order update" : ""}); queue lines are omitted.`, "node --test test/undo-records/generator.test.ts", violation ? `${violation.check}: ${violation.detail}` : "not reproduced", run.history.filter(line => !line.startsWith("enqueue"))));
    }
    const counted = generatorRows.byLimit.get(limit.id);
    if (limit.matches) found.push(counted ? `generator: ${counted.runs} of ${generatorRows.runs} runs` : `generator: 0 of ${generatorRows.runs} runs`);
    const library = limit.library ? `\`${probes[limit.library] ?? "missing probe"}\`` : "not probed";
    return `| ${limit.title} | ${limit.owner} | ${found.join("; ")} | ${failure.replaceAll("|", "\\|").slice(0, 300)} | ${library} | ${links.join(", ")} |`;
  });
  const kinds = measureKinds();
  const growth = (kind: string): number => {
    const entry = kinds.find(item => item.kind === kind);
    if (!entry) throw new Error(`Missing measurement ${kind}`);
    return entry.stateGrowthBytes;
  };
  const bound = runBoundHistory();
  const counts = boundCounts(bound);
  for (let step = 0; step < 200; step++) bound.history.undo();
  const restoredAfterBound = bound.harness.alice.doc.getMap("restoredIdentities").size;
  const retiredAfterBound = bound.harness.alice.doc.getMap("retiredStatus").size;
  bound.harness.destroy();
  const cell = (row: Row): string => row.failures.length ? `FAIL ${row.passed}/${row.total}: ${row.failures.map(text => text.split("\n")[0] ?? "").join("; ")}` : `PASS ${row.passed}/${row.total}`;
  const familyTotal = familyRows.reduce((sum, row) => sum + row.total, 0);
  const familyPassed = familyRows.reduce((sum, row) => sum + row.passed, 0);
  const passingFamilies = familyRows.filter(row => row.passed === row.total).length;
  const executed = generatorRows.executed;
  const commandTotal = commandOps.reduce((sum, op) => sum + (executed[op] ?? 0), 0);
  const markdown = [
    "# Command-record undo results", "",
    "Generated by `node src/undo-records/report.ts --write`; `test/undo-records/report.test.ts` requires this file and the `UR-` histories to match. Candidate B only; the buffer families run M1. Status uses main's rule after #1413: `statusValue` resolves through `resolveBeatStatus`, and every event is read through `readStatusEvent` (`src/marks/status-resolution.ts`). Status commands and their redo validate the event with `readStatusEvent` before writing it, and throw on a value it rejects.", "",
    "The limits below are the ones these literal fixtures and this generator have found so far; passing them does not show that there are no others.", "",
    "## Answer", "",
    `Undo runs on a per-writer history of command records: each record holds identities and shared record ids, and undo applies its reverse as a new local transaction. The command-record path calls no library undo or redo (\`bound.test.ts\` scans for it); the M1 buffer's inherited constructor still builds a \`Y.UndoManager\`, which is destroyed unused, and the library probes call the library on purpose.`, "",
    `- Retained families: ${passingFamilies} of ${familyRows.length} pass (${familyPassed}/${familyTotal} runs, \`fixtures.test.ts\`). The list is derived from the retained test files that contain an undo step: \`fixtures.test.ts\` scans \`test/\` for undo calls and fails if a file with one is missing from the list, or if a listed family does not run.`,
    `- New cases: ${cases.filter(row => !row.failures.length).length} of ${cases.length} rows pass (\`cases.test.ts\`).`,
    `- Generator: ${generatorRows.runs} seeded histories in the suite (\`generator.test.ts\`; set \`UNDO_GENERATOR_RUNS\` for more). ${generatorRows.unmatched ? `${generatorRows.unmatched} violations match no declared limit.` : "Each violation they produce matches a declared limit."}`,
    `- Declared limits: ${declaredLimits.length}, each with a failing literal case, a minimized generator history, or both (\`generator.test.ts\` re-runs each one). ${declaredLimits.filter(limit => limit.owner === "undo").length} belong to undo; the rest belong to the reader, main's status rule, delivery order or the library's formatting.`, "",
    "## Literal fixtures that pass, by family", "",
    "### Retained families", "",
    "| Family | Retained source | Result |", "| --- | --- | --- |",
    ...familyRows.map(row => `| ${row.name} | ${row.sources} | ${row.passed === row.total ? "PASS" : "FAIL"} ${row.passed}/${row.total} |`), "",
    "The retained families keep their existing literal oracles. Structural and mark traces add a late joiner to their delivery orders.", "",
    "### Cases Stage 1 left unproved", "",
    "The expected results are literal data in `test/undo-records/oracles.ts`, written from the decided product rows. One commit cannot show that they were written before the first run: the oracles and the code that passes them land together.", "",
    "| Case | Delivery orders | Result |", "| --- | --- | --- |",
    ...cases.map(row => `| ${row.name} | ${row.orders} | ${cell(row)} |`), "",
    "Each identical-change case also checks that the other writer's later undo writes nothing, consumes one entry and leaves that writer's older step for the next undo.", "",
    "## Declared limits", "",
    "A violation the generator finds is accepted only if it matches one row's predicate in `test/undo-records/limits.ts`; anything else fails `generator.test.ts`. The library column is an executed probe (`test/undo-records/probes.ts`, pinned by `probes.test.ts`): what the library's undo stack, or plain formatting with no undo, does on the same history.", "",
    "| Limit | Owner | Found by | Failure | Library probe | History |", "| --- | --- | --- | --- | --- | --- |",
    ...limitRows, "",
    "- Double restore needs a convergent rule for two restorations of one identity; #1419 keeps one restoration per identity. The generator has not produced one: it needs both writers to delete the same character and both undo before either undo arrives.",
    "- Format overwrite is a design question. Expected: b keeps Bob's bold. Plausible rules: (a) undo reverts only characters whose current value this change set last, which needs every format command to record, per character and key in shared state, the id of the change that set the value; (b) the current rule, undo sets the recorded prior over the recorded span, which needs nothing more and overwrites later formatting by others.",
    "- Redone recovery is a reader question. Expected: x was inserted before the removal, so recovery lists no edit. Plausible rules: (a) the reader treats a restored identity whose original predates the removal as not edited, which needs the reader to follow the restoration map; (b) the current rule, any item created after the removal is an edit, so the redone x is listed.",
    "- Second status undo: the library's undo stack goes shot, ready, todo; main's `undoStatus`, which pops its stack by hand and retires only frontier events, goes shot, ready, ready, and command records do the same. The limit comes from main's retirement rule, not from leaving the library.",
    "- Status redo after a conflict is open question 4 below: the redo writes a fresh event, so a status that had not applied applies after undo and redo.",
    "- Redone mark: plain formatting with no undo (remove the highlight, add it again) loses it the same way in one client-id order, so the cause is Yjs's formatting cleanup when one writer's two format updates arrive in reverse. A relay server delivers each writer's updates in order.",
    "- Reader limits are reported here because the generator reaches them; the reader fix is in another lane.",
    "- Pending update: the generator does not act on a replica while it holds an out-of-order update. The minimized history does, and the replica's own segment walk throws until the earlier update arrives.", "",
    "## Generator", "",
    `\`test/undo-records/generator.ts\` builds seeded histories of ${generatorLength} steps on the fixture \`# Ab\` / heading \`In\` / \`cde\` / \`fg\`, with two writers, or three where Carol joins from encoded state before the first step. Each step is a command of one of ${commandOps.length} kinds (${commandOps.join(", ")}), an undo, a redo, an undo immediately followed by a redo, a delivery of one queued update (sometimes twice), or, in two-writer runs, a late joiner from encoded state. A quarter of the seeds let one sender's updates arrive out of order; the rest keep each sender's updates in order, as a relay server does, and reorder only across senders. At the end every update is delivered and a fresh replica is loaded from Alice's encoded state.`, "",
    "Checks:", "",
    "- After each undo: an ineffective undo consumes exactly one entry and writes nothing; an effective one removes no character whose root original another writer created (roots follow `restoredIdentities`).",
    "- After an undo immediately followed by a redo: the writer's model is the same, with identities compared by root original.",
    "- After delivery: every replica and the fresh one read the same model through `readStructure`; no identity appears twice; no root original appears twice.",
    "- After delivery: `readStatusEvent` accepts every status event on every replica, including the events a status redo writes. Every literal check that goes through `Scenario.check` (`test/undo-records/cases.ts`) makes the same assertion on each replica.",
    "- Nothing throws: commands, undo, redo and the reader.", "",
    `Counts for the ${generatorRows.runs} histories in the suite (seeds 1 to ${defaultGeneratorRuns}, two and three writers):`, "",
    "| Executed | Count |", "| --- | --- |",
    `| commands | ${commandTotal} (${commandOps.map(op => `${op} ${executed[op] ?? 0}`).join(", ")}) |`,
    ...["undo", "redo", "undo-redo", "deliver", "late", "effective undos checked", "ineffective undos checked", "undo-then-redo round trips checked", "status events validated", "status events written by a redo validated", "waited on an out-of-order update"].map(op => `| ${op} | ${executed[op] ?? 0} |`), "",
    "| Limit | Runs with it | Violations |", "| --- | --- | --- |",
    ...declaredLimits.filter(limit => limit.matches).map(limit => { const entry = generatorRows.byLimit.get(limit.id); return `| ${limit.title} | ${entry?.runs ?? 0} | ${entry?.violations ?? 0} |`; }),
    `| Unmatched | ${generatorRows.unmatched ? "FAIL" : "0"} | ${generatorRows.unmatched} |`, "",
    "Once the reader throws on a replica, the undo checks on that replica in that run are skipped; the reader's join-target error is the most frequent class, so it hides other checks in the runs it reaches.", "",
    "Kept seeds, re-run by `generator.test.ts`:", "",
    ...keptSeeds.map(kept => `- ${kept.seed}, ${kept.writers} writers: ${kept.found}.`), "",
    "The four undo defects the generator found in this round are fixed: a key or removal undo now changes nothing when its beat record is gone instead of throwing; a removal redo restores every removal entry its undo deleted; and a beat-record undo keeps the record's fields so its redo restores other writers' removal entries and joins.", "",
    "## Open questions", "",
    `1. Undo of a delete the other writer also made. The decided rows list joins, status, tags and beat removals as identical changes, not deleted characters. Plausible outcomes: (a) the first undo restores every character its record deleted, including ones the other writer also deleted, and the other writer's later undo of them changes nothing; (b) it restores only characters nobody else deleted. Observed (a): ${doubleDelete.join("; ")}. Only the final state after both undos is checked. (b) would need shared per-writer deletion attribution.`,
    `2. Redo at the gap where the other writer typed after the undo. Plausible outcomes: redone text before or after the other writer's insertion. Observed ${gap}: redone characters return at their tombstones, ahead of the later insertion, on each replica the case reads.`,
    `3. Which writer an identical simultaneous removal names in recovery. Observed per replica: ${named.join("; ")}. Replicas disagree, and the remover's name is not the only recovery field that does: with no undo involved, the reader on main (\`src/structure-reader.ts\`) also gives replicas different \`edited\` lists and \`splitBy\` values. Two histories: R1 \`a\`; Alice inserts x, then removes R1; Bob concurrently removes R1 without seeing x; Alice reads \`edited=[]\` and Bob \`edited=["a1"]\`. Alice splits \`abcd\` at 2 into Ra; Bob concurrently splits at 1 into Rb and removes Rb; after synchronizing, Bob removes Ra; \`splitBy: "Alice"\` appears only on Bob. Both are reader limits above. The identical-removal case's forward check accepts either name; after its undo the beat has left recovery, so the later checks compare no remover.`,
    `4. Redo of a status change that had not applied. Alice and Bob change the status at once; under main's rule neither applies (the status stays todo and each gets a notice). Alice's undo retires both frontier events, and the status stays todo. Plausible outcomes of her redo: (a) it writes a fresh event and her status applies (ready); (b) it restores the state before the undo, a conflict in which neither applies (todo), which would need the record to keep the conflicting events and redo to make them the frontier again. Observed (a) on the five delivery orders of \`cases.test.ts\`: ${statusRedo}, final status ready. The generator reaches it too (limit above).`, "",
    "## Controls", "",
    "Each control has a test in `test/undo-records/cases.test.ts` that requires it to fail; the report fails if one stops failing.", "",
    "| Control | Shows | Failure | History |", "| --- | --- | --- | --- |",
    ...controls.map(probe => `| ${probe.title} | ${probe.line} | ${(probe.run.failure ?? "passed").split("\n")[0] ?? ""} | [history](histories/${probe.file}) |`), "",
    "## Counts", "",
    "Record bytes are the UTF-8 length of the record's JSON, a proxy for what the history keeps in memory, not a heap measurement. Undo update bytes are what the undo transaction sends. State growth is the change in `Y.encodeStateAsUpdate` length; negative values are deleted format markers and text collapsing into deletion ranges. Durable records are entries the undo adds to shared maps; only a join redo removes any, the retirements its undo wrote.", "",
    "| Command | Record bytes | Undo update bytes | State growth | Durable records written by undo |", "| --- | --- | --- | --- | --- |",
    ...kinds.map(kind => `| ${kind.kind} | ${kind.recordBytes} | ${kind.undoUpdateBytes} | ${kind.stateGrowthBytes} | ${Object.entries(kind.durable).map(([root, count]) => `${count} in \`${root}\``).join(", ") || "none"} |`), "",
    `Each restored character costs one \`restoredIdentities\` entry: undoing a one-character delete grows the shared state by ${growth("range delete, 1 character")} bytes, a ten-character delete by ${growth("range delete, 10 characters")}. Recording one entry per contiguous run would cut this; not tried.`, "",
    "### A 200-entry bound per writer", "",
    `Alice runs 250 commands: 50 single-character inserts, one status change, then 199 commands cycling insert, bold, tag, whole-segment move and delete, while Bob inserts ${bound.bobInserts.length} characters. With a bound of 200 the history drops the ${counts.dropped} oldest records (${counts.droppedBytes} bytes) and releases them, keeping only that count; it keeps ${counts.kept} (${counts.keptBytes} bytes: ${Object.entries(counts.keptByKind).map(([kind, count]) => `${count} ${kind}`).join(", ")}). The kept records name ${counts.referencedIdentities} distinct identities and ${counts.referencedStatusEvents} status event. \`bound.test.ts\` undoes the 200 kept entries one by one, requires each to be effective, the oldest kept entry (the status change) included, checks the result on Alice, Bob and a late joiner, and requires a 201st undo to find nothing. Undoing them writes ${restoredAfterBound} \`restoredIdentities\` entries and ${retiredAfterBound} \`retiredStatus\` entry. The second test in that file copies the 200 records as JSON into a history on a fresh replica loaded from Alice's encoded state and checks the same result.`, "",
    "So a bound drops only local records. Nothing shared has to be kept for the dropped entries. For the kept ones to work, these must stay durable: the document's deleted items (their positions; their text is in the record), the `restoredIdentities` and `retiredStatus` entries and status events, the removal records, and the comment and reply records. A `retiredJoins` entry must stay until a join redo deletes it, which is the only removal. A writer's kept entry may follow a restoration chain or test a retirement written by another writer, so an entry in those maps can be compacted only once no history, including a reloaded one, can name it.", "",
    "## What the command layer must record", "",
    "Each command records right after its local transaction commits, not inside it. `cases.test.ts` shows the gap: an `afterTransaction` listener sees the inserted text while the history is still empty. A crash between the two leaves the edit without a record, so it cannot be undone. A listener that calls undo in that gap undoes the writer's previous entry instead. Recording inside the transaction would close the gap; the #1419 capture route depends on recording after it.", "",
    "- Text insert: the identities of the inserted characters, and the caret before the command as an identity with its side.",
    "- Range delete: each deleted character's identity, value and attributes in document order, and the selection as identities with sides. Undo restores each at its own tombstone; a run with no live text between tombstones stays together.",
    "- Replacement (one native commit): both of the above in one record.",
    "- Split: the new boundary embed's identity and the caret before the split, held as identities with sides; a caret at the end of a beat is held by the character before it, and an empty beat by its container. Undo deletes the embed and leaves the beat record; redo restores the embed as a new identity.",
    "- Join: the join entry id and its two beats. Undo checks that its own entry is live, then retires every live matching entry and records which entries it retired; redo deletes those retirements, so the join that won before the undo wins again.",
    "- Heading create or remove: the deleted or restored marker characters, the boundary embed or the segment's `head` key with its prior value, the beat record's presence, and the removal record the heading replaced. A beat-record undo keeps the record's fields, so its redo restores the joins and removal entries other writers stored in it.",
    "- Range replacement across beats (cut and paste, header rewrite): the deleted characters as identities with values and attributes, the beats removed whole, and the inserted identities.",
    "- Plain key of a shared map (segment head, paragraph start): the path, the prior and the written value; undo writes the prior only while the record still exists and the current value is still the written one.",
    "- Soft removal: the beat and the removal entry id. Undo checks that its own entry exists, then deletes every beat removal entry of that beat and records which; redo sets those entries again.",
    "- Whole-segment move: the identities and values of the deleted order entries and the identity of the inserted one.",
    "- Mark add or remove (bold, link, comment highlight, tag): the key, the first and last identity, and each character's prior value. Undo sets each character now between the two identities to the prior value of the nearest recorded character on its left (the first one if none), which also clears a mark another writer's concurrent insertion picked up. A tag's key is derived from the tag and its first and last identity, so identical simultaneous tags are one mark.",
    "- Comment or reply creation: the record id and its fields, so redo can recreate them.",
    "- Status: the event id. Undo applies main's frontier retirement; redo writes a fresh event that `readStatusEvent` accepts.",
    "- Plain scalar (LWW) value: the prior and the written value. Undo writes the prior only if the current value is still the written one.", "",
    "The history then needs three shared mechanisms, each with a control above: a shared `restoredIdentities` map that each restore writes and the history follows whenever it resolves a record or returns a selection, with no fixed chain length; an ineffective undo that consumes exactly its own entry, while an undo that throws keeps it; and own-entry checks before retiring joins or removals. Records and the selections the history returns follow restorations through that map, not Yjs `redone` links.", "",
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
