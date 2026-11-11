import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, operation } from "./executor-support.ts";
import { createRecord, setRecord, deleteRecord, recordExamples, recordKey, recordReplicas } from "./record-support.ts";

const kinds = Object.keys(recordExamples) as SharedRecordCollection[];
function fields(kind: SharedRecordCollection, id: string): Record<string, unknown> {
  return { ...recordExamples[kind], ...(kind === "gallery" || kind === "visuals" ? {} : { id }) };
}
function stored(kind: SharedRecordCollection, id: string, extra: Record<string, unknown> = {}): Y.Map<unknown> {
  const value = { ...fields(kind, id), ...extra };
  if (kind === "gallery") value.links = new Y.Map<unknown>();
  if (kind === "shots") value.props = new Y.Map<unknown>();
  return new Y.Map(Object.entries(value));
}

test("raw identity-test records have valid shapes for all seven kinds before a bad identity is introduced", () => {
  const run = recordReplicas();
  try {
    transactSharedDocument(run.a, "remote", () => {
      for (const kind of kinds) collabState(run.a).roots[kind].set(kind === "replies" ? '["C1","control"]' : "control", stored(kind, "control"));
    });
    for (const handle of [run.b, run.c]) assert.ok(applySharedUpdate(handle, encodeSharedState(run.a)).ok);
    for (const kind of kinds) agree(`identity fixture control ${kind}`, "D1", [run.a, run.b, run.c],
      handle => readSharedRecords(handle, kind).filter(record => record.key.includes("control")).map(record => record.key),
      kind === "replies" ? ['["C1","control"]'] : ["control"]);
  } finally { run.close(); }
});

for (const order of deliveryOrders) for (const swapped of [false, true]) test(`unstable record keys and ids are absent with exchanged writers=${swapped} ${order}`, () => {
  const run = recordReplicas();
  try {
    for (const kind of kinds) {
      for (const [index, handle] of [run.a, run.b].entries()) {
        collabState(handle).doc.clientID = (swapped ? 2 - index : index + 1);
        const id = index ? "bad\udc00" : "bad\ud800", key = kind === "replies" ? JSON.stringify(["C1", id]) : id;
        transactSharedDocument(handle, "local-command", () => collabState(handle).roots[kind].set(key, stored(kind, id)));
        assert.deepEqual(readSharedRecords(handle, kind).filter(record => record.key.includes("bad")), []);
      }
    }
    run.queue.flush(order);
    assert.ok(applySharedUpdate(run.c, encodeSharedState(run.a)).ok);
    for (const kind of kinds) agree(`unstable ${kind}`, order, [run.a, run.b, run.c],
      handle => readSharedRecords(handle, kind).filter(record => record.key.includes("bad")), []);
  } finally { run.close(); }
});

test("stored reference and writer identities, nested props and links obey the same absence rule", () => {
  const run = recordReplicas();
  try {
    transactSharedDocument(run.a, "remote", () => {
      let index = 0;
      for (const [kind, field] of [["comments", "rowId"], ["comments", "anchorId"], ["comments", "author"], ["comments", "assignee"],
        ["replies", "author"], ["tags", "owner"], ["shots", "owner"], ["gallery", "beat"], ["visuals", "beat"]] as const) {
        const id = `bad${index++}`, key = kind === "replies" ? JSON.stringify(["C1", id]) : id;
        collabState(run.a).roots[kind].set(key, stored(kind, id, { [field]: "bad\ufffd" }));
      }
      collabState(run.a).roots.comments.set("bad-resolution", stored("comments", "bad-resolution", { resolution: { resolved: true, resolvedBy: "bad\ufffd" } }));
      collabState(run.a).roots.people.set("bad\ufffd", stored("people", "bad\ufffd"));
      const props = new Y.Map<unknown>(), links = new Y.Map<unknown>();
      for (const id of ["bad\ud800", "bad\udc00", "bad\ufffd"]) {
        props.set(id, new Y.Map([["value", { id, name: "prop" }], ["rank", "0"]]));
        links.set(`u:https://${id}.test`, new Y.Map([["href", `https://${id}.test`], ["rank", "0"]]));
      }
      props.set("bad-field", new Y.Map<unknown>([["value", { id: "bad-field", name: "prop" }], ["rank", "0"], ["bad\ud800", true]]));
      links.set("u:https://bad-field.test", new Y.Map<unknown>([["href", "https://bad-field.test"], ["rank", "0"], ["bad\ufffd", true]]));
      collabState(run.a).roots.shots.set("nested", new Y.Map<unknown>([["id", "nested"], ["props", props]]));
      collabState(run.a).roots.gallery.set("nested", new Y.Map<unknown>([["beat", "R1"], ["rank", "0"], ["links", links]]));
    });
    const before = encodeSharedState(run.a);
    for (const handle of [run.b, run.c]) assert.ok(applySharedUpdate(handle, before).ok);
    for (const kind of kinds) agree(`unstable references ${kind}`, "rev", [run.a, run.b, run.c],
      handle => readSharedRecords(handle, kind).filter(record => record.key.includes("bad")), []);
    agree("unstable nested props", "rev", [run.a, run.b, run.c], handle => readSharedRecords(handle, "shots").find(record => record.key === "nested")?.fields.props, []);
    agree("unstable nested links", "rev", [run.a, run.b, run.c], handle => readSharedRecords(handle, "gallery").find(record => record.key === "nested")?.fields.links, []);
    assert.deepEqual(encodeSharedState(run.a), before);
  } finally { run.close(); }
});

test("unstable authoring identities and invalid nested shapes refuse the whole list; replacement characters remain valid body text", () => {
  const run = recordReplicas();
  let refusals = 0;
  try {
    for (const kind of kinds) execute(run.a, createRecord(kind, recordKey(kind), recordExamples[kind], kind === "replies" ? "Bob" : "Alice"));
    const bad: unknown[] = [];
    for (const unstable of ["bad\ud800", "bad\udc00", "bad\ufffd"]) for (const kind of kinds) {
      bad.push(createRecord(kind, unstable, fields(kind, unstable)), setRecord(kind, unstable, "rank", "1"), deleteRecord(kind, unstable));
      const field = kind === "comments" || kind === "replies" ? "author" : kind === "people" ? "id" : kind === "tags" || kind === "shots" ? "owner" : "beat";
      bad.push(createRecord(kind, "fresh", { ...fields(kind, "fresh"), [field]: unstable }));
    }
    bad.push(setRecord("shots", "S2", "props", [{ id: "bad\ufffd", name: "prop" }]),
      setRecord("shots", "S2", "props", [{ id: "", name: "bad\ufffd" }]),
      setRecord("gallery", "G1", "links", [{ href: "https://bad\ufffd.test" }]),
      setRecord("gallery", "G1", "links", [{ name: "bad\ufffd", size: 1 }]),
      setRecord("gallery", "G1", "links", [{ href: "https://example.test", rank: "forbidden" }]),
      setRecord("shots", "S2", "props", [{ id: "prop", name: "Prop", extra: "{}" }]),
      setRecord("gallery", "G1", "links", [{ name: "clip.mp4", size: 7, location: { kind: "path", path: "clip.mp4" } }]),
      setRecord("comments", "C1", "resolution", { resolved: true, resolvedBy: "bad\ufffd" }));
    for (const raw of bad) {
      const before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
      const result = executeSharedOperations(run.a, [operation(setRecord("people", "P1", "name", "staged")), operation(raw)]);
      assert.ok(!result.ok); assert.equal(result.index, 1);
      assert.deepEqual(encodeSharedState(run.a), before); assert.deepEqual(encodeSharedStateVector(run.a), vector); refusals++;
    }
    execute(run.a, setRecord("comments", "C1", "text", "body \ufffd"));
    assert.equal(readSharedRecords(run.a, "comments")[0]?.fields.text, "body \ufffd");
    assert.equal(refusals, 92);
  } finally { run.close(); }
});
