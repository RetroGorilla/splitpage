import type { IdSource } from "../../core/document/ports.ts";
import type { DocumentShot } from "../../core/document/validated.ts";
import { addBrollProp, addBrollRecord, brollRecord, removeBrollProp, removeBrollRecord } from "../../core/production/records.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, CommandRefusal, Plan } from "../session/document-session.ts";
import { planByTrial } from "./document-edit.ts";
import { chosenOwner } from "./production-records.ts";
import type { OwnerChoice } from "./production-records.ts";
import { sharedRecordEdit, sharedRecordTrial } from "./shared-records.ts";
import type { SharedRecordPorts } from "./shared-records.ts";

export type ShotFields = Readonly<Record<string, unknown>>;

function shotsChange(): ChangeSet {
  return changeSet({ docFields: ["brollShots"], saveNow: true });
}

function shotOwnerChange(): ChangeSet {
  return changeSet({ docFields: ["brollShots", "people"], saveNow: true });
}

function shotPropsChange(): ChangeSet {
  return changeSet({ docFields: ["brollShots", "productionTags"], derive: ["production"], saveNow: true });
}

function copied<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function addShotCommand(shot: DocumentShot, shared?: SharedRecordPorts): Command {
  return {
    name: "add-broll-shot",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      if (!shot.id || brollRecord(doc, shot.id)) return null;
      const plan: Plan = {
        changes: shotsChange(),
        apply: function (live) { addBrollRecord(live, copied(shot)); }
      };
      const share = sharedRecordTrial(doc, shared);
      if (!share) return plan;
      const out = sharedRecordEdit(doc, share, function (live) { addBrollRecord(live, copied(shot)); return true; });
      return "refused" in out ? out : { ...plan, shared: out };
    }
  };
}

export function setShotsCommand(shotIds: readonly string[], fields: ShotFields, owner?: OwnerChoice, ids?: IdSource, shared?: SharedRecordPorts): Command {
  const changes = owner && "name" in owner ? shotOwnerChange() : shotsChange();
  return {
    name: "set-broll-shots",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
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
      }, sharedRecordTrial(doc, shared));
    }
  };
}

export function deleteShotCommand(shotId: string, shared?: SharedRecordPorts): Command {
  return {
    name: "delete-broll-shot",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      if (!brollRecord(doc, shotId)) return null;
      const plan: Plan = {
        changes: shotsChange(),
        apply: function (live) { removeBrollRecord(live, shotId); }
      };
      const share = sharedRecordTrial(doc, shared);
      if (!share) return plan;
      const out = sharedRecordEdit(doc, share, function (live) { return removeBrollRecord(live, shotId); });
      return "refused" in out ? out : { ...plan, shared: out };
    }
  };
}

export function addShotPropCommand(shotId: string, name: string, shared?: SharedRecordPorts): Command {
  return {
    name: "add-broll-prop",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      return planByTrial("add-broll-prop", doc, shotPropsChange(), function (live) { return addBrollProp(live, shotId, name); }, sharedRecordTrial(doc, shared));
    }
  };
}

export function removeShotPropCommand(shotId: string, ref: string, shared?: SharedRecordPorts): Command {
  return {
    name: "remove-broll-prop",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      return planByTrial("remove-broll-prop", doc, shotsChange(), function (live) { return removeBrollProp(live, shotId, ref); }, sharedRecordTrial(doc, shared));
    }
  };
}
