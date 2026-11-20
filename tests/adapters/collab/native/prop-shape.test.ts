import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { nativeInitialRank } from "../../../../src/adapters/collab/native/convert.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { decodeNativeValue, encodeNativeValue } from "../../../../src/adapters/collab/native/values.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { BROLL_PROPS_MAX } from "../../../../src/core/document/broll.ts";
import type { DocumentShape, DocumentShot } from "../../../../src/core/document/validated.ts";
import { addBrollProp } from "../../../../src/core/production/records.ts";
import { convertedScript, joinedScript } from "./helpers.ts";

type TrialEdit = { readonly kind: "add" | "edit"; readonly id: string; readonly name: string }
  | { readonly kind: "remove" | "move"; readonly id: string };

const edits: readonly TrialEdit[] = [
  { kind: "add", id: "t_rope", name: "Rope" }, { kind: "add", id: "t_case", name: "Case" },
  { kind: "remove", id: "t_seed1" }, { kind: "remove", id: "t_seed2" },
  { kind: "edit", id: "t_seed1", name: "First changed" }, { kind: "edit", id: "t_seed2", name: "Second changed" },
  { kind: "move", id: "t_seed1" }, { kind: "move", id: "t_seed2" }
];

function source(count: number) {
  const props = Array.from({ length: count }, (_, at) => ({ id: "t_seed" + (at + 1), name: "Prop " + (at + 1) }));
  return migrateRows({ title: "Prop pairs", rows: [], comments: [], people: [], brollShots: [{ id: "shot", name: "Wide", origin: "list", props }],
    productionTags: [{ id: "t_rope", cat: "prop", name: "Rope" }, { id: "t_case", cat: "prop", name: "Case" }] });
}

function propsOf(script: NativeScript): Y.Map<Y.Map<unknown>> {
  const props = script.roots.shots.get("shot")?.get("candidate-props");
  assert.ok(props instanceof Y.Map);
  return props as Y.Map<Y.Map<unknown>>;
}

function newProp(props: Y.Map<Y.Map<unknown>>, prop: { id: string }, at: number): void {
  const record = new Y.Map<unknown>();
  props.set(prop.id, record);
  record.set("value", encodeNativeValue(prop));
  record.set("rank", nativeInitialRank(at));
}

// why: keep the rejected layout executable apart from the production reader's whole-array field
function read(script: NativeScript): DocumentShape {
  const document = script.reader.document(), shot = document.brollShots[0];
  assert.ok(shot);
  const props = [...propsOf(script)].sort(([left, a], [right, b]) => {
    const one = String(a.get("rank")), two = String(b.get("rank"));
    return one < two ? -1 : one > two ? 1 : left < right ? -1 : left > right ? 1 : 0;
  }).map(([, prop]) => decodeNativeValue(prop.get("value"))?.value) as NonNullable<DocumentShot["props"]>;
  return { ...document, brollShots: [{ ...shot, props }] };
}

function reload(document: DocumentShape): DocumentShape {
  return migrateRows(JSON.parse(JSON.stringify(document)));
}

function write(script: NativeScript, edit: TrialEdit, at: number): void {
  const props = propsOf(script);
  script.doc.transact(() => {
    if (edit.kind === "remove") { props.delete(edit.id); return; }
    if (edit.kind === "add") {
      const trial = migrateRows(structuredClone(read(script)));
      assert.ok(addBrollProp(trial, "shot", edit.name));
      const prop = trial.brollShots[0]?.props?.at(-1);
      assert.ok(prop && typeof prop.id === "string");
      newProp(props, { ...prop, id: prop.id }, at);
      return;
    }
    const record = props.get(edit.id);
    assert.ok(record);
    if (edit.kind === "edit") record.set("value", encodeNativeValue({ id: edit.id, name: edit.name }));
    else record.set("rank", nativeInitialRank(at));
  });
}

test("candidate prop map keeps independent writes but exceeds the core's limit on concurrent additions", () => {
  const drops: string[] = [];
  let runs = 0;
  for (const count of [3, BROLL_PROPS_MAX - 1]) {
    const document = source(count), seed = convertedScript(document);
    try {
      seed.doc.transact(() => {
        const props = new Y.Map<Y.Map<unknown>>();
        seed.roots.shots.get("shot")?.set("candidate-props", props);
        document.brollShots[0]?.props?.forEach((prop, at) => {
          assert.ok(prop && typeof prop.id === "string");
          newProp(props, { ...prop, id: prop.id }, at);
        });
      });
      assert.deepEqual(read(seed), document);
      const seen = Y.encodeStateVector(seed.doc);
      for (const [at, first] of edits.entries()) for (const second of edits.slice(at)) for (const reverse of [false, true]) {
        const left = joinedScript(seed, 4), right = joinedScript(seed, 9), replay = joinedScript(seed, 10);
        try {
          const later = second.kind === "edit" ? { ...second, name: second.name + " on the right" } : second;
          write(left, first, count);
          write(right, later, count);
          for (const script of [left, right]) assert.deepEqual(reload(read(script)), read(script));
          const one = Y.encodeStateAsUpdate(left.doc, seen), two = Y.encodeStateAsUpdate(right.doc, seen);
          for (const update of reverse ? [two, one] : [one, two]) for (const script of [left, right, replay]) Y.applyUpdate(script.doc, update);
          const end = read(left);
          assert.deepEqual(read(right), end);
          assert.deepEqual(read(replay), end);
          const props = end.brollShots[0]?.props;
          assert.ok(props);
          for (const [id, record] of propsOf(left)) {
            assert.ok(props.some(prop => prop?.id === id));
            assert.deepEqual(props.find(prop => prop?.id === id), decodeNativeValue(record.get("value"))?.value);
          }
          const pending = [first, later], removed = new Set(pending.filter(edit => edit.kind === "remove").map(edit => edit.id));
          for (const id of removed) assert.equal(props.some(prop => prop?.id === id), false);
          for (const edit of pending) {
            if (removed.has(edit.id)) continue;
            if (edit.kind === "add" || edit.kind === "edit") {
              const winner = later.kind === "edit" && later.id === edit.id ? later : edit;
              assert.equal(props.find(prop => prop?.id === edit.id)?.name, winner.name);
            }
            if (edit.kind === "move") assert.equal(propsOf(left).get(edit.id)?.get("rank"), nativeInitialRank(count));
          }
          const reloaded = reload(end);
          if (props.length <= BROLL_PROPS_MAX) assert.deepEqual(reloaded, end);
          else {
            assert.equal(props.length, BROLL_PROPS_MAX + 1);
            assert.equal(props.at(-2)?.id, "t_case");
            assert.equal(props.at(-1)?.id, "t_rope");
            assert.deepEqual(reloaded.brollShots[0]?.props, props.slice(0, BROLL_PROPS_MAX));
            drops.push(`${count} ${first.kind} ${first.id} + ${second.kind} ${second.id}`);
          }
          runs++;
        } finally { for (const script of [left, right, replay]) script.doc.destroy(); }
      }
    } finally { seed.doc.destroy(); }
  }
  assert.equal(runs, 144);
  assert.deepEqual(drops, ["39 add t_rope + add t_case", "39 add t_rope + add t_case"]);
});
