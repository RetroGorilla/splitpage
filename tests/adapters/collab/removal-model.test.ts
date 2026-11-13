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
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { captureIncrementalReplica, assertIncremental, identityLetters } from "./incremental-support.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";

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
          const targets = ["R1", "R2", "R3", ...created.map(row => row.id)], known = identityLetters(handle);
          const result = { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
            assert.equal(entry.kind, "removed-beat"); return entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText, ids: entry.removal?.ids, by: entry.removal?.by,
              edited: entry.removal?.edited.map(identity => known.get(identity.client + ":" + identity.clock) ?? "?").join("") } : null;
          }).sort((a, b) => String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0), owners: targets.map(id => prep.view.resolveOwner(id, "audioText")),
          attachments: targets.map(id => [index.keys("visuals", id), index.keys("gallery", id)]) };
          const expectedRows = removed ? [original[0], original[2]] : [...original, ...created];
          const removedR2 = { ...original[1], ids: identities.slice(0, copies).map(value => value.a), by: "Writer",
            edited: [...text].filter(value => value !== "c" && value !== "d").join("") };
          const removedCreated = created.map((row, index) => ({ ...row, ids: [identities[index]?.removal], by: "Writer", edited: "" }));
          const expectedRecovery = removed ? [removedR2, ...removedCreated].sort((a, b) => String(a?.id) < String(b?.id) ? -1 : 1) : [];
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

const headingCreationLimits: readonly string[] = [];

test("seeded heading creations agree with a literal model through typing, a rival creation, removals, restores and a late joiner", t => {
  let seed = 0x4d0c, histories = 0, checkpoints = 0, commands = 0, inline = 0, rivals = 0, headingRemovals = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; }, violations = new Set<string>();
  const runtime = createFlowLoadRuntime(), hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const native = (writer: number, operation: string, role: string) => "structure_" + (writer + 1) + "_" + hex(operation) + "_" + role + "_0";
  const place = (base: string, typed: readonly { writer: number; offset: number; letter: string }[]) => {
    let out = "";
    for (let at = 0; at <= base.length; at++) out += typed.filter(item => item.offset === at).sort((a, b) => a.writer - b.writer).map(item => item.letter).join("") + base.charAt(at);
    return out;
  };
  for (let sample = 0; sample < 8; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), creator = random(copies), split = random(2) === 0, base = random(2) ? "R2" : "R1";
    const rival = random(3) === 0 ? (creator + 1) % copies : null, byHeading = random(2) === 0, remover = random(copies), restorer = random(copies), early = random(2) === 0;
    const shown = new Map([[native(creator, "cut", "beat"), "S"], ...handles.map((_, writer) => [native(writer, "head", "heading"), "H" + (writer + 1)] as [string, string])]);
    const show = (id: string) => shown.get(id) ?? id, target = split ? native(creator, "cut", "beat") : base;
    const rows: [string, string][] = !split ? [["R0", "x"], ["R1", "ab"], ["R2", "cd"]]
      : base === "R1" ? [["R0", "x"], ["R1", "a"], ["S", "b"], ["R2", "cd"]] : [["R0", "x"], ["R1", "ab"], ["R2", "c"], ["S", "d"]];
    const index = rows.findIndex(([id]) => id === show(target)), text = rows[index]?.[1] ?? "";
    const typed = handles.flatMap((_, writer) => writer === creator || writer === rival ? [] : [{ writer, letter: "PQR".charAt(writer), offset: random(text.length + 1) }]);
    const creators = [creator, ...rival === null ? [] : [rival]].sort((a, b) => a - b);
    const send = (handle: typeof set.a, ops: unknown[]) => { assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true }); commands += ops.length; };
    const create = (writer: number, name: string) => [{ kind: "heading-create", id: "head", by: "Writer", segment: "Hn", heading: "Hn", firstBeat: target, at: { left: null, right: target, affinity: "before" } },
      { kind: "text-insert", id: "name", by: "Writer", target: { owner: "Hn", segment: "Hn", field: "heading" }, at: { left: null, right: flowBaseReference("Hn", "heading", 0), affinity: "before" },
        content: [{ value: name, marks: [] }] }].map(op => ({ ...op, by: "Writer" + writer }));
    const { projector } = captureIncrementalReplica(set.a);
    const checkpoint = (headingRemoved: boolean, beatRemoved: boolean) => {
      set.queue.flush(order); assertIncremental(set.a, projector); checkpoints++;
      const visible = rows.map(([id, value]) => [id, id === show(target) ? place(value, typed) : value]).filter(([id]) => !beatRemoved || id !== show(target));
      const next = beatRemoved ? rows.slice(index + 1)[0]?.[0] ?? null : show(target), sections: string[][] = [], recovery: string[][] = [];
      const live = creators.filter(writer => !headingRemoved || writer !== creator);
      live.forEach((writer, position) => {
        const name = writer === creator ? "New" : "Two", id = "H" + (writer + 1);
        if (position === live.length - 1 && next !== null) sections.push([id, name, next]); else recovery.push(["scene-with-no-beats", id, name]);
      });
      if (headingRemoved) recovery.push(["removed-heading", "H" + (creator + 1), "New"]);
      if (beatRemoved) recovery.push(["removed-beat", show(target), ""]);
      const expected = { rows: visible, sections, recovery: recovery.map(entry => JSON.stringify(entry)).sort() };
      agree("seed=" + seed, order, handles, handle => {
        const projected = projectSharedDocumentWithRecovery(handle), loaded = runtime.load(projected.document);
        const result = { rows: loaded.rows.map(row => [show(row.id), row.audioText]), sections: ((loaded.sections ?? []) as DocumentScene[]).map(scene => [show(scene.id), scene.name, show(scene.firstSceneId)]),
          recovery: projected.recovery.map(entry => JSON.stringify(entry.kind === "removed-beat" ? [entry.kind, show(String(entry.row.id)), ""] : entry.kind === "removed-heading" || entry.kind === "scene-with-no-beats"
            ? [entry.kind, show(String(entry.heading.id)), entry.heading.name] : [entry.kind])).sort() };
        try { assert.deepEqual(result, expected); } catch (error) { violations.add(String(error)); }
        return result;
      });
    };
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedHeadingHandlers(handle); }
      const author = handles[creator]; assert.ok(author);
      if (split) { send(author, [{ kind: "split", id: "cut", by: "Writer", target: { owner: base, segment: base, field: "audioText" }, at: { left: flowBaseReference(base, "audioText", 0), right: null, affinity: "after" },
        observed: [], boundary: "Sn", beat: "Sn", fields: {} }]); set.queue.flush(order); inline++; }
      for (const item of typed) { const handle = handles[item.writer]; assert.ok(handle); send(handle, [{ kind: "text-insert", id: "typed", by: "Writer", target: { owner: target, segment: target, field: "audioText" },
        at: item.offset ? { left: flowBaseReference(target, "audioText", item.offset - 1), right: null, affinity: "after" } : { left: null, right: flowBaseReference(target, "audioText", 0), affinity: "before" },
        content: [{ value: item.letter, marks: [] }] }]); }
      send(author, create(creator, "New"));
      if (rival !== null) { const handle = handles[rival]; assert.ok(handle); send(handle, create(rival, "Two")); rivals++; }
      checkpoint(false, false);
      const actor = handles[remover], length = place(text, typed).length, removal = native(remover, byHeading ? "unhead" : "gone", "removal"); assert.ok(actor);
      if (byHeading) { const heading = native(creator, "head", "heading"); send(actor, [{ kind: "heading-remove", id: "unhead", by: "Writer", heading, observed: [flowBaseReference(heading, "heading", 0, 3)], newBeat: null, nextBeat: null }]); headingRemovals++; }
      else send(actor, [{ kind: "remove", id: "gone", by: "Writer", removalKind: "beat", targets: [target], observed: [flowBaseReference(target, "audioText", 0, length)], boundaries: [target], components: [], gallery: [], at: index }]);
      const restore = (handle: typeof set.a) => send(handle, [{ kind: "restore", id: "back", by: "Writer", removals: [removal] }]);
      if (early) restore(actor); else { checkpoint(byHeading, !byHeading); const handle = handles[restorer]; assert.ok(handle); restore(handle); }
      checkpoint(false, false); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], headingCreationLimits);
  assert.deepEqual({ histories, checkpoints, commands, inline, rivals, headingRemovals }, { histories: 48, checkpoints: 122, commands: 301, inline: 23, rivals: 14, headingRemovals: 20 });
  t.diagnostic(JSON.stringify({ seed: "0x4d0c", histories, checkpoints, commands, inline, rivals, headingRemovals, declaredLimits: headingCreationLimits }));
});

const headingFinalizationLimits: readonly string[] = [];

test("seeded heading finalizations agree with a literal model through typing in the line, a rival finalization, removals, restores and a late joiner", t => {
  let seed = 0x4d10, histories = 0, checkpoints = 0, commands = 0, inline = 0, rivals = 0, headingRemovals = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; }, violations = new Set<string>();
  const runtime = createFlowLoadRuntime(), hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const native = (writer: number, operation: string, role: string) => "structure_" + (writer + 1) + "_" + hex(operation) + "_" + role + "_0";
  for (let sample = 0; sample < 8; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const tail = random(2) === 0, split = random(3) === 0, line = tail ? "# Ab\ncd" : "# Ab", finalizer = random(copies);
    const set = replicas(copies, { rows: [{ id: "R0", audioText: split ? "x" + line.replace("\n", "<br>") : "x" }, ...split ? [] : [{ id: "R1", audioText: line.replace("\n", "<br>"), paragraphStart: true }],
      { id: "R2", audioText: "ef", paragraphStart: true }] });
    const handles = [set.a, set.b, set.c].slice(0, copies), target = split ? native(finalizer, "cut", "beat") : "R1";
    const rival = !split && !tail && random(3) === 0 ? (finalizer + 1) % copies : null, winner = Math.max(finalizer, rival ?? -1), byHeading = !tail || random(2) === 0;
    const remover = random(copies), restorer = random(copies), early = random(2) === 0, heading = native(winner, "fin_o_0", "heading");
    const typed = handles.flatMap((_, writer) => writer === finalizer || writer === rival ? [] : [{ writer, letter: "PQR".charAt(writer), offset: random(line.length + 1) }]);
    const shown = new Map([[target, "S"], [heading, "H"]]), show = (id: string) => shown.get(id) ?? id;
    const units = Array.from({ length: line.length + 1 }, (_, at) => [...typed.filter(item => item.offset === at).sort((a, b) => a.writer - b.writer).map(item => ({ ch: item.letter, at, typed: true, writer: item.writer })),
      ...at < line.length ? [{ ch: line.charAt(at), at, typed: false, writer: -1 }] : []]).flat();
    const inName = (unit: typeof units[number]) => unit.at < 5 || unit.typed && unit.at === 5 && unit.writer < finalizer;
    const name = units.filter(unit => inName(unit) && (unit.typed || unit.at >= 2 && unit.at < 4)).map(unit => unit.ch).join("");
    const rest = tail ? units.filter(unit => !inName(unit) && (unit.typed || unit.at > 4)).map(unit => unit.ch).join("") : null;
    const send = (handle: typeof set.a, ops: unknown[]) => { assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true }); commands += ops.length; };
    const ref = (from: number, to = from) => flowBaseReference(target, "audioText", from, to);
    const finalize = (writer: number) => [{ kind: "heading-finalize", id: "fin_o_0", by: "Writer" + writer, target: { owner: target, segment: target, field: "audioText" }, heading: "Hn",
      prefix: [ref(0, 2)], name: [ref(2, 4)], separator: tail ? [ref(4, 5)] : [], retainedBeat: tail ? target : "R2", emptyBeat: null,
      tail: tail ? { left: null, right: ref(5), affinity: "before" } : { left: ref(3), right: null, affinity: "after" } },
    ...tail ? [] : [{ kind: "remove", id: "fin_o_1", by: "Writer" + writer, removalKind: "became-heading", targets: [target], observed: [ref(0, 4)], boundaries: [target], components: [], gallery: [], at: 1 }]];
    const { projector } = captureIncrementalReplica(set.a);
    const checkpoint = (headingRemoved: boolean, beatRemoved: boolean) => {
      set.queue.flush(order); assertIncremental(set.a, projector); checkpoints++;
      const rows = [["R0", "x"], ...rest !== null && !beatRemoved ? [[show(target), rest]] : [], ["R2", "ef"]], recovery: string[][] = [];
      if (headingRemoved) recovery.push(["removed-heading", "H", name]);
      if (beatRemoved) recovery.push(["removed-beat", "S", rest ?? ""]);
      const expected = { rows, sections: headingRemoved ? [] : [["H", name, rest !== null && !beatRemoved ? show(target) : "R2"]], recovery: recovery.map(entry => JSON.stringify(entry)) };
      agree("seed=" + seed, order, handles, handle => {
        const projected = projectSharedDocumentWithRecovery(handle), loaded = runtime.load(projected.document);
        const result = { rows: loaded.rows.map(row => [show(row.id), row.audioText]), sections: ((loaded.sections ?? []) as DocumentScene[]).map(scene => [show(scene.id), scene.name, show(scene.firstSceneId)]),
          recovery: projected.recovery.map(entry => JSON.stringify(entry.kind === "removed-beat" ? [entry.kind, show(String(entry.row.id)), entry.row.audioText] : entry.kind === "removed-heading" || entry.kind === "scene-with-no-beats"
            ? [entry.kind, show(String(entry.heading.id)), entry.heading.name] : [entry.kind])) };
        try { assert.deepEqual(result, expected); } catch (error) { violations.add(String(error)); }
        return result;
      });
    };
    try {
      for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedHeadingHandlers(handle); }
      const author = handles[finalizer]; assert.ok(author);
      if (split) { send(author, [{ kind: "split", id: "cut", by: "Writer", target: { owner: "R0", segment: "R0", field: "audioText" }, at: { left: flowBaseReference("R0", "audioText", 0), right: null, affinity: "after" },
        observed: [], boundary: "Sn", beat: "Sn", fields: {} }]); set.queue.flush(order); inline++; }
      for (const item of typed) { const handle = handles[item.writer]; assert.ok(handle); send(handle, [{ kind: "text-insert", id: "typed", by: "Writer", target: { owner: target, segment: target, field: "audioText" },
        at: item.offset ? { left: ref(item.offset - 1), right: null, affinity: "after" } : { left: null, right: ref(0), affinity: "before" }, content: [{ value: item.letter, marks: [] }] }]); }
      send(author, finalize(finalizer));
      if (rival !== null) { const handle = handles[rival]; assert.ok(handle); send(handle, finalize(rival)); rivals++; }
      checkpoint(false, false);
      const actor = handles[remover], removal = native(remover, byHeading ? "unhead" : "gone", "removal"); assert.ok(actor);
      if (byHeading) { send(actor, [{ kind: "heading-remove", id: "unhead", by: "Writer", heading, observed: [flowBaseReference(heading, "heading", 0, name.length)], newBeat: null, nextBeat: null }]); headingRemovals++; }
      else send(actor, [{ kind: "remove", id: "gone", by: "Writer", removalKind: "beat", targets: [target], observed: [], boundaries: [target], components: [], gallery: [], at: 1 }]);
      const restore = (handle: typeof set.a) => send(handle, [{ kind: "restore", id: "back", by: "Writer", removals: [removal] }]);
      if (early) restore(actor); else { checkpoint(byHeading, !byHeading); const handle = handles[restorer]; assert.ok(handle); restore(handle); }
      checkpoint(false, false); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], headingFinalizationLimits);
  assert.deepEqual({ histories, checkpoints, commands, inline, rivals, headingRemovals }, { histories: 48, checkpoints: 122, commands: 263, inline: 15, rivals: 6, headingRemovals: 38 });
  t.diagnostic(JSON.stringify({ seed: "0x4d10", histories, checkpoints, commands, inline, rivals, headingRemovals, declaredLimits: headingFinalizationLimits }));
});
