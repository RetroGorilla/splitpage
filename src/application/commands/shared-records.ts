import { sharedRegistryOperations } from "../../core/collab/record-operations.ts";
import type { SharedRegistryCollection, SharedRegistryLists } from "../../core/collab/record-operations.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import type { CommandRefusal, DocumentView, SharedPlan } from "../session/document-session.ts";
import type { LiveEdit } from "./document-edit.ts";

export interface SharedRecordPorts {
  author(): { readonly id: string; readonly by: string } | null;
  ranks(collection: SharedRegistryCollection): readonly string[];
  heads(scope: "tag" | "shot", record: string): readonly string[];
}

export type SharedRecordTrial = (trial: DocumentShape | DocumentView) => SharedPlan | CommandRefusal;

function lists(doc: DocumentShape | DocumentView): SharedRegistryLists {
  return { people: doc.people ?? [], tags: doc.productionTags, shots: doc.brollShots };
}

function copied<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function sharedRecordTrial(doc: DocumentView, shared: SharedRecordPorts | undefined): SharedRecordTrial | undefined {
  const author = shared ? shared.author() : null;
  if (!shared || !author) return undefined;
  return function (trial) {
    const result = sharedRegistryOperations({ before: lists(doc), after: lists(trial), author,
      ranks: collection => shared.ranks(collection), heads: (scope, record) => shared.heads(scope, record) });
    return "refused" in result ? result : { operations: result.operations };
  };
}

export function sharedRecordEdit(doc: DocumentView, share: SharedRecordTrial, edit: LiveEdit): SharedPlan | CommandRefusal {
  const copy: Record<string, unknown> = Object.assign({}, doc);
  for (const key of ["people", "productionTags", "brollShots"]) copy[key] = copied(doc[key]);
  edit(copy as DocumentShape);
  return share(copy as DocumentShape);
}
