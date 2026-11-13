import type { BufferedFieldBinding } from "../../application/editing/buffered-field.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import { alignSpaceForm } from "../../core/collab/buffer.ts";
import { beatPos } from "../../core/flow/flow.ts";
import type { FlowRange } from "../../core/flow/flow.ts";
import { toHtml } from "../../core/text/html.ts";
import { projection } from "../../core/text/runs.ts";
import { domToPos } from "../common/cell-dom.ts";
import { cssAttr } from "../common/dom.ts";
import type { CellBufferPorts } from "./ports.ts";

const NARRATION = '.cell-editable[data-field="audioText"]';
const VISUAL = '.cell-editable[data-field="visualText"]';
const TYPES = ["beforeinput", "input", "compositionstart", "compositionend", "keydown", "cut", "paste", "drop", "focusout"] as const;

export interface CellBuffer {
  readonly binding: BufferedFieldBinding;
  readonly dispose: () => boolean;
}

export function mountCellBuffer(mount: { readonly root: HTMLElement; readonly ports: CellBufferPorts }): CellBuffer {
  const { root, ports } = mount;
  let composing = false, visualComposing: Element | null = null;
  const narration = (rowId: string) => root.querySelector<HTMLElement>(NARRATION + '[data-id="' + cssAttr(rowId) + '"]');
  const shownRow = (rowId: string) => ports.document()?.rows.find(row => row.id === rowId);
  const runs = (cell: Element) => ports.decode(ports.page.html(cell));
  const stored = (row: { readonly audioText?: string | null | undefined }) => row.audioText ?? "";
  const at = (cell: Element, range: CellRange | null): FlowRange | null => {
    const rowId = cell.getAttribute("data-id");
    return rowId && range ? { anchor: beatPos(rowId, range.from), head: beatPos(rowId, range.to) } : null;
  };

  function reset(rowId: string): void {
    const cell = narration(rowId), row = shownRow(rowId);
    if (!cell || !row) return;
    ports.page.write(cell, stored(row));
    ports.notePainted(cell, "audioText", row);
    ports.painted.field(rowId, projection(ports.decode(stored(row))));
  }

  function repaint(rowId: string): void {
    const cell = narration(rowId), row = shownRow(rowId);
    if (cell && row) {
      const html = stored(row), painted = ports.decode(html), text = projection(painted), shown = alignSpaceForm(runs(cell), text);
      if (!shown || toHtml(shown) !== toHtml(painted)) ports.page.write(cell, html);
      ports.notePainted(cell, "audioText", row);
      ports.painted.field(rowId, text);
    }
    ports.repaintRows();
  }

  function record(): void {
    const doc = ports.document();
    if (!doc) { ports.painted.clear(); return; }
    const painted = doc.rows.filter(row => {
      const cell = narration(row.id);
      return cell !== null && ports.paintedFrom(cell, "audioText", row);
    });
    ports.painted.record(painted, row => projection(ports.decode(stored(row))));
  }

  function normalize(): void {
    for (const cell of root.querySelectorAll(VISUAL)) {
      const row = shownRow(cell.getAttribute("data-id") ?? "");
      if (cell === visualComposing || !row || projection(runs(cell)) === projection(ports.decode(row.visualText ?? ""))) continue;
      resetVisual(cell); ports.report({ kind: "rejected", reason: "buffer-visual-column" });
    }
  }

  const binding = ports.field({
    foldSpaceForm: true,
    fields: () => root.querySelectorAll<HTMLElement>(NARRATION),
    field: narration,
    rowId: cell => cell.getAttribute("data-id") ?? "",
    base: rowId => ports.painted.base(rowId),
    painted: rowId => ports.painted.text(rowId),
    normalize,
    reset, runs, repaint,
    selection: () => {
      const active = root.ownerDocument.activeElement;
      return active instanceof HTMLElement && root.contains(active) && active.matches(NARRATION) ? at(active, ports.page.selection(active)) : null;
    },
    composition: value => { if (value !== undefined) composing = value; return composing; },
    restore: (rowId, range) => {
      const cell = narration(rowId);
      if (!cell || range?.anchor.kind !== "beat" || range.head.kind !== "beat") return;
      const from = Math.min(range.anchor.offset, range.head.offset), to = Math.max(range.anchor.offset, range.head.offset);
      ports.page.focus(cell, { from, to });
    },
    changed: () => {}
  });

  function refuse(event: Event, reason: string): void {
    event.preventDefault();
    ports.report({ kind: "rejected", reason });
  }

  function resetVisual(cell: Element): void {
    const row = shownRow(cell.getAttribute("data-id") ?? "");
    if (row) ports.page.write(cell, row.visualText);
  }

  function target(event: InputEvent, cell: Element): FlowRange | null {
    const range = typeof event.getTargetRanges === "function" ? event.getTargetRanges()[0] : undefined;
    if (!range) return null;
    const from = domToPos(cell, range.startContainer, range.startOffset), to = domToPos(cell, range.endContainer, range.endOffset);
    return from === null || to === null ? null : at(cell, { from: Math.min(from, to), to: Math.max(from, to) });
  }

  function step(event: Event, cell: Element | null): void {
    const visual = cell?.matches(VISUAL) === true ? cell : null, text = cell?.matches(NARRATION) === true ? cell : null;
    if (event.type === "keydown") { binding.keydown(event as KeyboardEvent); return; }
    if (event.type === "focusout") { if (!composing) binding.finish(); return; }
    if (event.type === "compositionend") { binding.end(event as CompositionEvent); if (visual) { visualComposing = null; resetVisual(visual); } return; }
    if (visual) {
      if (event.type === "input") return;
      if (visualComposing === visual) event.preventDefault(); else refuse(event, "buffer-visual-column");
      if (event.type === "compositionstart") visualComposing = visual;
      return;
    }
    if (event.type === "input") { if (text) binding.input(); return; }
    if (event.type === "compositionstart") { if (text) binding.start(event, at(text, ports.page.selection(text))); return; }
    if (event.type === "beforeinput" && text) {
      const input = event as InputEvent;
      if (binding.beforeInput(input, at(text, ports.page.selection(text)), target(input, text))) return;
      if (input.inputType.startsWith("delete")) event.preventDefault();
      else refuse(event, "buffer-unsupported-input");
      return;
    }
    if (event.type !== "beforeinput" && !binding.finish()) event.preventDefault();
  }

  function listener(event: Event): void {
    const cell = event.target instanceof Element ? event.target.closest(".cell-editable") : null;
    ports.shown(() => { binding.native(event, () => { step(event, cell && root.contains(cell) ? cell : null); }); });
  }

  for (const type of TYPES) root.addEventListener(type, listener, true);
  const stopPainted = ports.onPainted(record), stopCheck = ports.beforePaint(() => { binding.canPaint(); });
  record();
  return {
    binding,
    dispose: () => {
      if (!ports.shown(() => binding.dispose())) return false;
      stopPainted(); stopCheck();
      for (const type of TYPES) root.removeEventListener(type, listener, true);
      ports.painted.clear();
      return true;
    }
  };
}
