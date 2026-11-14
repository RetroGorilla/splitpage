import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { createPaintGuard } from "../../../src/application/editing/paint-guard.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { mountCellBuffer } from "../../../src/features/editing/cell-buffer.ts";
import { createCellPage } from "../../../src/features/editing/cell-page.ts";
import { posToDom } from "../../../src/features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../../src/features/common/cell-selection.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { readBufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { registerSplits } from "../../application/session/shared-session-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";

type Field = "visualText" | "audioText";

export function bufferedSplit(seed = [{ id: "R1", text: "the the" }], sourceReady = true,
  options: { readonly author?: (serial: number) => string; readonly structure?: boolean; readonly undo?: (h: Stage1ExecutorHarness) => Pick<SharedUndo, "perform"> } = {}) {
  const h = new Stage1ExecutorHarness(seed), a = sharedHarness(adapterReplica(h.a, options.undo?.(h)));
  if (options.structure) { registerSplits(h.a); registerSharedRemovalHandlers(h.a); }
  const { effects, reports, missing, recovered } = fakeWriterBufferEffects();
  let serial = 0, ready = sourceReady;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"),
    author: () => { const next = ++serial; return { id: options.author?.(next) ?? "split:" + next, by: "Alice" }; } });
  const guard = createPaintGuard(), shown = new Map<string, string>(), listeners = new Set<() => void>(), checks = new Set<() => void>();
  const root = document.body.appendChild(document.createElement("div"));
  const doc = () => a.session.read(view => view) as DocumentView | null;
  const cell = (rowId: string, field: Field = "audioText") => {
    const found = root.querySelector<HTMLElement>('.cell-editable[data-id="' + rowId + '"][data-field="' + field + '"]'); assert.ok(found); return found;
  };
  function paint(): void {
    const view = doc(); assert.ok(view);
    for (const rowEl of root.querySelectorAll<HTMLElement>(".row")) {
      if (view.rows.some(row => row.id === rowEl.dataset.id)) continue;
      rowEl.remove(); shown.delete(rowEl.dataset.id + "/visualText"); shown.delete(rowEl.dataset.id + "/audioText");
    }
    for (const row of view.rows) {
      if (!root.querySelector('.row[data-id="' + row.id + '"]')) {
        root.insertAdjacentHTML("beforeend", '<div class="row" data-id="' + row.id + '"><div class="cell visual-cell"></div><div class="cell audio-cell"></div></div>');
      }
      for (const field of ["visualText", "audioText"] as const) {
        const html = row[field] ?? "", key = row.id + "/" + field;
        if (shown.get(key) === html) continue;
        const fresh = document.createElement("div");
        Object.assign(fresh.dataset, { id: row.id, field });
        fresh.className = "cell-editable"; fresh.contentEditable = "true"; fresh.tabIndex = -1; fresh.innerHTML = html;
        const old = root.querySelector('.cell-editable[data-id="' + row.id + '"][data-field="' + field + '"]');
        if (old) old.replaceWith(fresh);
        else root.querySelector('.row[data-id="' + row.id + '"] .' + (field === "audioText" ? "audio" : "visual") + "-cell")?.append(fresh);
        shown.set(key, html);
      }
    }
    for (const listener of listeners) listener();
  }
  paint();
  const stopPaint = a.session.subscribe(() => { if (guard.shown()) return; for (const check of checks) check(); paint(); });
  const painted = createPaintedBeats({ documentRevision: shared.paintedText.documentRevision,
    read: (rowId, field) => ready ? shared.paintedText.read(rowId, field) : null });
  const buffer = mountCellBuffer({ root, ports: {
    field: surface => createBufferedField(shared.bufferedText, surface), painted, report: effects.report,
    page: createCellPage({ storedHtml: html => html, caretSpot: () => {} }),
    decode: html => fromHtml(html, { media: true }), document: doc,
    paintedFrom: (_cell, field, row) => shown.get(row.id + "/" + field) === (row[field as Field] ?? ""),
    notePainted: (_cell, field, row) => { shown.set(row.id + "/" + field, row[field as Field] ?? ""); },
    shown: edit => guard.whileShown(edit), repaintRows: paint,
    onPainted: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    beforePaint: check => { checks.add(check); return () => { checks.delete(check); }; },
    readable: key => shared.paintedText.read(key, readBufferedFieldKey(key).field) !== null
  } });
  function key(rowId: string, from: number, to: number, inputType: string, data: string | null,
    options: { readonly field?: Field; readonly during?: () => void; readonly shown?: (cell: HTMLElement) => void; readonly input?: false } = {}): boolean {
    const target = cell(rowId, options.field); target.focus();
    const start = posToDom(target, from), end = posToDom(target, to), range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    setCellSelection(target, inputType.startsWith("delete") ? to : from, to);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
    const nativeTarget = range.cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
    if (!target.dispatchEvent(event)) return false;
    options.during?.();
    range.deleteContents();
    if (data) range.insertNode(document.createTextNode(data));
    options.shown?.(target);
    setCellSelection(target, from + (data?.length ?? 0));
    if (options.input !== false) target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data }));
    return true;
  }
  return { h, a, root, buffer, painted, cell, key, paint, reports, missing, recovered,
    ready: () => { ready = true; },
    text: (rowId = "R1") => doc()?.rows.find(row => row.id === rowId)?.audioText,
    caret: (rowId = "R1", field: Field = "audioText") => cellSelection(cell(rowId, field)),
    close: () => { buffer.dispose(); stopPaint(); a.session.dispose(); h.destroy(); root.remove(); } };
}
