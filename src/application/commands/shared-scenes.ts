import type { Command, CommandOutcome } from "../session/document-session.ts";
import { changeSet } from "../session/change-set.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import { flowBaseReference } from "../../core/collab/base-reference.ts";

export interface SharedSceneCreation {
  readonly create: (firstBeat: string, name: string) => { readonly heading: string | null; readonly outcome: CommandOutcome };
}

export function sharedSceneCommand(firstBeat: string, name: string, author: { readonly id: string; readonly by: string }): Command {
  const beat = firstBeat as SharedContentRef, heading = ("scene_" + author.id) as SharedContentRef;
  return {
    name: "add-section", needs: "edit",
    plan: () => ({
      changes: changeSet({ docFields: ["sections"], derive: CELL_TEXT_DERIVES }),
      apply: () => { throw new Error("Shared scene creation requires a shared session"); },
      shared: { operations: [
        { kind: "heading-create", id: author.id as SharedContentRef, by: author.by, segment: heading, heading, firstBeat: beat, at: { left: null, right: beat, affinity: "before" } },
        { kind: "text-insert", id: (author.id + "_name") as SharedContentRef, by: author.by, target: { owner: heading, segment: heading, field: "heading" },
          at: { left: null, right: flowBaseReference(heading, "heading", 0), affinity: "before" }, content: [{ value: name, marks: [] }] }
      ] }
    })
  };
}
