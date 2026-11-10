import { wireIdentity } from "./identity.ts";
import type * as Y from "yjs";
import type { SchemaReplica } from "../schema.ts";
import { mapValue } from "../schema.ts";
import { removalIds } from "./removals.ts";

export function removeWithUndo(replica: SchemaReplica, manager: Y.UndoManager, beat: string, id: string, by: string): void {
  beat = wireIdentity(beat); id = wireIdentity(id);
  manager.stopCapturing();
  replica.doc.transact(() => {
    mapValue(mapValue(replica.doc.getMap("beats").get(beat)).get("removals")).clear();
    replica.remove(beat, id, by);
  }, replica.localOrigin);
  const step = manager.undoStack.at(-1);
  if (!step) throw new Error("Removal command was not captured");
  step.meta.set("removal", { beat, id });
  manager.stopCapturing();
}

export function undoRemoval(replica: SchemaReplica, manager: Y.UndoManager): void {
  const command: unknown = manager.undoStack.at(-1)?.meta.get("removal");
  if (!command || typeof command !== "object" || !("beat" in command) || !("id" in command)
    || typeof command.beat !== "string" || typeof command.id !== "string") throw new Error("Top undo item is not a removal");
  const members = mapValue(mapValue(replica.doc.getMap("beats").get(command.beat)).get("removals"));
  const id = command.id;
  if (members.has(id) && removalIds(members).length) {
    // why: Retaining the cancellation also cancels an identical removal delivered after this undo.
    replica.doc.transact(() => members.set(id, false), "semantic-undo");
  }
  manager.undoStack.pop();
}
