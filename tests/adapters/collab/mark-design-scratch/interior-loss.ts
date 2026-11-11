import { ScratchHistory } from "./driver.ts";
import { scratchExampleMark } from "./events.ts";
import type { ScratchDesign } from "./designs.ts";
import type { DeliveryOrder } from "../../../collab/delivery.ts";
import type { scratchMarkKinds } from "./events.ts";
import type { ScratchExpectedCharacter } from "./model.ts";

export function interiorLoss(design: ScratchDesign, kind: typeof scratchMarkKinds[number], order: DeliveryOrder) {
  const history = new ScratchHistory(design, order, 2, "abcd"), mark = scratchExampleMark(kind);
  try {
    history.execute(0, { id: "A1", kind: "add", from: 1, to: 3, mark });
    history.execute(0, { id: "A2", kind: "delete", from: 1, to: 3 });
    const deleted = history.replicas[0]?.contributions().map(item => ({ operation: item.event.operation, type: item.event.type }));
    history.execute(1, { id: "B1", kind: "insert", from: 2, to: 2, text: "X", mode: "plain" }, 1500);
    history.flush();
    const first = history.replicas[0]; if (!first) throw new Error("Missing first");
    const expected: ScratchExpectedCharacter[] = [{ id: "s0", value: "a", marks: [] }, { id: "B1:0", value: "X", marks: [mark] }, { id: "s3", value: "d", marks: [] }];
    return { expected, actual: history.replicas.map(replica => replica.readNamed(history.book)), state: first.state(), book: history.book, deleted };
  } finally { history.destroy(); }
}

export function outsideEdge(design: ScratchDesign, order: DeliveryOrder) {
  const history = new ScratchHistory(design, order, 2, "abcd");
  try {
    history.execute(1, { id: "B1", kind: "insert", from: 1, to: 1, text: "X", mode: "plain" }, 500);
    history.execute(0, { id: "A1", kind: "add", from: 1, to: 3, mark: { kind: "b", value: true } });
    history.flush();
    const first = history.replicas[0]; if (!first) throw new Error("Missing first");
    const expected: ScratchExpectedCharacter[] = [{ id: "s0", value: "a", marks: [] }, { id: "B1:0", value: "X", marks: [] },
      { id: "s1", value: "b", marks: [{ kind: "b", value: true }] }, { id: "s2", value: "c", marks: [{ kind: "b", value: true }] }, { id: "s3", value: "d", marks: [] }];
    return { expected, actual: history.replicas.map(replica => replica.readNamed(history.book)), state: first.state(), book: history.book };
  } finally { history.destroy(); }
}
