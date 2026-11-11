import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOrders } from "../../collab/delivery.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { deliveryReplica } from "./helpers.ts";
import { readSharedStatus } from "../../../src/adapters/collab/status.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { agree, execute, ref, replicas } from "./executor-support.ts";

interface GeneratedStatus { id: string; value: string; parents: string[] }
const declaredLimits: readonly string[] = [];

function modelStatus(commands: readonly GeneratedStatus[], stored: string): string {
  const byId = new Map(commands.map(command => [command.id, command]));
  const parents = new Set(commands.flatMap(command => command.parents));
  const heads = commands.filter(command => !parents.has(command.id));
  if (!heads.length) return stored;
  if (heads.every(command => command.value === heads[0]?.value)) return heads[0]?.value ?? stored;
  const ancestry = (command: GeneratedStatus): Set<string> => {
    const found = new Set<string>(), pending = [...command.parents];
    while (pending.length) {
      const id = pending.pop(); if (!id || found.has(id)) continue;
      found.add(id); pending.push(...byId.get(id)?.parents ?? []);
    }
    return found;
  };
  const branches = heads.map(ancestry);
  return modelStatus(commands.filter(command => branches.every(branch => branch.has(command.id))), stored);
}

for (const order of deliveryOrders) for (const writers of [2, 3]) test(`seeded scalar/status command model ${writers} writers ${order}`, () => {
  let histories = 0, checkpoints = 0, commands = 0, sequential = 0, selective = 0, late = 0;
  const violations: string[] = [];
  for (const seed of [1414, 1416, 0x5eed]) {
    const run = replicas(writers), handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
    let random = seed;
    const pick = (limit: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % limit; };
    const targets = [{ scope: "beat", record: "R1", values: ["todo", "ready", "shot"] },
      { scope: "tag", record: "t_1", values: ["needed", "sourcing", "have", "returned"] },
      { scope: "shot", record: "S1", values: ["unshot", "shot"] }] as const;
    const logs = targets.map(() => [] as GeneratedStatus[]);
    let joined = false;
    try {
      for (let round = 0; round < 8; round++) {
        for (const [domain, address] of targets.entries()) {
          const log = logs[domain]; assert.ok(log);
          const parentIds = new Set(log.flatMap(command => command.parents));
          const base = log.filter(command => !parentIds.has(command.id)).map(command => command.id);
          let visible = [...base];
          for (const [writer, handle] of handles.entries()) {
            const id = `${seed}-${round}-${domain}-${writer}`, value = address.values[pick(address.values.length)]; assert.ok(value);
            const parents = order === "D1" || order === "D3" && writer === 1 ? [...visible] : [...base];
            execute(handle, { kind: "status", id, by: `writer${writer}`, target: { scope: address.scope, record: address.record }, value, parents });
            log.push({ id, value, parents }); commands++;
            if (order === "D1") { run.queue.flush(order); visible = [id]; sequential++; }
            if (order === "D3" && writer === 0) {
              const message = run.queue.pending.find(message => message.from === "A" && message.to === "B"); assert.ok(message);
              run.queue.deliver(message.id); visible = [id]; selective++;
            }
          }
          run.queue.flush(order);
          const target = { scope: address.scope, record: ref(address.record) };
          const expected = modelStatus(log, address.values[0]);
          try { agree(`model ${seed}/${round}/${domain}`, order, joined ? [...handles, run.c] : handles, handle => readSharedStatus(handle, target), expected); }
          catch (error) { violations.push(String(error)); }
          checkpoints++;
        }
        const document = String(collabState(run.a).roots.meta.get("docId"));
        const scalarCommands = [
          ["document", document, "fileTitle", { titleOrigin: "user", titleVersion: `v${round}` }],
          ["document", document, "wordsPerMinute", 60 + pick(341)], ["document", document, "targetSeconds", 1 + pick(86400)],
          ["document", document, "paragraphsDecided", true], ["beat", "R1", "lengthSeconds", pick(86401)],
          ["beat", "R1", "paragraphStart", true], ["beat", "R1", "stamp", { at: String(round), by: "writer" }],
          ["heading", "H1", "extra", JSON.stringify({ future: pick(100) })], ["document", document, "extra", "{}"], ["beat", "R1", "extra", "{}"]
        ] as const;
        for (const [index, [scope, record, field, value]] of scalarCommands.entries()) {
          const handle = handles[index % handles.length]; assert.ok(handle);
          execute(handle, { kind: "scalar", id: `scalar${round}-${index}`, by: "writer", target: { scope, record }, field, value }); commands++;
          if (order === "D1") { run.queue.flush(order); sequential++; }
          if (order === "D3" && index === 3) { run.queue.deliverFrom("B", order); selective++; }
        }
        run.queue.flush(order);
        for (const target of [{ scope: "document", record: ref(document) }, { scope: "beat", record: ref("R1") }, { scope: "heading", record: ref("H1") }] as const) {
          const fields = target.scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
            : target.scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra"] : ["extra"];
          const expected = Object.fromEntries(fields.map(field => [field, scalarCommands.find(command => command[0] === target.scope && command[2] === field)?.[3]]));
          agree("scalar checkpoint", order, joined ? [...handles, run.c] : handles, handle => readSharedScalars(handle, target), expected); checkpoints++;
        }
        for (const [index, [scope, record, field]] of scalarCommands.entries()) {
          if (!["targetSeconds", "lengthSeconds", "paragraphStart"].includes(field)) continue;
          execute(run.a, { kind: "scalar", id: `clear${round}-${index}`, by: "writer", target: { scope, record }, field, clear: true }); commands++;
        }
        run.queue.flush(order);
        if (order === "late-C" && writers === 2 && round === 3) {
          run.queue.lateJoin("C", deliveryReplica(run.c), "A", encodeSharedState(run.a)); joined = true; late++;
        }
      }
      histories++;
    } finally { run.close(); }
  }
  assert.deepEqual(violations, declaredLimits);
  assert.equal(histories, 3); assert.equal(checkpoints, 144);
  assert.equal(commands, 3 * 8 * (writers * 3 + 13));
  assert.equal(sequential > 0, order === "D1"); assert.equal(selective > 0, order === "D3");
  assert.equal(late, order === "late-C" && writers === 2 ? 3 : 0);
});
