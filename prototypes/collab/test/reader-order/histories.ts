import * as Y from "yjs";
import { addComment, addReply } from "../../src/marks/commands.ts";
import { identityAt } from "../../src/schema.ts";
import { moveBeat } from "../../src/structure.ts";
import type { ReplicaHarness, DeliveryOrder } from "../../src/delivery.ts";
import type { SeedBeat } from "../../src/schema.ts";

export const readerHistoryRows = [
  { id: "removal-attribution", beats: [{ id: "R1", text: "a" }, { id: "R2", text: "q" }], kinds: ["removal-attribution"], desired: { by: "Alice, Bob" }, legacy: ["Alice", "Bob", "Bob"] },
  { id: "visual-component-order", beats: [{ id: "R1", text: "" }], kinds: ["visual-component-order"], desired: { visuals: ["X", "Y"], text: "X<br>Y" }, legacy: ["X<br>Y", "Y<br>X", "Y<br>X"] },
  { id: "reply-collation", beats: [{ id: "R1", text: "" }], kinds: ["reply-collation"], desired: { replies: ["e\u0301", "\u00e9"] }, legacy: [["\u00e9", "e\u0301"], ["e\u0301", "\u00e9"], ["e\u0301", "\u00e9"]] },
  { id: "removal-observed-identities", beats: [{ id: "R1", text: "a" }, { id: "R2", text: "q" }], kinds: ["removal-attribution", "removal-observed-identities"], desired: { edited: ["a1"] }, legacy: [[], ["a1"], ["a1"]] },
  { id: "removal-split-attribution", beats: [{ id: "R1", text: "abcd" }, { id: "R2", text: "e" }], kinds: ["removal-split-attribution"], desired: { splitBy: "Alice" }, legacy: [null, "Alice", "Alice"] },
  { id: "join-target-removed", beats: [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], kinds: ["join-target-removed-or-moved"], desired: { rows: [["R3", "ef"]], recovery: [["R1", "ab cd", "Alice"]] }, legacy: ["Structural join target unavailable", "Structural join target unavailable", "Structural join target unavailable"] },
  { id: "join-target-moved", beats: [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], kinds: ["join-target-removed-or-moved"], desired: { rows: [["R1", "ab cd"], ["R3", "ef"]], recovery: [] }, legacy: ["Structural join target unavailable", "Structural join target unavailable", "Structural join target unavailable"] }
] as const satisfies readonly { id: string; beats: readonly SeedBeat[]; kinds: readonly string[]; desired: unknown; legacy: readonly unknown[] }[];

export function runReaderHistory(id: string, h: ReplicaHarness, order: DeliveryOrder): void {
  const a = h.alice, b = h.bob;
  if (id === "removal-attribution" || id === "removal-observed-identities") {
    if (id === "removal-observed-identities") a.insert("R1", 1, "x", ["a1"]);
    a.remove("R1", "rA", "Alice"); b.remove("R1", "rB", "Bob");
  } else if (id === "visual-component-order") {
    for (const [replica, id, value, notation] of [[a, "cA", "X", "vA"], [b, "cB", "Y", "vB"]] as const) {
      replica.doc.transact(() => {
        const component = new Y.Map<unknown>(), text = new Y.Text(); replica.doc.getMap("visuals").set(id, component);
        component.set("beat", "R1"); component.set("rank", "0"); component.set("text", text); text.insert(0, value);
        h.identities.bind(notation, identityAt(text, 0));
      }, replica.localOrigin);
    }
  } else if (id === "reply-collation") {
    addComment(a, "C1", "R1", 0, 0, "Alice"); h.queue.flush(order);
    addReply(a, "\u00e9", "C1", "Alice", 0); addReply(b, "e\u0301", "C1", "Bob", 0);
  } else if (id === "removal-split-attribution") {
    a.split("R1", 2, "Ra", "boundary-a", "Alice"); b.split("R1", 1, "Rb", "boundary-b", "Bob"); b.remove("Rb", "rB", "Bob");
    h.queue.flush(order); b.remove("Ra", "rC", "Bob");
  } else if (id === "join-target-removed" || id === "join-target-moved") {
    a.join("R2", "R1", "jA");
    if (id === "join-target-removed") a.remove("R1", "rA", "Alice");
    else if (!moveBeat(a, "R1", "R3")) throw new Error("Move fixture was refused");
  } else throw new Error(`Unknown reader history ${id}`);
  h.queue.flush(order); h.lateJoin(a);
}
