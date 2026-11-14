import { sharedRegistryOperations } from "../../core/collab/record-operations.ts";
import type { SharedRegistryCollection, SharedRegistryLists } from "../../core/collab/record-operations.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import type { CommandRefusal, DocumentView, Plan, SharedPlan } from "../session/document-session.ts";
import type { LiveEdit } from "./document-edit.ts";

export interface SharedRecordPorts {
  author(): { readonly id: string; readonly by: string } | null;
  ranks(collection: SharedRegistryCollection): readonly string[];
  heads(scope: "tag" | "shot", record: string): readonly string[];
}

export type SharedRecordTrial = (trial: DocumentShape | DocumentView) => SharedPlan | CommandRefusal | null;

function lists(doc: DocumentShape | DocumentView): SharedRegistryLists {
  return { people: doc.people ?? [], tags: doc.productionTags, shots: doc.brollShots };
}

function copied<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function diff(doc: DocumentView, shared: SharedRecordPorts, author: { readonly id: string; readonly by: string }, trial: DocumentShape | DocumentView): SharedPlan | CommandRefusal {
  const result = sharedRegistryOperations({ before: lists(doc), after: lists(trial), author,
    ranks: collection => shared.ranks(collection), heads: (scope, record) => shared.heads(scope, record) });
  return "refused" in result ? result : { operations: result.operations };
}

export function sharedRecordTrial(doc: DocumentView, shared: SharedRecordPorts | undefined): SharedRecordTrial | undefined {
  if (!shared) return undefined;
  return function (trial) {
    const author = shared.author();
    return author ? diff(doc, shared, author, trial) : null;
  };
}

export function sharedRecordEdit(doc: DocumentView, shared: SharedRecordPorts | undefined, edit: LiveEdit): SharedPlan | CommandRefusal | null {
  const author = shared ? shared.author() : null;
  if (!shared || !author) return null;
  const copy: Record<string, unknown> = Object.assign({}, doc);
  for (const key of ["people", "productionTags", "brollShots"]) copy[key] = copied(doc[key]);
  edit(copy as DocumentShape);
  return diff(doc, shared, author, copy as DocumentShape);
}

export function withSharedRecords(plan: Plan, shared: SharedPlan | CommandRefusal | null): Plan | CommandRefusal {
  return !shared ? plan : "refused" in shared ? shared : { ...plan, shared };
}
