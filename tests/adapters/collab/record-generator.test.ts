import assert from "node:assert/strict";
import { test } from "node:test";
import type { SharedOperation, SharedRecordCollection, SharedStatusEvent } from "../../../src/core/collab/operations.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, operation, ref } from "./executor-support.ts";
import { deliveryReplica } from "./helpers.ts";
import { createRecord, setRecord, deleteRecord, recordExamples, recordReplicas } from "./record-support.ts";

const kinds: readonly SharedRecordCollection[] = ["comments", "replies", "people", "tags", "shots", "gallery", "visuals"];
const declaredLimits: readonly string[] = [];
function statusModel(commands: readonly SharedStatusEvent[], stored: string): string {
  const parents = new Set<string>(commands.flatMap(command => command.parents)), heads = commands.filter(command => !parents.has(command.id));
  if (!heads.length) return stored;
  if (heads.every(command => command.value === heads[0]?.value)) return heads[0]?.value ?? stored;
  const ancestry = heads.map(command => {
    const result = new Set<string>(), pending: string[] = [...command.parents];
    while (pending.length) {
      const id = pending.pop(); if (!id || result.has(id)) continue;
      result.add(id); pending.push(...commands.find(command => command.id === id)?.parents ?? []);
    }
    return result;
  });
  return statusModel(commands.filter(command => ancestry.every(branch => branch.has(command.id))), stored);
}
function authorModel(commands: readonly SharedOperation[], kind: "comments" | "replies") {
  const records = new Map<string, Record<string, unknown>>();
  for (const command of commands) {
    if (command.kind !== "record-create" && command.kind !== "record-set" && command.kind !== "record-delete" || command.target.collection !== kind) continue;
    const key = command.target.record;
    if (command.kind === "record-create") records.set(key, { ...command.fields, id: command.fields.id ?? key, author: command.by });
    if (command.kind === "record-delete") records.delete(key);
    const record = records.get(key);
    if (command.kind === "record-set" && record && command.field === "text" && record.author === command.by) record.text = command.clear ? undefined : command.value;
  }
  return [...records.values()].sort((a, b) => (kind === "replies" ? Number(a.createdAt) - Number(b.createdAt) : 0)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .map(record => kind === "replies" ? { id: record.id, commentId: record.commentId, author: record.author, createdAt: record.createdAt, text: record.text }
      : { id: record.id, author: record.author, createdAt: record.createdAt, text: record.text });
}

for (const order of deliveryOrders) for (const writers of [2, 3]) test(`seeded all-kind records/scalars ${writers} writers ${order}`, t => {
  let histories = 0, checkpoints = 0, accepted = 0, denied = 0, sequential = 0, selective = 0, late = 0, visibility = 0, clearChecks = 0;
  const violations: string[] = [], covered = new Set<string>();
  for (const seed of [1414, 1416, 0x5eed]) {
    const run = recordReplicas(writers), handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])], trace: SharedOperation[] = [];
    let random = seed, joined = false;
    const pick = (limit: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % limit; };
    const submit = (writer: number, raw: unknown, allow = true): void => {
      const handle = handles[writer] ?? (joined && writer === 2 ? run.c : undefined); assert.ok(handle);
      const command = operation(raw); trace.push(command); covered.add(command.kind);
      const before = allow ? null : encodeSharedState(handle), result = executeSharedOperations(handle, [command]);
      assert.equal(result.ok, allow, JSON.stringify(trace));
      if (!allow) { assert.deepEqual(encodeSharedState(handle), before); denied++; }
      else accepted++;
      if (order === "D2") { run.queue.flush(order); sequential++; }
    };
    const checkpoint = (): void => {
      run.queue.flush(order);
      const copies = joined ? [...handles, run.c] : handles;
      try {
        for (const kind of kinds) agree(`records ${seed}/${checkpoints}/${kind}`, order, copies, handle => readSharedRecords(handle, kind));
        for (const kind of ["comments", "replies"] as const) agree(`author/order model ${kind}`, order, copies, handle => readSharedRecords(handle, kind)
          .map(({ fields }) => kind === "replies" ? { id: fields.id, commentId: fields.commentId, author: fields.author, createdAt: fields.createdAt, text: fields.text }
            : { id: fields.id, author: fields.author, createdAt: fields.createdAt, text: fields.text }), authorModel(trace, kind));
        for (const [scope, record, stored] of [["beat", "R1", "todo"], ["tag", "t_1", "needed"], ["shot", "S1", "unshot"]] as const) {
          const events = trace.filter((command): command is SharedStatusEvent => command.kind === "status" && command.target.scope === scope && command.target.record === record);
          agree("status command model", order, copies, handle => readSharedStatus(handle, { scope, record: ref(record) }), statusModel(events, stored));
        }
        const document = String(collabState(run.a).roots.meta.get("docId"));
        for (const target of [{ scope: "document", record: ref(document) }, { scope: "beat", record: ref("R1") }, { scope: "heading", record: ref("H1") }] as const)
          agree("scalar reload", order, copies, handle => readSharedScalars(handle, target));
      } catch (error) { violations.push(`${String(error)}\n${JSON.stringify(trace)}`); }
      checkpoints++;
    };
    try {
      for (let round = 0; round < 8; round++) {
        const keys: { kind: SharedRecordCollection; key: string; writer: number }[] = [];
        for (let writer = 0; writer < writers; writer++) {
          if (writer) {
            const handle = handles[writer]; assert.ok(handle);
            assert.equal(readSharedRecords(handle, "comments").some(record => record.key === `c${seed}-${round}-0`), order === "D2"); visibility++;
          }
          const by = `writer${writer}`, suffix = `${seed}-${round}-${writer}`, comment = `c${suffix}`;
          for (const kind of kinds) {
            const id = kind === "comments" ? comment : `${kind}${suffix}`, key = kind === "replies" ? JSON.stringify([comment, id]) : id;
            const fields: Record<string, unknown> = { ...recordExamples[kind], future: pick(100) };
            if (kind !== "gallery" && kind !== "visuals") fields.id = id;
            if (kind === "comments" || kind === "replies") { fields.author = by; fields.createdAt = pick(4); }
            if (kind === "replies") fields.commentId = comment;
            submit(writer, createRecord(kind, key, fields, by));
            const field = kind === "comments" || kind === "replies" ? "text" : kind === "people" ? "name" : kind === "gallery" ? "picture" : kind === "visuals" ? "rank" : "notes";
            submit(writer, setRecord(kind, key, field, kind === "gallery" ? { name: suffix } : `edit${suffix}`, by));
            submit(writer, { kind: "record-set", id: `clear${key}`, by, target: { collection: kind, record: key }, field: "future", clear: true });
            const cleared = readSharedRecords(handles[writer] as typeof run.a, kind).find(record => record.key === key); assert.ok(cleared);
            assert.equal(Object.hasOwn(cleared.fields, "future"), false); clearChecks++;
            if (kind === "comments" || kind === "replies") submit(writer, setRecord(kind, key, "text", "foreign", "stranger"), false);
            keys.push({ kind, key, writer });
          }
          const document = String(collabState(run.a).roots.meta.get("docId"));
          for (const [scope, record, field, value] of [["document", document, "wordsPerMinute", 60 + pick(341)], ["beat", "R1", "lengthSeconds", pick(86401)], ["heading", "H1", "extra", JSON.stringify({ future: pick(100) })]] as const)
            submit(writer, { kind: "scalar", id: `${scope}${suffix}`, by, target: { scope, record }, field, value });
          if (order === "D3" && writer === 1) {
            run.queue.deliverFrom("B", order); selective++;
            assert.ok(readSharedRecords(run.a, "comments").some(record => record.key === comment));
            assert.equal(readSharedRecords(run.b, "comments").some(record => record.key === `c${seed}-${round}-0`), false);
            assert.ok(run.queue.pending.some(message => message.from === "A" && message.to === "B")); visibility++;
          }
        }
        run.queue.flush(order);
        for (const [scope, record, values] of [["beat", "R1", ["todo", "ready", "shot"]], ["tag", "t_1", ["needed", "sourcing", "have", "returned"]], ["shot", "S1", ["unshot", "shot"]]] as const) {
          const previous = trace.filter((command): command is SharedStatusEvent => command.kind === "status" && command.target.scope === scope);
          const parentIds = new Set<string>(previous.flatMap(command => command.parents)), base = previous.filter(command => !parentIds.has(command.id)).map(command => command.id);
          let visible: string[] = [...base], bob = "";
          const target = { scope, record: ref(record) };
          const heads = (handle: typeof run.a): string[] => readSharedStatusHeads(handle, target).map(id => (JSON.parse(id) as string[])[1] as string).sort();
          for (let writer = 0; writer < writers; writer++) {
            const id = `${scope}${seed}-${round}-${writer}`, parents = order === "D2" ? visible : order === "D3" && writer === 2 ? [bob] : base;
            const handle = handles[writer]; assert.ok(handle);
            if (writer) { assert.deepEqual(heads(handle), [...parents].sort()); visibility++; }
            submit(writer, { kind: "status", id, by: `writer${writer}`, target: { scope, record }, value: values[pick(values.length)], parents });
            if (order === "D2") visible = [id];
            if (order === "D3" && writer === 1) {
              bob = id; run.queue.deliverFrom("B", order); selective++;
              const alice = `${scope}${seed}-${round}-0`;
              assert.deepEqual(heads(run.a), [alice, bob].sort()); assert.deepEqual(heads(run.b), [bob]);
              assert.ok(run.queue.pending.some(message => message.from === "A" && message.to === "B")); visibility++;
              submit(0, { kind: "status", id: `${scope}${seed}-${round}-follow`, by: "writer0", target, value: values[pick(values.length)], parents: [alice, bob] });
            }
          }
          run.queue.flush(order);
        }
        const common = kinds.map(kind => {
          const id = `z-shared-${kind}-${seed}-${round}`, key = kind === "replies" ? JSON.stringify(["C1", id]) : id;
          const fields: Record<string, unknown> = { ...recordExamples[kind], rank: "shared" };
          if (kind !== "gallery" && kind !== "visuals") fields.id = id;
          if (kind === "comments" || kind === "replies") { fields.author = "same-author"; fields.text = "start"; }
          submit(0, createRecord(kind, key, fields, "same-author"));
          return { kind, key, field: kind === "comments" || kind === "replies" ? "text" : "rank" };
        });
        run.queue.flush(order);
        const commentKey = common[0]?.key; assert.ok(commentKey);
        const commonText = (handle: typeof run.a): unknown => readSharedRecords(handle, "comments").find(record => record.key === commentKey)?.fields.text;
        for (let writer = 0; writer < writers; writer++) {
          const handle = handles[writer]; assert.ok(handle);
          if (writer) {
            assert.equal(commonText(handle), order === "D2" ? `shared${writer - 1}` : order === "D3" && writer === 2 ? "shared1" : "start"); visibility++;
          }
          for (const { kind, key, field } of common) submit(writer, setRecord(kind, key, field, `shared${writer}`, "same-author"));
          if (order === "D3" && writer === 1) {
            run.queue.deliverFrom("B", order); selective++;
            assert.equal(commonText(run.a), "shared1"); assert.equal(commonText(run.b), "shared1");
            assert.ok(run.queue.pending.some(message => message.from === "A" && message.to === "B")); visibility++;
          }
        }
        checkpoint();
        for (const { kind, key } of common) submit(0, deleteRecord(kind, key));
        for (let writer = 1; writer < writers; writer++) {
          const handle = handles[writer]; assert.ok(handle);
          assert.equal(commonText(handle) === undefined, order === "D2"); visibility++;
          for (const { kind, key, field } of common) submit(writer, setRecord(kind, key, field, "racing edit", "same-author"), order !== "D2");
        }
        for (const { kind, key, writer } of keys) submit(writer, deleteRecord(kind, key, `writer${writer}`));
        checkpoint();
        if (order === "late-C" && writers === 2 && round === 3) {
          run.queue.lateJoin("C", deliveryReplica(run.c), "A", encodeSharedState(run.a)); joined = true; late++;
          const target = { scope: "heading" as const, record: ref("H1") }, value = JSON.stringify({ joined: seed });
          submit(2, { kind: "scalar", id: `late${seed}`, by: "late", target, field: "extra", value });
          assert.ok(run.queue.pending.some(message => message.from === "C" && message.to === "A"));
          assert.notEqual(readSharedScalars(run.a, target)?.extra, value); visibility++;
          checkpoint();
          agree("late joiner authors back to existing writers", order, [run.a, run.b, run.c], handle => readSharedScalars(handle, target)?.extra, value);
        }
      }
      histories++;
    } finally { run.close(); }
  }
  const liveLate = order === "late-C" && writers === 2;
  assert.deepEqual(violations, declaredLimits); assert.equal(histories, 3); assert.equal(checkpoints, liveLate ? 51 : 48);
  assert.deepEqual([...covered].sort(), ["record-create", "record-delete", "record-set", "scalar", "status"]);
  assert.equal(accepted, 24 * (writers * 41 + 14 + (order === "D2" ? 0 : 7 * (writers - 1)) + (order === "D3" ? 3 : 0)) + (liveLate ? 3 : 0));
  assert.equal(denied, 24 * (writers * 2 + (order === "D2" ? 7 * (writers - 1) : 0)));
  assert.equal(visibility, 24 * (6 * (writers - 1) + (order === "D3" ? 5 : 0)) + (liveLate ? 3 : 0));
  assert.equal(sequential, order === "D2" ? accepted + denied : 0); assert.equal(selective, order === "D3" ? 120 : 0); assert.equal(late, liveLate ? 3 : 0);
  assert.equal(clearChecks, 24 * writers * 7);
  t.diagnostic(JSON.stringify({ order, writers, histories, commands: accepted + denied, accepted, denied, checkpoints, visibility, clearChecks, sequential, selective, late }));
});
