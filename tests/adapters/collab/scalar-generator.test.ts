import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOrders } from "../../collab/delivery.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { deliveryReplica } from "./helpers.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { agree, execute, ref, replicas } from "./executor-support.ts";

interface GeneratedStatus { id: string; value: string; parents: string[] }
const declaredLimits: readonly string[] = [];
function modelStatus(commands: readonly GeneratedStatus[], stored: string): string {
  const byId = new Map(commands.map(command => [command.id, command])), parents = new Set(commands.flatMap(command => command.parents));
  const heads = commands.filter(command => !parents.has(command.id));
  if (!heads.length) return stored;
  if (heads.every(command => command.value === heads[0]?.value)) return heads[0]?.value ?? stored;
  const branches = heads.map(command => {
    const found = new Set<string>(), pending = [...command.parents];
    while (pending.length) { const id = pending.pop(); if (!id || found.has(id)) continue; found.add(id); pending.push(...byId.get(id)?.parents ?? []); }
    return found;
  });
  return modelStatus(commands.filter(command => branches.every(branch => branch.has(command.id))), stored);
}

for (const order of deliveryOrders) for (const writers of [2, 3]) test(`seeded scalar/status command model ${writers} writers ${order}`, () => {
  let histories = 0, checkpoints = 0, commands = 0, sequential = 0, selective = 0, late = 0, visibility = 0;
  const violations: string[] = [];
  for (const seed of [1414, 1416, 0x5eed]) {
    const run = replicas(writers), handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
    let random = seed, joined = false;
    const pick = (limit: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % limit; };
    const targets = [{ scope: "beat", record: "R1", values: ["todo", "ready", "shot"] },
      { scope: "tag", record: "t_1", values: ["needed", "sourcing", "have", "returned"] }, { scope: "shot", record: "S1", values: ["unshot", "shot"] }] as const;
    const logs = targets.map(() => [] as GeneratedStatus[]);
    try {
      for (let round = 0; round < 8; round++) {
        for (const [domain, address] of targets.entries()) {
          const log = logs[domain]; assert.ok(log);
          const parentIds = new Set(log.flatMap(command => command.parents)), base = log.filter(command => !parentIds.has(command.id)).map(command => command.id);
          const target = { scope: address.scope, record: ref(address.record) };
          const heads = (handle: typeof run.a): string[] => readSharedStatusHeads(handle, target).map(id => (JSON.parse(id) as string[])[1] as string).sort();
          let visible = [...base], bob = "";
          const write = (writer: number, id: string, parents: string[]): void => {
            const handle = handles[writer], value = address.values[pick(address.values.length)]; assert.ok(handle && value);
            execute(handle, { kind: "status", id, by: `writer${writer}`, target, value, parents }); log.push({ id, value, parents }); commands++;
          };
          for (let writer = 0; writer < writers; writer++) {
            const handle = handles[writer]; assert.ok(handle);
            const parents = order === "D2" ? visible : order === "D3" && writer === 2 ? [bob] : base;
            if (writer) { assert.deepEqual(heads(handle), [...parents].sort()); visibility++; }
            const id = `${seed}-${round}-${domain}-${writer}`;
            write(writer, id, [...parents]);
            if (order === "D2") { run.queue.flush(order); visible = [id]; sequential++; assert.equal(run.queue.pending.length, 0); }
            if (order === "D3" && writer === 1) {
              bob = id; run.queue.deliverFrom("B", order); selective++;
              const alice = `${seed}-${round}-${domain}-0`;
              assert.deepEqual(heads(run.a), [alice, bob].sort()); assert.deepEqual(heads(run.b), [bob]);
              assert.ok(run.queue.pending.some(message => message.from === "A" && message.to === "B")); visibility++;
              write(0, `${seed}-${round}-${domain}-follow`, [alice, bob]);
            }
          }
          run.queue.flush(order);
          try { agree(`model ${seed}/${round}/${domain}`, order, joined ? [...handles, run.c] : handles, handle => readSharedStatus(handle, target), modelStatus(log, address.values[0])); }
          catch (error) { violations.push(String(error)); }
          checkpoints++;
        }
        const document = String(collabState(run.a).roots.meta.get("docId"));
        const scalarCommands = [["document", document, "fileTitle", { titleOrigin: "user", titleVersion: `v${round}` }],
          ["document", document, "wordsPerMinute", 60 + pick(341)], ["document", document, "targetSeconds", 1 + pick(86400)],
          ["document", document, "paragraphsDecided", true], ["beat", "R1", "lengthSeconds", pick(86401)], ["beat", "R1", "paragraphStart", true],
          ["beat", "R1", "stamp", { at: String(round), by: "writer" }], ["heading", "H1", "extra", JSON.stringify({ future: pick(100) })],
          ["document", document, "extra", "{}"], ["beat", "R1", "extra", "{}"]] as const;
        for (const [index, [scope, record, field, value]] of scalarCommands.entries()) {
          const handle = handles[index % handles.length]; assert.ok(handle);
          execute(handle, { kind: "scalar", id: `scalar${round}-${index}`, by: "writer", target: { scope, record }, field, value }); commands++;
          if (order === "D2") { run.queue.flush(order); sequential++; }
        }
        run.queue.flush(order);
        const scalarTargets = [{ scope: "document", record: ref(document) }, { scope: "beat", record: ref("R1") }, { scope: "heading", record: ref("H1") }] as const;
        const expected = scalarTargets.map(target => {
          const fields = target.scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
            : target.scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra"] : ["extra"];
          return Object.fromEntries(fields.map(field => [field, scalarCommands.find(command => command[0] === target.scope && command[2] === field)?.[3]]));
        });
        scalarTargets.forEach((target, index) => { agree("scalar command model", order, joined ? [...handles, run.c] : handles, handle => readSharedScalars(handle, target), expected[index]); checkpoints++; });
        let winningLength = 0;
        for (const [writer, handle] of handles.entries()) {
          winningLength = 1000 + pick(1000);
          execute(handle, { kind: "scalar", id: `competition${round}-${writer}`, by: `writer${writer}`, target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: winningLength }); commands++;
          if (order === "D2") { run.queue.flush(order); sequential++; }
          if (order === "D3" && writer === 1) { run.queue.deliverFrom("B", order); selective++; assert.ok(run.queue.pending.some(message => message.from === "A")); }
        }
        run.queue.flush(order);
        agree("same scalar native client order", order, joined ? [...handles, run.c] : handles, handle => readSharedScalars(handle, { scope: "beat", record: ref("R1") })?.lengthSeconds, winningLength); checkpoints++;
        for (const [index, [scope, record, field]] of scalarCommands.entries()) {
          if (!["targetSeconds", "lengthSeconds", "paragraphStart"].includes(field)) continue;
          execute(run.a, { kind: "scalar", id: `clear${round}-${index}`, by: "writer", target: { scope, record }, field, clear: true }); commands++;
          run.queue.flush(order);
          const targetIndex = scalarTargets.findIndex(target => target.scope === scope), wanted = expected[targetIndex]; assert.ok(wanted);
          Reflect.deleteProperty(wanted, field);
          agree("immediate clear checkpoint", order, joined ? [...handles, run.c] : handles, handle => readSharedScalars(handle, scalarTargets[targetIndex] as typeof scalarTargets[number]), wanted); checkpoints++;
        }
        if (order === "late-C" && writers === 2 && round === 3) { run.queue.lateJoin("C", deliveryReplica(run.c), "A", encodeSharedState(run.a)); joined = true; late++; }
      }
      histories++;
    } finally { run.close(); }
  }
  assert.deepEqual(violations, declaredLimits); assert.equal(histories, 3); assert.equal(checkpoints, 240);
  assert.equal(commands, 3 * 8 * (writers * 4 + 13 + (order === "D3" ? 3 : 0)));
  assert.equal(sequential > 0, order === "D2"); assert.equal(selective > 0, order === "D3");
  assert.equal(visibility, 3 * 8 * 3 * (writers - 1 + (order === "D3" ? 1 : 0)));
  assert.equal(late, order === "late-C" && writers === 2 ? 3 : 0);
});
