import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";

const identities = [
  { beat: "structure_1_007200310037_beat_0", removal: "structure_1_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_1_007200310037_visual_0", a: "structure_1_0061_removal_0" },
  { beat: "structure_2_007200310037_beat_0", removal: "structure_2_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_2_007200310037_visual_0", a: "structure_2_0061_removal_0" },
  { beat: "structure_3_007200310037_beat_0", removal: "structure_3_007200310037005f00720065006d006f00760065_removal_0", visual: "structure_3_007200310037_visual_0", a: "structure_3_0061_removal_0" }
];
const declaredLimits: readonly string[] = [];

test("seeded removal checkpoints agree with a literal model and fresh ownership and attachment indexes", t => {
  let seed = 0x5c33, histories = 0, checkpoints = 0, comparisons = 0, commands = 0, earlyRestores = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const runtime = createFlowLoadRuntime(), violations = new Set<string>();
  for (let sample = 0; sample < 12; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), offset = random(3), first = random(copies), early = random(2) === 0;
    const send = (handle: typeof set.a, ops: unknown[]) => { assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true }); commands += ops.length; };
    const text = (copies === 2 ? ["ABcd", "cABd", "cdAB"] : ["ABCcd", "cABCd", "cdABC"])[offset]; assert.ok(text);
    const original = [{ id: "R1", text: "ab" }, { id: "R2", text }, { id: "R3", text: "ef" }];
    const created = identities.slice(0, copies).map((value, index) => ({ id: value.beat, text: "MNO".charAt(index) }));
    const checkpoint = (removed: boolean) => {
      set.queue.flush(order); checkpoints++;
      agree("seed=" + seed, order, handles, handle => {
        const value = projectSharedDocumentWithRecovery(handle), prep = createSharedPreparation(handle), index = observeSharedStructureIndex(handle).attachments();
        try {
          const targets = ["R1", "R2", "R3", ...created.map(row => row.id)];
          const result = { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
            assert.equal(entry.kind, "removed-beat"); return entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText } : null;
          }).sort((a, b) => String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0), owners: targets.map(id => prep.view.resolveOwner(id, "audioText")),
          attachments: targets.map(id => [index.keys("visuals", id), index.keys("gallery", id)]) };
          const expectedRows = removed ? [original[0], original[2]] : [...original, ...created];
          const expectedRecovery = removed ? [original[1], ...created].sort((a, b) => String(a?.id) < String(b?.id) ? -1 : 1) : [];
          try { assert.deepEqual({ rows: result.rows, recovery: result.recovery }, { rows: expectedRows, recovery: expectedRecovery }); }
          catch (error) { violations.add(String(error)); }
          comparisons++; return result;
        } finally { prep.close(); }
      });
    };
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); }
      for (let index = 0; index < copies; index++) {
        const handle = handles[(first + index) % copies]; assert.ok(handle); const writer = handles.indexOf(handle), letter = "ABC".charAt(writer);
        send(handle, [
          { kind: "segment-create", id: "r17", by: "Writer", beat: "new", segment: "segment", at: { left: "R3", right: null, affinity: "after" }, fields: { audioText: "MNO".charAt(writer), visualText: letter } },
          { kind: "remove", id: "r17_remove", by: "Writer", removalKind: "beat", targets: ["new"], observed: [flowBaseReference("new", "audioText", 0, 1)], boundaries: ["new"], components: [], gallery: [], at: 3 },
          { kind: "text-insert", id: "typed", by: "Writer", target: { owner: "R2", segment: "R2", field: "audioText" }, at: { left: null, right: flowBaseReference("R2", "audioText", offset), affinity: "before" }, content: [{ value: letter, marks: [] }] },
          { kind: "remove", id: "a", by: "Writer", removalKind: "beat", targets: ["R2"], observed: [flowBaseReference("R2", "audioText", 0, 2)], boundaries: ["R2"], components: [], gallery: [], at: 1 }
        ]);
      }
      const restore = () => { for (let index = 0; index < copies; index++) { const handle = handles[index], ids = identities[index]; assert.ok(handle && ids);
        send(handle, [{ kind: "restore", id: "back", by: "Writer", removals: [ids.a, ids.removal] }]); } };
      if (early) { restore(); earlyRestores++; }
      checkpoint(!early);
      if (!early) restore();
      checkpoint(false);
      const roots = collabState(set.a).roots; assert.equal(roots.order.length, 3 + copies); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.deepEqual({ histories, checkpoints, comparisons, commands, earlyRestores }, { histories: 72, checkpoints: 144, comparisons: 504, commands: 900, earlyRestores: 36 });
  t.diagnostic(JSON.stringify({ seed: "0x5c33", histories, checkpoints, comparisons, commands, earlyRestores, declaredLimits }));
});

test("seeded heading removals agree with a literal model through typing, restores, reordered delivery and a late joiner", t => {
  let seed = 0x4d08, histories = 0, checkpoints = 0, commands = 0, demotions = 0, earlyRestores = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; }, violations = new Set<string>();
  const place = (base: string, typed: readonly { writer: number; offset: number; letter: string }[]) => {
    let out = "";
    for (let at = 0; at <= base.length; at++) out += typed.filter(item => item.offset === at).sort((a, b) => a.writer - b.writer).map(item => item.letter).join("") + base.charAt(at);
    return out;
  };
  for (let sample = 0; sample < 6; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), remover = random(copies), demote = random(2) === 0, early = random(2) === 0, restorer = random(copies);
    const typed = handles.flatMap((_, writer) => writer === remover ? [] : [{ writer, letter: "PQR".charAt(writer), heading: random(2) === 0, offset: 0 }])
      .map(item => ({ ...item, offset: item.heading ? 1 + random(2) : random(3) }));
    const send = (handle: typeof set.a, ops: unknown[]) => { assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true }); commands += ops.length; };
    const removal = "structure_" + (remover + 1) + "_0075006e0068006500610064_removal_0";
    const checkpoint = (removed: boolean) => {
      set.queue.flush(order); checkpoints++;
      const name = place("In", typed.filter(item => item.heading)), narration = place("ab", typed.filter(item => !item.heading));
      const expected = { rows: demote ? [["R0", "x", false], ["Rn", name, false], ["R1", narration, true]] : [["R0", "x", false], ["R1", narration, false]],
        sections: !demote && !removed ? [["H1", name, "R1"]] : [], recovery: !demote && removed ? [["removed-heading", "H1", name]] : [], owner: removed ? null : "H1" };
      agree("seed=" + seed, order, handles, handle => {
        const { document, recovery } = projectSharedDocumentWithRecovery(handle), prep = createSharedPreparation(handle);
        try {
          const result = { rows: document.rows.map(row => [row.id.startsWith("structure_") ? "Rn" : row.id, row.audioText, row.paragraphStart === true]),
            sections: ((document.sections ?? []) as { id: string; name: string; firstSceneId: string }[]).map(scene => [scene.id, scene.name, scene.firstSceneId]),
            recovery: recovery.map(entry => entry.kind === "removed-heading" ? [entry.kind, entry.heading.id, entry.heading.name] : [entry.kind]),
            owner: prep.view.resolveOwner("H1", "heading")?.owner ?? null };
          try { assert.deepEqual(result, expected); } catch (error) { violations.add(String(error)); }
          return result;
        } finally { prep.close(); }
      });
    };
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); }
      for (const item of typed) {
        const handle = handles[item.writer], field = item.heading ? "heading" : "audioText", owner = item.heading ? "H1" : "R1"; assert.ok(handle);
        send(handle, [{ kind: "text-insert", id: "typed", by: "Writer", target: { owner, segment: (item.heading ? "h:" : "b:") + owner, field },
          at: item.offset ? { left: flowBaseReference(owner, field, item.offset - 1), right: null, affinity: "after" } : { left: null, right: flowBaseReference(owner, field, 0), affinity: "before" },
          content: [{ value: item.letter, marks: [] }] }]);
      }
      const author = handles[remover]; assert.ok(author);
      send(author, [{ kind: "heading-remove", id: "unhead", by: "Writer", heading: "H1", observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat: demote ? "Rn" : null, nextBeat: demote ? "R1" : null },
        ...demote ? [{ kind: "scalar", id: "para", by: "Writer", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true }] : []]);
      const restore = (handle: typeof set.a) => send(handle, [{ kind: "restore", id: "back", by: "Writer", removals: [removal] }]);
      if (early) { restore(author); earlyRestores++; } else { checkpoint(true); const handle = handles[restorer]; assert.ok(handle); restore(handle); }
      checkpoint(false);
      histories++; if (demote) demotions++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits);
  assert.deepEqual({ histories, checkpoints, commands, demotions, earlyRestores }, { histories: 36, checkpoints: 56, commands: 144, demotions: 18, earlyRestores: 16 });
  t.diagnostic(JSON.stringify({ seed: "0x4d08", histories, checkpoints, commands, demotions, earlyRestores, declaredLimits }));
});
