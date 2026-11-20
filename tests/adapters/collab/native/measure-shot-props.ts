import assert from "node:assert/strict";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { convertedScript, joinedScript } from "./helpers.ts";

const productionTags = Array.from({ length: 11 }, (_, at) => ({ id: `t_p${at}`, cat: "prop", name: `Prop ${at}` }));
const props = productionTags.slice(0, 10).map(({ id, name }) => ({ id, name }));
const brollShots = Array.from({ length: 200 }, (_, at) => ({ id: `bs${at}`, name: `Shot ${at}`, props }));
const document = migrateRows({ title: "Shot props", rows: [], productionTags, brollShots });
const seed = convertedScript(document);
const script = joinedScript(seed, 4);

try {
  const change = (command: NativeRegistryChange) => {
    assert.equal(changeNativeRegistry(script, command).kind, "written");
  };
  const measureWrite = (label: string, command: NativeRegistryChange) => {
    const before = Y.encodeStateAsUpdate(script.doc).length;
    const seen = Y.encodeStateVector(script.doc);
    change(command);
    const after = Y.encodeStateAsUpdate(script.doc).length;
    console.log(`${label}: ${Y.encodeStateAsUpdate(script.doc, seen).length} update bytes, ${after - before} snapshot bytes added`);
  };
  const [first, ...rest] = props;
  assert.ok(first);
  measureWrite("add one known prop to ten", { kind: "addProp", id: "bs0", prop: "Prop 10" });
  measureWrite("move the first of ten props to the end", { kind: "set", collection: "shots", ids: ["bs1"], fields: { props: [...rest, first] } });
  assert.equal(script.reader.document().brollShots[0]?.props?.length, 11);
  assert.equal(script.reader.document().brollShots[1]?.props?.at(-1)?.id, first.id);

  for (const cold of [true, false]) {
    const sample = (at: number) => {
      if (cold) change({ kind: "set", collection: "tags", ids: ["t_p0"], fields: { notes: at % 2 ? "one" : "two" } });
      const start = performance.now(), snapshot = script.reader.document(), elapsed = performance.now() - start;
      assert.equal(snapshot.brollShots.length, 200);
      assert.equal(snapshot.brollShots[199]?.props?.length, 10);
      return elapsed;
    };
    for (let at = 0; at < 100; at++) sample(at);
    const samples = Array.from({ length: 400 }, (_, at) => sample(at)).sort((a, b) => a - b);
    console.log(`document() with ${cold ? "invalidated" : "warm"} registry cache: median ${samples[200]?.toFixed(3)} ms, p95 ${samples[379]?.toFixed(3)} ms`);
  }
} finally {
  script.doc.destroy();
  seed.doc.destroy();
}
