import { sharedBrollCellKeyable, sharedBrollShotRemoved, sharedBrollShotUntouched } from "../../../adapters/collab/broll-keying.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { keySharedLeftCell } from "../../../application/commands/shared-broll-keying.ts";
import type { SharedBrollKeyingPorts } from "../../../application/commands/shared-broll-keying.ts";
import type { BufferedFieldPorts } from "../../../application/editing/buffered-field.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { CommonDocumentSession } from "../../../application/session/document-session.ts";
import { productionReaders } from "../../document-ports.ts";
import { scriptCellOf } from "../../richtext.ts";
import { text } from "./text.ts";
import { timingMarks } from "../../../../shared/timing-marks.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

export function sharedBrollKeyingPorts(handle: SharedDocumentHandle, source: Pick<SharedBrollKeyingPorts, "author" | "cells" | "readers" | "plainTextOf"> & {
  readonly stamps: StampPorts }): SharedBrollKeyingPorts {
  return {
    author: source.author,
    beatStamp: (beat, author) => sharedBeatStamp(beat, author, source.stamps),
    cells: source.cells,
    readers: source.readers,
    plainTextOf: source.plainTextOf,
    keyable: rowId => sharedBrollCellKeyable(handle, rowId),
    shotRemoved: id => sharedBrollShotRemoved(handle, id),
    shotUntouched: id => sharedBrollShotUntouched(handle, id)
  };
}

export function sharedScriptBrollKeyingPorts(parts: { readonly handle: SharedDocumentHandle;
  readonly author: { readonly next: () => { readonly id: string; readonly by: string } | null } }, stamps: StampPorts): SharedBrollKeyingPorts {
  return sharedBrollKeyingPorts(parts.handle, { author: () => parts.author.next(), cells: scriptCellOf, readers: productionReaders,
    plainTextOf: text.htmlToPlainText, stamps });
}

// why: rules 196 to 198 on #1414: the Split and the Writer key a left visual cell through this one leave; a leave
// the binding no longer holds open (session end, teardown) keys nothing, and each refusal gives one notice.
export function sharedLeftCellKeying(session: Pick<CommonDocumentSession, "read" | "run">, keying: SharedBrollKeyingPorts,
  source: { readonly open: () => boolean; readonly notify: BufferedFieldPorts["report"] }): (cell: Element) => void {
  return cell => {
    const rowId = cell.getAttribute("data-id");
    if (!source.open() || !rowId || !cell.isConnected || cell.getAttribute("data-field") !== "visualText") return;
    if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:start");
    try {
      for (const outcome of keySharedLeftCell(session, rowId, keying)) {
        if (outcome.kind === "failed" || outcome.kind === "rejected" || outcome.kind === "committed" && outcome.errors.length) source.notify(outcome);
      }
    } finally { if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:end"); }
  };
}
