import { migrateRows } from "../bootstrap/document-ports.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";

export function splitSpaceSwitch() {
  let serial = 0;
  const reports = [];
  const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
  return { reports, ports: {
    refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
    bindings: sharedSplitBindings({ missingBase: () => {}, recovered: () => {}, report: outcome => { reports.push(outcome); } }),
    common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
    docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice",
    structure: { cells: fromHtml }, report: error => { reports.push(error); },
    timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
  } };
}
