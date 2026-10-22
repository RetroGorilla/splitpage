import type { IdSource } from "../../core/document/ports.ts";
import { nextTagStatus } from "../../core/document/tags.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import {
  addPerson,
  addRegistryTag,
  personById,
  personNamed,
  registryEntryOf,
  removePerson,
  removeRegistryTag,
  renameRegistryTag
} from "../../core/production/records.ts";
import type { QuickAddPlan } from "../../core/production/tags.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { applyRewrites, planByTrial, realRewrites, rewriteChanges, withFields } from "./document-edit.ts";
import type { RewritePlanner } from "./document-edit.ts";

export interface TagRef {
  readonly cat: string;
  readonly name: string;
}

export type OwnerChoice = { readonly id: string } | { readonly name: string };

export interface TagChange {
  readonly status?: string | { readonly next: true } | undefined;
  readonly owner?: OwnerChoice | undefined;
  readonly notes?: string | undefined;
}

export interface DeletedTag extends TagRef {
  readonly unlabel: boolean;
}

export const REGISTRY_CHANGE: ChangeSet = changeSet({ docFields: ["productionTags"], saveNow: true });

const PEOPLE_CHANGE: ChangeSet = changeSet({ docFields: ["people", "productionTags", "brollShots"], saveNow: true });

const TAGGED_FIELDS: readonly string[] = Object.freeze(["productionTags", "people"]);

export function chosenOwner(live: DocumentShape, owner: OwnerChoice, ids: IdSource): string {
  if ("name" in owner) return addPerson(live, owner.name, ids);
  return personById(live, owner.id) ? owner.id : "";
}

export function tagCellsCommand(name: string, planner: RewritePlanner, tag: TagRef | null, stamps: StampPorts, registerAlone = false): Command {
  return {
    name: name,
    needs: "edit",
    plan: function (doc): Plan | null {
      const rewrites = realRewrites(doc, planner(doc));
      if (!rewrites.length && !(tag && registerAlone)) return null;
      return planByTrial(name, doc, withFields(rewriteChanges(rewrites, true), tag ? ["productionTags"] : [], true), function (live) {
        const relabelled = applyRewrites(live, rewrites, stamps);
        const registered = !!tag && !!addRegistryTag(live, tag.cat, tag.name);
        return relabelled || registered;
      });
    }
  };
}

export function registerTagCommand(tag: TagRef): Command {
  return {
    name: "register-tag",
    needs: "edit",
    plan: function (doc): Plan | null {
      return planByTrial("register-tag", doc, REGISTRY_CHANGE, function (live) { return !!addRegistryTag(live, tag.cat, tag.name); });
    }
  };
}

export function addPersonCommand(name: string, ids: IdSource): Command {
  return {
    name: "add-person",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (personNamed(doc, name)) return null;
      return planByTrial("add-person", doc, changeSet({ docFields: ["people"], saveNow: true }), function (live) { return !!addPerson(live, name, ids); });
    }
  };
}

export function retagCommand(tag: TagRef, newName: string | null, planner: RewritePlanner, stamps: StampPorts): Command {
  return {
    name: newName === null ? "remove-tag" : "rename-tag",
    needs: "edit",
    plan: function (doc): Plan | null {
      const rewrites = realRewrites(doc, planner(doc));
      const changes = withFields(rewriteChanges(rewrites, true), newName === null ? [] : ["productionTags", "brollShots"], true);
      return planByTrial("retag", doc, changes, function (live) {
        const relabelled = applyRewrites(live, rewrites, stamps);
        const renamed = newName !== null && renameRegistryTag(live, tag.cat, tag.name, newName);
        return relabelled || renamed;
      });
    }
  };
}

export function deleteTagsCommand(tags: readonly DeletedTag[], planner: RewritePlanner, stamps: StampPorts): Command {
  return {
    name: "delete-tags",
    needs: "edit",
    plan: function (doc): Plan | null {
      const rewrites = realRewrites(doc, planner(doc));
      return planByTrial("delete-tags", doc, withFields(rewriteChanges(rewrites, true), ["productionTags"], true), function (live) {
        let changed = applyRewrites(live, rewrites, stamps);
        tags.forEach(function (t) { if (removeRegistryTag(live, t.cat, t.name)) changed = true; });
        return changed;
      });
    }
  };
}

export function gearQuickAddCommand(planner: (doc: DocumentView) => QuickAddPlan): Command {
  return {
    name: "quick-add-gear",
    needs: "edit",
    plan: function (doc): Plan | null {
      const plan = planner(doc);
      if (!plan.added && !plan.removed) return null;
      return {
        changes: REGISTRY_CHANGE,
        apply: function (live) {
          plan.remove.forEach(function (name) { removeRegistryTag(live, "gear", name); });
          plan.register.forEach(function (rec) { live.productionTags.push(Object.assign({}, rec)); });
        }
      };
    }
  };
}

function tagEntry(live: DocumentShape, tag: TagRef): { entry: NonNullable<DocumentShape["productionTags"][number]>; added: boolean } | null {
  const had = registryEntryOf(live, tag.cat, tag.name);
  if (had) return { entry: had, added: false };
  const rec = addRegistryTag(live, tag.cat, tag.name);
  return rec ? { entry: rec, added: true } : null;
}

export function updateTagsCommand(tags: readonly TagRef[], change: TagChange, ids: IdSource): Command {
  return {
    name: "update-tags",
    needs: "edit",
    plan: function (doc): Plan | null {
      return planByTrial("update-tags", doc, changeSet({ docFields: TAGGED_FIELDS, saveNow: true }), function (live) {
        let changed = false;
        const owner = change.owner === undefined ? undefined : chosenOwner(live, change.owner, ids);
        if (change.owner !== undefined && "name" in change.owner && !owner) return false;
        tags.forEach(function (tag) {
          const found = tagEntry(live, tag);
          if (!found) return;
          const entry = found.entry;
          if (found.added) changed = true;
          if (change.status !== undefined) {
            const want = typeof change.status === "string" ? change.status : nextTagStatus(entry.status);
            if (entry.status !== want) { entry.status = want; changed = true; }
          }
          if (owner !== undefined && entry.owner !== owner) { entry.owner = owner; changed = true; }
          if (change.notes !== undefined && entry.notes !== change.notes) { entry.notes = change.notes; changed = true; }
        });
        return changed;
      });
    }
  };
}

export function deletePersonCommand(personId: string): Command {
  return {
    name: "delete-person",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (!personById(doc, personId)) return null;
      return {
        changes: PEOPLE_CHANGE,
        apply: function (live) { removePerson(live, personId); }
      };
    }
  };
}
