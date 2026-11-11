import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { ScratchReplica } from "./designs.ts";
import { ScratchHistory } from "./driver.ts";
import { interiorLoss, outsideEdge } from "./interior-loss.ts";
import { scratchMark, scratchMarkKinds, makeScratchEvent, scratchEventKey, readScratchEvent, readScratchAnchored } from "./events.ts";
import { assertReplicasAgree } from "../../../collab/agreement.ts";
import { deliveryOrders } from "../../../collab/delivery.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../../src/adapters/collab/document.ts";

for (const kind of scratchMarkKinds) test(`records/${kind}: deleting a newly marked range retains its unseen interior insertion's mark`, () => {
  for (const order of ["D1", "dup", "rev"] as const) {
    const result = interiorLoss("records", kind, order), late = new ScratchReplica("records", 91, undefined, result.state);
    try {
      assertReplicasAgree("unseen insertion inside deleted mark", [{ order: "D1", replica: "A", output: result.expected },
        ...result.actual.map((output, index) => ({ order, replica: index ? "B" as const : "A" as const, output })),
        { order: "late-C", replica: "C", output: late.readNamed(result.book) }]);
    } finally { late.destroy(); }
  }
});

test("records exclude unseen typing just outside the first marked character", () => {
  for (const order of ["D1", "dup", "rev"] as const) {
    const result = outsideEdge("records", order), late = new ScratchReplica("records", 91, undefined, result.state);
    try {
      assertReplicasAgree("outside marked edge", [{ order: "D1", replica: "A", output: result.expected },
        ...result.actual.map((output, index) => ({ order, replica: index ? "B" as const : "A" as const, output })),
        { order: "late-C", replica: "C", output: late.readNamed(result.book) }]);
    } finally { late.destroy(); }
  }
});

for (const writers of [2, 3]) test(`records: ${writers} writers inserting into the same gap keep only their explicit marks`, () => {
  for (const order of deliveryOrders) {
    const history = new ScratchHistory("records", order, writers, "abcd");
    try {
      history.execute(0, { id: "initial", kind: "add", from: 1, to: 3, mark: { kind: "i", value: true } }); history.flush();
      for (let writer = 0; writer < writers; writer++) {
        history.prepare(writer);
        const from = history.model.characters(history.known[writer] ?? new Set()).findIndex(char => char.id === "s2");
        history.execute(writer, { id: "insert" + writer, kind: "insert", from, to: from, text: String.fromCharCode(65 + writer),
          mode: writer === 0 ? "inherit" : writer === 1 ? "plain" : "marked", marks: writer === 2 ? [{ kind: "b", value: true }] : [] }, 1500 + writer / 10);
        if (writer === 1) history.joinEarly();
      }
      history.prepare(0);
      const to = history.model.characters(history.known[0] ?? new Set()).findIndex(char => char.id === "s2") + 1;
      history.execute(0, { id: "remove", kind: "remove", from: 1, to, mark: { kind: "i", value: null } });
      const inserted = [{ id: "insert0:0", value: "A", marks: [] }, { id: "insert1:0", value: "B", marks: [] },
        ...(writers === 3 ? [{ id: "insert2:0", value: "C", marks: [{ kind: "b", value: true }] }] : [])];
      assert.deepEqual(history.finish(), [{ id: "s0", value: "a", marks: [] }, { id: "s1", value: "b", marks: [] }, ...inserted,
        { id: "s2", value: "c", marks: [] }, { id: "s3", value: "d", marks: [] }]);
    } finally { history.destroy(); }
  }
});

test("records monitor rejects a real formatting item instead of merely ignoring it in the reader", () => {
  const replica = new ScratchReplica("records", 1, "abc");
  try {
    assert.equal(replica.formatItems, 0);
    assert.throws(() => transactSharedDocument(replica.handle, "local-command", () => replica.text.format(0, 1, { i: true })), /created a formatting item/);
    assert.equal(replica.formatItems, 2);
  } finally { replica.destroy(); }
});

test("records independently detect the common lost-mark mutation even when all replicas agree", () => {
  const history = new ScratchHistory("records", "D1", 2, "abc");
  try {
    const command = { id: "A1", kind: "add" as const, from: 0, to: 3, mark: { kind: "i" as const, value: true as const } };
    history.model.add(command, new Set());
    history.known.forEach(known => known.add("A1"));
    assert.deepEqual(history.replicas[0]?.readNamed(history.book), history.replicas[1]?.readNamed(history.book));
    assert.throws(() => history.finish(), /independent rule/);
  } finally { history.destroy(); }
});

test("record anchors survive a stable-segment boundary without moving or duplicating a mark record", () => {
  const replica = new ScratchReplica("records", 1, "abcd");
  try {
    replica.execute({ id: "A1", kind: "add", from: 1, to: 3, mark: { kind: "i", value: true } });
    const before = JSON.stringify(replica.events.toJSON());
    transactSharedDocument(replica.handle, "local-command", () => replica.text.insertEmbed(2, { b: "R2" }));
    assert.equal(JSON.stringify(replica.events.toJSON()), before);
    assert.equal(replica.events.size, 1); assert.equal(replica.formatItems, 0);
    const characters = replica.read();
    assert.deepEqual(characters.slice(0, 2).map(char => [char.value, char.marks]), [["a", []], ["b", [{ kind: "i", value: true }]]]);
    assert.deepEqual(characters.slice(3).map(char => [char.value, char.marks]), [["c", [{ kind: "i", value: true }]], ["d", []]]);
    assert.equal(collabState(replica.handle).roots.segments.size, 1);
  } finally { replica.destroy(); }
});

test("record and attribute validators refuse malformed shapes and normalize the key and value together", () => {
  const mark = scratchMark({ kind: "tag", id: "T\ud800", value: "P\ud800" }); assert.ok(mark);
  const event = makeScratchEvent("add", "op\ud800", mark);
  const key = scratchEventKey(event);
  assert.equal(event.operation, "op�"); assert.ok(event.mark && "id" in event.mark); assert.equal(event.mark.id, "T�");
  assert.deepEqual(readScratchEvent(key, event), event);
  assert.equal(readScratchEvent(key.replace("op", "other"), event), null);
  for (const malformed of [null, true, [], {}, { ...event, extra: 1 }, { ...event, observed: new Array(1) }, { ...event, operation: "" },
    { ...event, type: "birth", mark: { nonsense: 1 }, born: { client: 1, clock: 1, length: 1 } }, { ...event, born: { client: 1, clock: -1, length: 1 } }]) {
    assert.equal(readScratchEvent(key, malformed), null);
    assert.equal(readScratchAnchored(key, malformed), null);
  }
  const replica = new ScratchReplica("records", 1, "abc");
  try {
    transactSharedDocument(replica.handle, "local-command", () => replica.events.set(key, { event, start: { invalid: true }, end: { invalid: true } }));
    assert.deepEqual(replica.read().map(char => char.marks), [[], [], []]);
    assert.equal(Y.decodeUpdate(replica.state()).structs.some(item => item instanceof Y.Item && item.content instanceof Y.ContentFormat), false);
    assert.equal(collabState(replica.handle).roots.segments.size, 1);
  } finally { replica.destroy(); }
});
