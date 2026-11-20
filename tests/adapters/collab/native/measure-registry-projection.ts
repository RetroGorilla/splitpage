import assert from "node:assert/strict";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { convertedScript, edit } from "./helpers.ts";

const productionTags = Array.from({ length: 200 }, (_, index) => ({ id: `t_p${index}`, cat: "prop", name: `Prop ${index}` }));
const brollShots = productionTags.map(({ id, name }, index) => ({ id: `bs${index}`, name: `Shot ${index}`, props: [{ id, name }] }));
const rows = Array.from({ length: 900 }, (_, index) => ({ id: `r${index}`, audioText: "Narration for this beat", visualText: "A wide shot" }));
const document = migrateRows({ schema: 2, docId: "d0123456789abcdef0123456789abcdef", title: "Registry", rows, productionTags, brollShots });

for (const removed of [false, true]) {
  const script = convertedScript(document);
  try {
    if (removed) {
      const tag = script.roots.tags.get("t_p199");
      assert.ok(tag);
      tag.set("removed", true);
    }
    const sample = (index: number) => {
      assert.equal(edit(script, { beat: "r0", cell: "narration" }, 0, 1, [{ text: index % 2 ? "N" : "n", marks: {} }]).kind, "written");
      const start = performance.now();
      const snapshot = script.reader.document();
      const elapsed = performance.now() - start;
      assert.equal(snapshot.rows.length, 900);
      return elapsed;
    };
    for (let index = 0; index < 60; index++) sample(index);
    const samples = Array.from({ length: 240 }, (_, index) => sample(index)).sort((a, b) => a - b);
    console.log(`900 beats, 200 tags and 200 shots, ${removed ? "one" : "no"} removal: median ${samples[120]?.toFixed(3)} ms, p95 ${samples[227]?.toFixed(3)} ms`);
  } finally { script.doc.destroy(); }
}
