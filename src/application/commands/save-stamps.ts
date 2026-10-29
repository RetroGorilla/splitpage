import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Plan, Stamp } from "../session/document-session.ts";

export interface EditStamp {
  readonly rev?: number | undefined;
  readonly lastEditedBy: unknown;
  readonly lastEditedAt: unknown;
}

function editedChange(): ChangeSet {
  return changeSet({ docFields: ["lastEditedBy", "lastEditedAt"] });
}

function savedChange(): ChangeSet {
  return changeSet({ docFields: ["rev", "lastEditedBy", "lastEditedAt"] });
}

function identityChange(): ChangeSet {
  return changeSet({ docFields: ["docId"] });
}

export function editStamp(stamp: EditStamp): Stamp {
  return {
    name: "stamp-edit",
    plan: function (): Plan {
      return {
        changes: stamp.rev === undefined ? editedChange() : savedChange(),
        apply: function (live) {
          if (stamp.rev !== undefined) live.rev = stamp.rev;
          live["lastEditedBy"] = stamp.lastEditedBy;
          live["lastEditedAt"] = stamp.lastEditedAt;
        }
      };
    }
  };
}

export function documentIdStamp(fromId: string | null, toId: string): Stamp {
  return {
    name: "stamp-document-id",
    plan: function (doc): Plan | null {
      if (!toId || doc.docId === toId || (fromId !== null && doc.docId !== fromId)) return null;
      return {
        changes: identityChange(),
        apply: function (live) { live.docId = toId; }
      };
    }
  };
}
