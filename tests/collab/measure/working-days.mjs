import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fixtures, writer } from "./run.mjs";
import { retainedBytes } from "./retained-bytes.mjs";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedCommand } from "../../../src/adapters/collab/undo-executor.ts";
import { sharedBrollKeying } from "../../../src/core/collab/broll-keying.ts";
import { sharedCellTextOperations } from "../../../src/core/collab/cell-text-operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { createProductionReaders } from "../../../src/core/production/readers.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { explode, implode } from "../../../src/core/text/edits.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { isMain } from "../../../tools/main-module.mjs";

export const workingDayPlan = Object.freeze({ people: [1, 2, 4], wordsPerPerson: 5000, keysPerWord: 6,
  correctionEvery: 55, typingBlock: 55, rewriteFraction: [1, 12], markEvery: 100,
  splitEvery: 200, joinEvery: 200, removalEvery: 100, creationEvery: 1000,
  commentEvery: 1000, keyingEvery: 1000, replaceEvery: 1000, checkpoints: [1, 2, 5, 10, 20, 60] });

const runtime = createFlowLoadRuntime(), readers = createProductionReaders(runtime.cells, deepFreeze);
const plain = html => runtime.cells(String(html ?? "")).map(run => run.text ?? "").join("");
const address = (owner, field = "audioText") => ({ owner, segment: field === "visualText" ? owner : "b:" + owner, field });

function openDay(binary = null) {
  const handle = createSharedDocument();
  if (binary) assert.deepEqual(applySharedUpdate(handle, binary), { ok: true });
  registerSharedOperationFamilies(handle, runtime); return handle;
}

function commandList(handle, raw, label) {
  const operations = raw.map(value => { const operation = readOperation(value); assert.ok(operation); return operation; });
  const result = executeSharedCommand(handle, operations, { label, typing: null, selection: null }, { base: readSharedRevision(handle) });
  assert.deepEqual(result.result, { ok: true }, label); assert.ok(result.record, label); return result.record;
}

function dailyExtras(handle, edit, source, day, person, counters, previousTyped) {
  const owner = source.rows[(day + person) % source.rows.length].id, target = address(owner), prefix = `e${day}p${person}`;
  const history = () => edit.history(target), observed = () => history().units.slice(-3).map(unit => unit.identity);
  const repeat = (interval, action) => {
    for (let index = Math.floor(previousTyped / interval); index < Math.floor(counters.typed / interval); index++) action(index);
  };
  repeat(workingDayPlan.markEvery, () => {
    const mark = edit.command({ kind: "mark", target, observed: observed(), mark: { kind: "b", value: true } });
    edit.reverse(edit.reverse(mark)); counters.marks++; counters.undoRedo++;
  });
  repeat(workingDayPlan.splitEvery, index => {
  const split = edit.command({ kind: "split", target, at: edit.gap(target, 2), observed: [], boundary: prefix + "boundary" + index, beat: prefix + "split" + index, fields: {} });
  edit.reverse(split); counters.splits++; counters.undos++;
  });
  repeat(workingDayPlan.joinEvery, () => {
  const join = edit.command({ kind: "join", from: source.rows[1].id, into: source.rows[0].id, glue: " " });
  edit.reverse(join); counters.joins++; counters.undos++;
  });
  repeat(workingDayPlan.creationEvery, index => {
  const created = edit.command({ kind: "segment-create", segment: prefix + "segment" + index, beat: prefix + "beat" + index,
    at: { left: source.rows.at(-2).id, right: source.rows.at(-1).id, affinity: "before" }, fields: { audioText: "added", visualText: "" } });
  edit.reverse(edit.reverse(created)); edit.reverse(created); counters.beatsCreated++; counters.undoRedo++; counters.undos++;
  });
  repeat(workingDayPlan.removalEvery, () => {
  const removed = edit.command({ kind: "remove", removalKind: "beat", targets: [owner], observed: history().units.map(unit => unit.identity),
    boundaries: [owner], components: [], gallery: [], at: 1 });
  edit.reverse(removed); counters.beatsRemoved++; counters.undos++;
  });
  repeat(workingDayPlan.commentEvery, index => {
  const comment = prefix + "comment" + index;
  edit.command({ kind: "record-create", target: { collection: "comments", record: comment },
    fields: { text: "Review", author: "Writer" + person, rowId: owner, field: "audioText", anchorId: comment } });
  edit.command({ kind: "mark", target, observed: observed(), mark: { kind: "comment", id: comment, value: true } });
  counters.comments++;
  });
  repeat(workingDayPlan.keyingEvery, index => {
  const visual = address(owner, "visualText"); edit.type(visual, `\nB-roll: Detail ${prefix}\n`);
  const doc = projectSharedDocument(handle), row = doc.rows.find(value => value.id === owner);
  const keyed = sharedBrollKeying({ rowId: owner, cell: runtime.cells(row.visualText), state: doc }, readers, plain,
    { id: prefix + "key" + index, by: "Writer" + person });
  assert.ok(keyed, "unkeyed line must produce keying operations");
  commandList(handle, keyed.operations, "key-broll-lines"); counters.keyings++;
  });
  repeat(workingDayPlan.replaceEvery, index => {
  const before = runtime.cells(projectSharedDocument(handle).rows.find(value => value.id === owner).audioText), units = explode(before);
  const start = Math.max(0, units.length - 3), insert = [{ text: "new", marks: {} }];
  const after = implode([...units.slice(0, start), ...explode(insert)]);
  const replacement = sharedCellTextOperations({ owner, field: "audioText", before, after }, [{ from: start, to: units.length, insert }]);
  assert.ok(replacement);
  commandList(handle, replacement.map((operation, part) => ({ ...operation, id: prefix + "replace" + index + "_" + part, by: "Writer" + person })), "replace");
  counters.replacements++;
  });
}

export function workingDays(fixture, people, words = 10, lastDay = 60, options = {}) {
  const resumed = options.resume;
  let handle = openDay(resumed ? Buffer.from(resumed.state, "base64") : null); collabState(handle).doc.clientID = 100;
  const points = resumed?.points ?? [], counters = resumed?.counters ?? { typed: 0, correctionDeletes: 0, correctionRetypes: 0, rewritten: 0,
    marks: 0, splits: 0, joins: 0, beatsCreated: 0, beatsRemoved: 0, comments: 0, keyings: 0, replacements: 0, undos: 0, undoRedo: 0 };
  let firstCap = resumed?.firstCap ?? null;
  const checkpoint = day => { const doc = projectSharedDocument(handle); return { day, ...retainedBytes(collabState(handle).doc),
    plainBytes: Buffer.byteLength(JSON.stringify(doc, null, 2)), counters: { ...counters } }; };
  try {
    if (!resumed) {
      hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
      points.push(checkpoint(0));
    }
    for (let day = (resumed?.day ?? 0) + 1; day <= lastDay; day++) {
      for (let person = 1; person <= people; person++) {
        collabState(handle).doc.clientID = person;
        const edit = writer(handle, { prefix: `d${day}p${person}k`, by: "Writer" + person, base: () => readSharedRevision(handle) });
        const owner = fixture.document.rows[(day + person) % fixture.document.rows.length].id, target = address(owner);
        const previousTyped = counters.typed;
        for (let key = 0; key < words * workingDayPlan.keysPerWord; key++) {
          const writing = address(fixture.document.rows[(day + person + Math.floor(key / workingDayPlan.typingBlock)) % fixture.document.rows.length].id);
          const value = "words "[key % 6]; edit.type(writing, value, false); counters.typed++;
          if (counters.typed % workingDayPlan.correctionEvery === 0) {
            edit.command({ kind: "text-delete", target: writing, observed: edit.history(writing).units.slice(-1).map(unit => unit.identity) });
            edit.type(writing, value, false); counters.correctionDeletes++; counters.correctionRetypes++;
          }
        }
        const rewrite = Math.floor(words * workingDayPlan.keysPerWord / 12);
        edit.command({ kind: "text-delete", target, observed: edit.history(target).units.slice(-rewrite).map(unit => unit.identity) });
        for (let key = 0; key < rewrite; key++) { edit.type(target, "edit "[key % 5], false); counters.rewritten++; }
        dailyExtras(handle, edit, fixture.document, day, person, counters, previousTyped);
      }
      const binary = encodeSharedState(handle); destroySharedDocument(handle); handle = openDay(binary);
      assert.deepEqual(encodeSharedState(handle), binary, "session reopen must preserve the encoded instance exactly");
      if (!firstCap && binary.length > 2 * 1024 ** 2) firstCap = { day, encodedBytes: binary.length };
      if (workingDayPlan.checkpoints.includes(day) || day === lastDay) {
        points.push(checkpoint(day)); process.stderr.write(`${fixture.name}, ${people} people: byte checkpoint ${day}\n`);
        options.onCheckpoint?.({ profile: 2, fixture: fixture.name, people, words, day, points, firstCap, counters: { ...counters }, state: Buffer.from(binary).toString("base64") });
      }
    }
    return { fixture: fixture.name, people, measuredWordsPerPersonPerDay: words, keysPerWord: 6,
      measured: true, firstCap, sessionReopen: "exact encoded state through applySharedUpdate, every day; no plain projection used to reopen", points };
  } finally { destroySharedDocument(handle); }
}

if (isMain(import.meta.url)) {
  const fixture = fixtures().find(value => value.name === (process.argv[2] ?? "long")); assert.ok(fixture);
  const people = Number(process.argv[3] ?? 1), words = Number(process.argv[4] ?? 10);
  const local = `.cache/working-days-${fixture.name}-${people}-${words}.json`;
  const resume = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")) : null;
  if (resume) assert.deepEqual([resume.profile, resume.fixture, resume.people, resume.words], [2, fixture.name, people, words]);
  const result = workingDays(fixture, people, words, Number(process.argv[5] ?? 60), {
    resume, onCheckpoint: point => writeFileSync(local, JSON.stringify(point))
  });
  writeFileSync(process.argv[6] ?? ".cache/working-days.json", JSON.stringify({ plan: workingDayPlan, result }, null, 2) + "\n");
}
