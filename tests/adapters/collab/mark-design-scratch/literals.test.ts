import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../../collab/delivery.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../../src/adapters/collab/anchors.ts";
import { ScratchHistory } from "./driver.ts";
import { scratchExampleMark, scratchMarkKinds } from "./events.ts";
import type { ScratchDesign } from "./designs.ts";

for (const design of ["attributes", "records"] as const) for (const kind of scratchMarkKinds) {
  test(`${design}/${kind}: four commands retain the mark deliberately given to d`, () => {
    const mark = scratchExampleMark(kind);
    for (const order of deliveryOrders) {
      const history = new ScratchHistory(design, order, 2, "abcd");
      try {
        history.execute(0, { id: "A1", kind: "add", from: 1, to: 3, mark });
        history.execute(1, { id: "B1", kind: "add", from: 2, to: 3, mark });
        history.joinEarly(); history.prepare(0);
        history.execute(0, { id: "A2", kind: "add", from: 3, to: 4, mark });
        history.execute(1, { id: "B2", kind: "delete", from: 0, to: 3 });
        assert.deepEqual(history.finish(), [{ id: "s3", value: "d", marks: [mark] }], `${design}/${kind}/${order}`);
      } finally { history.destroy(); }
    }
  });
  test(`${design}/${kind}: three commands leave aXd explicitly plain`, () => plainLiteral(design, kind));
}

function plainLiteral(design: ScratchDesign, kind: typeof scratchMarkKinds[number]): void {
  const mark = scratchExampleMark(kind);
  for (const order of deliveryOrders) {
    const history = new ScratchHistory(design, order, 2, "abcd");
    try {
      history.execute(0, { id: "initial", kind: "add", from: 1, to: 3, mark }); history.flush();
      const b = history.replicas[1]; assert.ok(b);
      const gap = createSharedAnchor(b.handle, "b:R1", 2, "after"); assert.ok(gap);
      history.execute(0, { id: "A1", kind: "delete", from: 2, to: 3 });
      history.execute(0, { id: "A2", kind: "delete", from: 1, to: 2 });
      history.joinEarly();
      const position = resolveSharedAnchor(b.handle, gap); assert.notEqual(position, "gone");
      if (position === "gone") throw new Error("Missing gap");
      history.execute(1, { id: "B1", kind: "insert", from: position.offset, to: position.offset, text: "X", mode: "plain" }, 1500);
      assert.deepEqual(history.finish(), [{ id: "s0", value: "a", marks: [] }, { id: "B1:0", value: "X", marks: [] }, { id: "s3", value: "d", marks: [] }], `${design}/${kind}/${order}`);
    } finally { history.destroy(); }
  }
}
