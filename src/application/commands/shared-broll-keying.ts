import { sharedBrollKeying, sharedBrollRepeats } from "../../core/collab/broll-keying.ts";
import type { SharedBrollLineKey } from "../../core/collab/broll-keying.ts";
import type { SharedContentRef, SharedOperation } from "../../core/collab/operations.ts";
import type { FieldText, ProductionReaders } from "../../core/production/ports.ts";
import type { CellDecoder } from "../../core/text/ports.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, CommandOutcome, CommonDocumentSession, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export interface SharedBrollKeyingPorts {
  readonly author: () => { readonly id: string; readonly by: string } | null;
  readonly beatStamp: (beat: SharedContentRef, author: { readonly id: string; readonly by: string }) => SharedOperation;
  readonly cells: CellDecoder;
  readonly readers: ProductionReaders;
  readonly plainTextOf: FieldText;
  readonly lineKeys: (rowId: string) => SharedBrollLineKey | null;
}

export const SHARED_BROLL_KEYING_LABEL = "key-broll-lines";

const NO_AUTHOR = Object.freeze({ id: "", by: "" });

function leftCell(doc: DocumentView, rowId: string, ports: SharedBrollKeyingPorts) {
  const row = doc.rows.find(entry => entry.id === rowId), html = row?.visualText;
  return row && typeof html === "string" ? { rowId, cell: ports.cells(html), state: { rows: doc.rows, brollShots: doc.brollShots, productionTags: doc.productionTags } } : null;
}

function planned(rowId: string, operations: readonly SharedOperation[], undo: boolean): Plan {
  return {
    changes: changeSet({ cells: [{ rowId, field: "visualText" }], docFields: undo ? ["brollShots"] : [], derive: CELL_TEXT_DERIVES }),
    apply: () => { throw new Error("Keying a left cell is a shared command only"); },
    shared: undo ? { operations, description: { label: SHARED_BROLL_KEYING_LABEL, selection: null, typing: null } } : { operations, undo: false }
  };
}

function repeatsIn(doc: DocumentView, rowId: string, ports: SharedBrollKeyingPorts, author: { readonly id: string; readonly by: string }): readonly SharedOperation[] | null {
  const left = leftCell(doc, rowId, ports);
  return left ? sharedBrollRepeats(left, doc.brollShots.map(shot => shot.id), author) : null;
}

function keyingIn(doc: DocumentView, rowId: string, ports: SharedBrollKeyingPorts, author: { readonly id: string; readonly by: string }): readonly SharedOperation[] | null {
  const left = leftCell(doc, rowId, ports), lineKey = left ? ports.lineKeys(rowId) : null;
  const keyed = left && lineKey ? sharedBrollKeying(left, ports.readers, ports.plainTextOf, lineKey, author) : null;
  return keyed ? [...keyed.operations, ports.beatStamp(rowId as SharedContentRef, { id: author.id + "_stamp", by: author.by })] : null;
}

export function sharedBrollRepeatCommand(rowId: string, ports: SharedBrollKeyingPorts): Command {
  return { name: "drop-repeated-broll-keys", needs: "edit", plan: doc => {
    const author = ports.author(), operations = author ? repeatsIn(doc, rowId, ports, author) : null;
    return operations ? planned(rowId, operations, false) : null;
  } };
}

export function sharedBrollKeyingCommand(rowId: string, ports: SharedBrollKeyingPorts): Command {
  return { name: SHARED_BROLL_KEYING_LABEL, needs: "edit", plan: doc => {
    const author = ports.author(), operations = author ? keyingIn(doc, rowId, ports, author) : null;
    return operations ? planned(rowId, operations, true) : null;
  } };
}

// why: rule 196 on #1414: leaving a cell first drops keys doubled by copies keying at once, with no undo entry,
// then keys its unkeyed lines in one command of its own; nothing to do runs nothing, so no refusal is shown.
export function keySharedLeftCell(session: Pick<CommonDocumentSession, "read" | "run">, rowId: string, ports: SharedBrollKeyingPorts): readonly CommandOutcome[] {
  const outcomes: CommandOutcome[] = [];
  if (session.read(doc => !!doc && !!repeatsIn(doc, rowId, ports, NO_AUTHOR))) outcomes.push(session.run(sharedBrollRepeatCommand(rowId, ports)));
  if (session.read(doc => !!doc && !!keyingIn(doc, rowId, ports, NO_AUTHOR))) outcomes.push(session.run(sharedBrollKeyingCommand(rowId, ports)));
  return outcomes;
}
