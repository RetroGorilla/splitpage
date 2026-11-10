import assert from "node:assert/strict";
import { test } from "node:test";
import { rootProbeModes, runRootInitializationProbe } from "./runner.ts";
import * as Y from "yjs";
import { IdentityBook } from "../../src/model.ts";
import { SchemaReplica } from "../../src/schema.ts";

for (const candidate of ["A", "B"] as const) test(`${candidate}: new replicas declare all root types before hydration`, () => {
  const replica = new SchemaReplica(candidate, 3, new IdentityBook());
  try {
    if (candidate === "A") assert.ok(replica.doc.share.get("flow") instanceof Y.Text);
    else {
      assert.ok(replica.doc.share.get("segments") instanceof Y.Map);
      assert.ok(replica.doc.share.get("order") instanceof Y.Array);
    }
    for (const name of ["beats", "visuals", "gallery", "comments", "replies", "people", "tags", "shots", "meta", "removalRecords", "retiredJoins", "statusEvents", "retiredStatus"]) assert.ok(replica.doc.share.get(name) instanceof Y.Map, name);
    assert.deepEqual(Y.encodeStateVector(replica.doc), new Uint8Array([0]));
  } finally { replica.destroy(); }
});

for (const candidate of ["A", "B"] as const) for (const mode of rootProbeModes) {
  test(`${candidate}: root initialization ${mode}`, () => {
    const result = runRootInitializationProbe(candidate, mode);
    const deliberatelyLazy = ["lazy", "gc-off", "late-delete-lazy", "reload-delete-lazy"].includes(mode);
    if (candidate === "A" && deliberatelyLazy) {
      assert.match(result.failure ?? "", /characters\[1\].marks.c:C1: expected <missing>, got true/);
      assert.ok(result.history.includes("before promotion: AbstractType, _hasFormatting=true"));
    } else assert.equal(result.failure, null, result.history.join("\n"));
  });
}
