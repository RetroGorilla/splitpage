import type { SharedOperation } from "../../core/collab/operations.ts";
import { readOperation } from "../../core/collab/read-operation.ts";

export interface SharedOperationListNotes {
  readonly emptyFirstBeats: ReadonlyMap<string, string>;
}
interface ListNoteScratch { readonly scratch: <T>(key: string, create: () => T) => T }

const EMPTY: SharedOperationListNotes = Object.freeze({ emptyFirstBeats: new Map<string, string>() });

export function sharedOperationListNotes(operations: readonly unknown[]): SharedOperationListNotes {
  const read = operations.map(readOperation), emptyFirstBeats = new Map<string, string>();
  read.forEach((operation: SharedOperation | null, index) => {
    if (operation?.kind !== "heading-finalize" || operation.emptyBeat === null || operation.retainedBeat !== operation.emptyBeat) return;
    const beat = operation.emptyBeat;
    if (read.slice(0, index).some(earlier => earlier?.kind === "segment-create" && earlier.beat === beat)) emptyFirstBeats.set(beat, operation.target.owner);
  });
  return Object.freeze({ emptyFirstBeats });
}

export function noteSharedOperationList(view: ListNoteScratch, operations: readonly unknown[]): void {
  view.scratch("operation-list-notes", () => sharedOperationListNotes(operations));
}

export function readSharedOperationListNotes(view: ListNoteScratch): SharedOperationListNotes {
  return view.scratch("operation-list-notes", () => EMPTY);
}
