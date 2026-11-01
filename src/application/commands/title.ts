import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";
import type { FileTitleChange } from "../../core/document/file-title.ts";
import { isUntitledTitle } from "../../core/document/file-title.ts";

function titleChange(): ChangeSet {
  return changeSet({ docFields: ["title", "titleOrigin"] });
}

export function fileTitleCommand(naming: FileTitleChange): Command {
  return {
    name: "title-from-file",
    needs: "edit",
    plan: function (doc): Plan | null {
      const before = naming.before;
      if (doc.title !== before.title || doc.titleOrigin !== before.titleOrigin || doc.titleVersion !== before.titleVersion) return null;
      return {
        changes: changeSet({ docFields: ["title", "titleOrigin", "titleVersion"] }),
        apply: function (live) {
          live.title = naming.title;
          live.titleOrigin = naming.titleOrigin;
          if (naming.titleVersion) live.titleVersion = naming.titleVersion;
          else delete live.titleVersion;
        }
      };
    }
  };
}

export function titleCommand(title: string): Command {
  return {
    name: "set-title",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (doc.title === title && (doc.titleOrigin === "user" || (doc.titleOrigin !== "file" && !isUntitledTitle(title)))) return null;
      return {
        changes: titleChange(),
        apply: function (live) { live.title = title; live.titleOrigin = "user"; }
      };
    }
  };
}
