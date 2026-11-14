import type { Command } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { changeSet } from "../session/change-set.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import type { SharedIdentityGap, SharedSegmentCreate, SharedContentRef } from "../../core/collab/operations.ts";
import { toHtml } from "../../core/text/html.ts";

export interface EmptyScriptCommandPorts extends StampPorts {
  readonly author: Pick<SharedSegmentCreate, "id" | "by">;
  readonly gap: SharedIdentityGap;
  readonly created: SharedContentRef;
}

export function emptyScriptCommand(text: string, ports: EmptyScriptCommandPorts): Command {
  return { name: "empty-script-type", needs: "edit", plan: () => {
    if (!text) return null;
    return {
      changes: changeSet({ rowsInserted: [ports.created], derive: CELL_TEXT_DERIVES }),
      apply: () => { throw new Error("An empty shared script requires a shared session"); },
      shared: { operations: [{ kind: "segment-create", ...ports.author, segment: ports.created, beat: ports.created, at: ports.gap,
        fields: { status: "todo", visualText: "", audioText: toHtml([{ text, marks: {} }]), imageRef: null,
          updatedAt: ports.clock.nowIso(), updatedBy: ports.editor.name() } }] }
    };
  } };
}
