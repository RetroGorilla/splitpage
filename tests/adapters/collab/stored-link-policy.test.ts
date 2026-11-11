import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { safeHref } from "../../../src/core/document/text-policy.ts";
import { readMarkChange } from "../../../src/core/collab/read-operation.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedStoredMark } from "../../../src/adapters/collab/stored-mark.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord, readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { sharedMarkRecordKey } from "../../../src/adapters/collab/mark-record.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "./helpers.ts";
import { ref } from "./executor-support.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

const target = Object.freeze({ owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const });
const rejected = Object.freeze(["javascript:alert(1)", "", "data:text/plain,x", "relative/path", "ftp://example.test/file", " https://example.test/ "]);
const accepted = Object.freeze(["http://example.test/a", "https://example.test/b?q=1#part", "mailto:person@example.test"]);

for (const payload of [...rejected, ...accepted]) test(`stored link policy: ${JSON.stringify(payload)} is checked on authoring, sync and reload`, () => {
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument(), c = createMonitoredSharedDocument();
  const allowed = accepted.includes(payload);
  try {
    hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] })); assert.ok(applySharedUpdate(b, encodeSharedState(a)).ok);
    const mark = { kind: "link", id: "native", value: payload }, wire = { kind: "mark", id: "op", by: "A", target, observed: [], mark };
    assert.ok(readMarkChange(wire)); assert.equal(safeHref(payload) === payload, allowed);
    const before = encodeSharedState(a), updates: Uint8Array[] = [], stop = deliveryReplica(a).onLocalUpdate(bytes => updates.push(bytes));
    const plan = prepareSharedMarkRecord(a, target, "op", 0, 4, { type: "add", mark });
    if (allowed) {
      assert.deepEqual(readSharedStoredMark(mark), { id: "native", kind: "link", value: payload }); assert.ok(plan);
      assert.deepEqual(writeSharedMarkRecord(a, target, "op", plan), { ok: true });
    } else {
      assert.equal(readSharedStoredMark(mark), null); assert.equal(plan, null);
      const template = prepareSharedMarkRecord(a, target, "op", 0, 4, { type: "add", mark: { ...mark, value: "https://control.test/" } }); assert.ok(template);
      const raw = { ...template, mark };
      assert.deepEqual(writeSharedMarkRecord(a, target, "op", raw), { ok: false, reason: "invalid-record" });
      assert.deepEqual(encodeSharedState(a), before); assert.deepEqual(updates, []);
      const segment = collabState(a).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
      const store: unknown = segment.get("markRecords"); assert.ok(store instanceof Y.Map);
      const key = sharedMarkRecordKey("op", template.writer); assert.ok(key);
      transactSharedDocument(a, "local-command", () => store.set(key, raw));
    }
    stop(); assert.equal(updates.length, 1); assert.ok(updates[0]); assert.ok(applySharedUpdate(b, updates[0]).ok); assert.ok(applySharedUpdate(c, encodeSharedState(a)).ok);
    const expected = ["a", "b", "c", "d"].map(value => ({ value, links: allowed ? [payload] : [] }));
    assertReplicasAgree<unknown>("stored link policy", [{ order: "D1", replica: "A", output: expected }, ...[a, b, c].map((handle, index) => ({
      order: index === 2 ? "late-C" as const : "D1" as const, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const,
      output: readSharedMarkCharacters(handle, target)?.map(char => ({ value: char.value, links: char.marks.filter(group => group.kind === "link").flatMap(group => group.values) })) }))]);
  } finally { for (const handle of [a, b, c]) destroySharedDocument(handle); }
});
