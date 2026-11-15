import { sharedRegistryOperations } from "../../core/collab/record-operations.ts";
import type { SharedRegistryCollection, SharedRegistryLists } from "../../core/collab/record-operations.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import type { Command, CommandOutcome, CommandRefusal, DocumentView, Plan, SharedPlan } from "../session/document-session.ts";
import type { DocumentEdits } from "../session/document-edits.ts";
import type { LiveEdit } from "./document-edit.ts";

export interface SharedRecordPorts {
  readonly author: () => { readonly id: string; readonly by: string } | null;
  readonly ranks: (collection: SharedRegistryCollection) => readonly string[];
  readonly heads: (scope: "tag" | "shot", record: string) => readonly string[];
}

export interface SharedRecordCommands<Ports = SharedRecordPorts> {
  readonly ports: () => Ports | null;
  readonly refused: (outcome: CommandOutcome) => void;
}

export type SharedRecordBuild = (shared?: SharedRecordPorts) => Command;

export interface RecordCommandRun {
  readonly changed: boolean;
  readonly held: boolean;
}

export const NOTHING_RAN: RecordCommandRun = Object.freeze({ changed: false, held: false });

export function recordCommandRun<Ports>(edits: Pick<DocumentEdits, "edit" | "run">, records: SharedRecordCommands<Ports>, build: (shared?: Ports) => Command): RecordCommandRun {
  const shared = records.ports();
  if (!shared) return { changed: edits.edit(build()), held: false };
  const outcome = edits.run(build(shared));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "rejected") return { changed: outcome.kind === "applied" || outcome.kind === "committed", held: false };
  records.refused(outcome);
  return { changed: false, held: true };
}

export function runRecordCommand<Ports>(edits: Pick<DocumentEdits, "edit" | "run">, records: SharedRecordCommands<Ports>, build: (shared?: Ports) => Command): boolean {
  return recordCommandRun(edits, records, build).changed;
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
