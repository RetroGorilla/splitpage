import type { IdSource } from "../../core/document/ports.ts";
import type { DocumentShot } from "../../core/document/validated.ts";
import { addBrollProp, addBrollRecord, brollRecord, removeBrollProp, removeBrollRecord } from "../../core/production/records.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";
import { planByTrial } from "./document-edit.ts";
import { chosenOwner } from "./production-records.ts";
import type { OwnerChoice } from "./production-records.ts";

export type ShotFields = Readonly<Record<string, unknown>>;

const SHOTS_CHANGE: ChangeSet = changeSet({ docFields: ["brollShots"], saveNow: true });

const SHOT_OWNER_CHANGE: ChangeSet = changeSet({ docFields: ["brollShots", "people"], saveNow: true });

const SHOT_PROPS_CHANGE: ChangeSet = changeSet({ docFields: ["brollShots", "productionTags"], derive: ["production"], saveNow: true });

function copied<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function addShotCommand(shot: DocumentShot): Command {
  return {
    name: "add-broll-shot",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (!shot.id || brollRecord(doc, shot.id)) return null;
      return {
        changes: SHOTS_CHANGE,
        apply: function (live) { addBrollRecord(live, copied(shot)); }
      };
    }
  };
}

export function setShotsCommand(shotIds: readonly string[], fields: ShotFields, owner?: OwnerChoice, ids?: IdSource): Command {
  const changes = owner && "name" in owner ? SHOT_OWNER_CHANGE : SHOTS_CHANGE;
  return {
    name: "set-broll-shots",
    needs: "edit",
    plan: function (doc): Plan | null {
      return planByTrial("set-broll-shots", doc, changes, function (live) {
        let want: string | null = null;
        if (owner) {
          if ("name" in owner && !ids) throw new Error("a new owner needs an id source");
          want = chosenOwner(live, owner, ids as IdSource);
          if ("name" in owner && !want) return false;
        }
        let changed = false;
        shotIds.forEach(function (id) {
          const shot = brollRecord(live, id);
          if (!shot) return;
          Object.keys(fields).forEach(function (key) {
            const value = fields[key];
            if (shot[key] === value) return;
            shot[key] = copied(value);
            changed = true;
          });
          if (want !== null && (shot.owner || "") !== want) { shot.owner = want; changed = true; }
        });
        return changed;
      });
    }
  };
}

export function deleteShotCommand(shotId: string): Command {
  return {
    name: "delete-broll-shot",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (!brollRecord(doc, shotId)) return null;
      return {
        changes: SHOTS_CHANGE,
        apply: function (live) { removeBrollRecord(live, shotId); }
      };
    }
  };
}

export function addShotPropCommand(shotId: string, name: string): Command {
  return {
    name: "add-broll-prop",
    needs: "edit",
    plan: function (doc): Plan | null {
      return planByTrial("add-broll-prop", doc, SHOT_PROPS_CHANGE, function (live) { return addBrollProp(live, shotId, name); });
    }
  };
}

export function removeShotPropCommand(shotId: string, ref: string): Command {
  return {
    name: "remove-broll-prop",
    needs: "edit",
    plan: function (doc): Plan | null {
      return planByTrial("remove-broll-prop", doc, SHOTS_CHANGE, function (live) { return removeBrollProp(live, shotId, ref); });
    }
  };
}
