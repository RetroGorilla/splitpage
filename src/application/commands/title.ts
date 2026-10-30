import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";

function titleChange(): ChangeSet {
  return changeSet({ docFields: ["title"] });
}

export function titleCommand(title: string): Command {
  return {
    name: "set-title",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (doc.title === title) return null;
      return {
        changes: titleChange(),
        apply: function (live) { live.title = title; }
      };
    }
  };
}
