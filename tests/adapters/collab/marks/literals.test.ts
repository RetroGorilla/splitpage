import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../../collab/delivery.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../../src/adapters/collab/anchors.ts";
import { MarkTraceHistory } from "./driver.ts";
import { markTraceExample, markTraceKinds } from "./replica.ts";

for (const kind of markTraceKinds) for (const trace of ["four-command marked d", "three-command plain aXd", "interior deletion retains unseen mark"] as const) test(`${kind}: ${trace}`, () => {
  const mark = markTraceExample(kind);
  for (const order of deliveryOrders) {
    const history = new MarkTraceHistory(order, 2, "abcd");
    try {
      if (trace === "four-command marked d") {
        history.execute(0, { id: "A1", kind: "add", from: 1, to: 3, mark });
        history.execute(1, { id: "B1", kind: "add", from: 2, to: 3, mark });
        history.joinEarly(); history.prepare(0);
        history.execute(0, { id: "A2", kind: "add", from: 3, to: 4, mark });
        history.execute(1, { id: "B2", kind: "delete", from: 0, to: 3 });
        assert.deepEqual(history.finish(), [{ id: "s3", value: "d", marks: [mark] }]);
      } else {
        history.execute(0, { id: "A1", kind: "add", from: 1, to: 3, mark });
        if (trace === "three-command plain aXd") history.flush();
        const b = history.replicas[1]; assert.ok(b);
        const gap = createSharedAnchor(b.handle, "b:R1", 2, "after"); assert.ok(gap);
        if (trace === "three-command plain aXd") {
          history.execute(0, { id: "A2", kind: "delete", from: 2, to: 3 });
          history.execute(0, { id: "A3", kind: "delete", from: 1, to: 2 });
        } else history.execute(0, { id: "A2", kind: "delete", from: 1, to: 3 });
        history.joinEarly();
        const position = resolveSharedAnchor(b.handle, gap); assert.notEqual(position, "gone");
        if (position === "gone") throw new Error("Missing gap");
        history.execute(1, { id: "B1", kind: "insert", from: position.offset, to: position.offset, text: "X", mode: "plain" }, 1500);
        history.prepare(0);
        const marks = trace === "three-command plain aXd" || order === "D2" || order === "late-C" ? [] : [mark];
        assert.deepEqual(history.finish(), [{ id: "s0", value: "a", marks: [] }, { id: "B1:0", value: "X", marks }, { id: "s3", value: "d", marks: [] }]);
      }
    } finally { history.destroy(); }
  }
});

test("outside-edge two-command literal excludes unseen typing before the first marked character", () => {
  for (const order of deliveryOrders) {
    const history = new MarkTraceHistory(order, 2, "abcd");
    try {
      history.execute(1, { id: "B1", kind: "insert", from: 1, to: 1, text: "X", mode: "plain" }, 500);
      history.joinEarly(); history.prepare(0);
      const chars = history.model.characters(history.known[0] ?? new Set()), from = chars.findIndex(char => char.id === "s1"), to = chars.findIndex(char => char.id === "s2") + 1;
      history.execute(0, { id: "A1", kind: "add", from, to, mark: { kind: "b", value: true } });
      assert.deepEqual(history.finish(), [{ id: "s0", value: "a", marks: [] }, { id: "B1:0", value: "X", marks: [] },
        { id: "s1", value: "b", marks: [{ kind: "b", value: true }] }, { id: "s2", value: "c", marks: [{ kind: "b", value: true }] }, { id: "s3", value: "d", marks: [] }]);
    } finally { history.destroy(); }
  }
});
