import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { createCollabText, collabTextTarget, readSharedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { createMonitoredSharedDocument, readRoots, validatedFixture } from "./helpers.ts";
import { fieldMappingSource } from "./mapping-source.ts";

test("two rich hydrations have equal deterministic record identities and literal per-character marks", () => {
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument(), c = createMonitoredSharedDocument();
  try {
    collabState(a).doc.clientID = 101; collabState(b).doc.clientID = 202;
    for (const handle of [a, b]) hydrateSharedDocument(handle, fieldMappingSource());
    assert.equal(applySharedUpdate(c, encodeSharedState(a)).ok, true);
    assertReplicasAgree("rich independent hydrations", [{ order: "D1", replica: "A", output: readRoots(a) }, { order: "D2", replica: "B", output: readRoots(b) }, { order: "late-C", replica: "C", output: readRoots(c) }]);
    let fields = 0;
    for (const field of ["audioText", "visualText"] as const) {
      const segment = field === "audioText" ? "b:Rprobe" : "Rprobe", target = readSharedTextTarget({ owner: "Rprobe", segment, field }); assert.ok(target);
      const expected = [
        { from: 0, to: 15, marks: [{ kind: "b", value: true }, { kind: "hl", value: true }, { kind: "i", value: true }, { kind: "s", value: true }, { kind: "u", value: true }] },
        { from: 16, to: 29, marks: [{ kind: "link", id: segment + ":" + field + ":1", value: "https://example.test/text-link" }] },
        { from: 30, to: 46, marks: [{ kind: "comment", id: "Cprobe", value: true }] },
        { from: 47, to: 59, marks: [{ kind: "tag", id: segment + ":" + field + ":0000000002", value: "t_probe" }] },
        { from: 60, to: 78, marks: [{ kind: "dir", value: true }] },
        { from: 79, to: 91, marks: [{ kind: "cue", value: true }] }
      ];
      for (const handle of [a, b, c]) {
        const chars = readSharedMarkCharacters(handle, target); assert.ok(chars);
        assert.equal(chars.length, field === "audioText" ? 102 : 106);
        for (const char of chars) {
          const marks = char.marks.flatMap(group => group.values.map(value => group.id === null ? { kind: group.kind, value } : { kind: group.kind, id: group.id, value }));
          assert.deepEqual(marks, expected.find(range => char.offset >= range.from && char.offset < range.to)?.marks ?? []);
          for (const group of char.marks) for (const addition of group.additions) assert.deepEqual(JSON.parse(addition.record), ["hydration", addition.operation]);
        }
      }
      fields++;
    }
    assert.equal(fields, 2);
  } finally { for (const handle of [a, b, c]) destroySharedDocument(handle); }
});

test("every hydrated text target including empty text has its store before sharing", () => {
  const a = createMonitoredSharedDocument(), c = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(a, validatedFixture({ title: "", sections: [{ id: "H1", name: "Heading", firstSceneId: "R1" }], rows: [{ id: "R1", audioText: "", visualText: "" }, { id: "R2", audioText: "a", visualText: "v" }] }));
    assert.equal(applySharedUpdate(c, encodeSharedState(a)).ok, true);
    for (const handle of [a, c]) {
      const { roots } = collabState(handle), targets: unknown[] = [{ owner: "document", segment: "document", field: "title" }];
      for (const [segment, value] of roots.segments) {
        assert.ok(value instanceof Y.Map);
        const head: unknown = value.get("head"); assert.ok(head && typeof head === "object");
        const owner = "h" in head ? head.h : "b" in head ? head.b : null;
        targets.push({ owner, segment, field: "h" in head ? "heading" : "audioText" });
      }
      for (const [segment, value] of roots.visuals) { assert.ok(value instanceof Y.Map); targets.push({ owner: value.get("beat"), segment, field: "visualText" }); }
      assert.equal(targets.length, 6);
      const lengths: number[] = [];
      for (const raw of targets) {
        const target = readSharedTextTarget(raw); assert.ok(target);
        const found = collabTextTarget(handle, target); assert.ok(found);
        assert.ok(found.container.get(found.marksKey) instanceof Y.Map);
        assert.deepEqual(readSharedMarkCharacters(handle, target)?.flatMap(char => char.marks), []);
        lengths.push(found.text.length);
      }
      assert.deepEqual(lengths, [0, 7, 0, 1, 0, 1]);
    }
  } finally { destroySharedDocument(a); destroySharedDocument(c); }
});

test("text creation installs its store in the same transaction and refuses retrofitting a held text", () => {
  const handle = createMonitoredSharedDocument();
  try {
    const { roots } = collabState(handle), origins: unknown[] = [];
    const detach = observeSharedTransactions(handle, origin => origins.push(origin));
    const text = createCollabText(handle, roots.meta, true);
    assert.ok(roots.meta.get("titleMarks") instanceof Y.Map);
    assert.equal(roots.meta.get("title"), text);
    assert.deepEqual(origins, ["local-command"]);
    const before = encodeSharedState(handle);
    assert.throws(() => createCollabText(handle, roots.meta, true), /existing text target/);
    assert.deepEqual(encodeSharedState(handle), before);
    detach();
    const legacy = new Y.Map<unknown>(); roots.segments.set("legacy", legacy); legacy.set("text", new Y.Text("held"));
    const held = encodeSharedState(handle);
    assert.throws(() => createCollabText(handle, legacy), /existing text target/);
    assert.equal(legacy.has("markRecords"), false);
    assert.deepEqual(encodeSharedState(handle), held);
  } finally { destroySharedDocument(handle); }
});
