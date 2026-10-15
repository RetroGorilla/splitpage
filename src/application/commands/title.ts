import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";

export const TITLE_CHANGE: ChangeSet = changeSet({ docFields: ["title"] });

export function titleCommand(title: string): Command {
  return {
    name: "set-title",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (doc.title === title) return null;
      return {
        changes: TITLE_CHANGE,
        apply: function (live) { live.title = title; }
      };
    }
  };
}
