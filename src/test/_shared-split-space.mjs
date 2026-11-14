import { migrateRows, productionReaders } from "../bootstrap/document-ports.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { sessionStamps } from "../bootstrap/wiring/session-owner.ts";
import { sharedBufferPorts } from "../bootstrap/wiring/ports/shared-buffer.ts";
import { mountSharedSplitBuffer } from "../bootstrap/wiring/split-buffer.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { renderUndo } from "../bootstrap/wiring/ports/editing.ts";
import { mountFocusFeature, stopFocusFeature, mountRowsEditingFeature, stopRowsEditingFeature, mountCompositionFeature, stopCompositionFeature } from "../bootstrap/wiring/editor.ts";

export function splitSpaceSwitch() {
  let buffer = null, serial = 0;
  const track = renderUndo.track;
  const reports = [];
  const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
  return { reports, ports: {
    refusal: () => null, settle: () => { undoOwner().flush(); }, detach: () => {},
    bindings: {
      enter: parts => {
        if (buffer) return;
        // why: until C7 connects these callers, the shared binding needs standalone input and undo paths detached
        renderUndo.track = () => {};
        stopFocusFeature(); stopRowsEditingFeature(); stopCompositionFeature();
        const shared = sharedBufferPorts(parts.handle, parts.session, {
          author: () => parts.author.next(), readers: productionReaders, stamps: sessionStamps,
          missingBase: () => {}, recovered: () => {}, report: outcome => { reports.push(outcome); }
        });
        buffer = mountSharedSplitBuffer(shared);
      },
      settle: () => buffer?.binding.finish() === false ? "buffer-pending" : null,
      leave: () => {
        if (buffer && !buffer.dispose()) throw new Error("Split buffer is still held");
        buffer = null;
        renderUndo.track = track;
        mountFocusFeature(); mountRowsEditingFeature(); mountCompositionFeature();
      }
    },
    common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
    docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice",
    structure: { cells: fromHtml }, report: error => { reports.push(error); },
    timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
  } };
}
