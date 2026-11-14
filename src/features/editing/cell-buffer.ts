import type { BufferedFieldBinding } from "../../application/editing/buffered-field.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import { alignSpaceForm, bufferedFieldKey, readBufferedFieldKey } from "../../core/collab/buffer.ts";
import { beatPos } from "../../core/flow/flow.ts";
import type { FlowRange } from "../../core/flow/flow.ts";
import { toHtml } from "../../core/text/html.ts";
import { projection } from "../../core/text/runs.ts";
import { domToPos, posToDom, placeSelection, paintTrailingCellSpaces } from "../common/cell-dom.ts";
import { cssAttr } from "../common/dom.ts";
import type { CellBufferPorts } from "./ports.ts";
import type { PaintedText } from "../../application/editing/ports.ts";
import { followPaintedCaret } from "../../application/editing/painted-selection.ts";
import type { CellPoints } from "../../core/text/selection.ts";

const CELLS = '.cell-editable[data-field="audioText"], .cell-editable[data-field="visualText"]';
const TYPES = ["beforeinput", "input", "compositionstart", "compositionend", "keydown", "cut", "paste", "drop", "focusout"] as const;
const FIELDS = ["audioText", "visualText"] as const;

export interface CellBuffer {
  readonly binding: BufferedFieldBinding;
  readonly dispose: () => boolean;
}

interface KeptSplitPoint {
  readonly key: string;
  readonly offset: number;
  readonly base: PaintedText | null;
}

interface KeptSplitSelection {
  readonly anchor: KeptSplitPoint;
  readonly head: KeptSplitPoint;
  readonly affinity: CellPoints["affinity"];
}

export function mountCellBuffer(mount: { readonly root: HTMLElement; readonly ports: CellBufferPorts }): CellBuffer {
  const { root, ports } = mount, caret = ports.caret;
  let composing = false;
  let open = true;
  let kept: KeptSplitSelection | null = null;
  let retained: KeptSplitSelection | null = null;
  let fallback: { readonly key: string; readonly base: PaintedText | null } | null = null;
  let lastSnapshot = caret?.selection.snapshot() ?? null;
  const cellOf = (key: string) => {
    const { rowId, field } = readBufferedFieldKey(key);
    return root.querySelector<HTMLElement>('.cell-editable[data-field="' + field + '"][data-id="' + cssAttr(rowId) + '"]');
  };
  const keyOf = (cell: Element) => bufferedFieldKey(cell.getAttribute("data-id") ?? "", cell.getAttribute("data-field") === "visualText" ? "visualText" : "audioText");
  const shownRow = (rowId: string) => ports.document()?.rows.find(row => row.id === rowId);
  const runs = (cell: Element) => ports.decode(ports.page.html(cell));
  const stored = (row: { readonly audioText?: string | null | undefined; readonly visualText?: string | null | undefined }, field: typeof FIELDS[number]) => row[field] ?? "";
  const at = (key: string, range: CellRange | null): FlowRange | null => range ? { anchor: beatPos(key, range.from), head: beatPos(key, range.to) } : null;

  function shown(key: string) {
    const { rowId, field } = readBufferedFieldKey(key), cell = cellOf(key), row = shownRow(rowId);
    return cell && row ? { cell, row, field, html: stored(row, field) } : null;
  }

  function reset(key: string): void {
    const found = shown(key);
    if (!found) return;
    ports.page.write(found.cell, found.html);
    if (caret) paintTrailingCellSpaces(found.cell, projection(ports.decode(found.html)));
    ports.notePainted(found.cell, found.field, found.row);
    ports.painted.field(key, projection(ports.decode(found.html)));
  }

  function repaint(key: string): void {
    const found = shown(key);
    if (found) {
      const painted = ports.decode(found.html), text = projection(painted), current = alignSpaceForm(runs(found.cell), text);
      if (!current || toHtml(current) !== toHtml(painted)) ports.page.write(found.cell, found.html);
      if (caret) paintTrailingCellSpaces(found.cell, text);
      ports.notePainted(found.cell, found.field, found.row);
      ports.painted.field(key, text);
    }
    ports.repaintRows();
  }

  function record(): void {
    const doc = ports.document();
    if (!doc) { ports.painted.clear(); return; }
    const painted = doc.rows.flatMap(row => FIELDS.flatMap(field => {
      const id = bufferedFieldKey(row.id, field), cell = cellOf(id);
      if (caret && cell) paintTrailingCellSpaces(cell, projection(ports.decode(stored(row, field))));
      return cell !== null && ports.paintedFrom(cell, field, row) ? [{ id, html: stored(row, field) }] : [];
    }));
    ports.painted.record(painted, entry => projection(ports.decode(entry.html)));
  }

  function focused(): HTMLElement | null {
    const active = root.ownerDocument.activeElement;
    return active instanceof HTMLElement && root.contains(active) && active.matches(CELLS) ? active : null;
  }
  function base(key: string): PaintedText | null {
    return ports.painted.base(key) ?? (fallback?.key === key ? fallback.base : null);
  }
  function focus(): void {
    if (!caret) return;
    const cell = focused();
    if (!cell) retained = null;
    fallback = cell ? { key: keyOf(cell), base: ports.painted.base(keyOf(cell)) ?? caret.text(keyOf(cell)) } : null;
  }
  function capture(): KeptSplitSelection | null {
    const selection = root.ownerDocument.getSelection();
    if (!focused() || !selection?.anchorNode || !selection.focusNode) return null;
    const point = (node: Node, offset: number): KeptSplitPoint | null => {
      const cell = (node instanceof Element ? node : node.parentElement)?.closest(CELLS);
      if (!cell || !root.contains(cell)) return null;
      const at = domToPos(cell, node, offset), key = keyOf(cell);
      return at === null ? null : { key, offset: at, base: base(key) };
    };
    const anchor = point(selection.anchorNode, selection.anchorOffset), head = point(selection.focusNode, selection.focusOffset);
    return anchor && head ? { anchor, head, affinity: "backward" } : null;
  }
  function selectionChanged(): void { retained = capture(); }
  function painted(): void {
    if (!caret) return;
    const snapshot = caret.selection.snapshot();
    const snapshotKey = snapshot ? bufferedFieldKey(snapshot.selection.rowId, snapshot.selection.field) : "";
    const previous = kept ?? (snapshot && snapshot !== lastSnapshot ? {
      anchor: { key: snapshotKey, offset: snapshot.selection.anchor, base: base(snapshotKey) },
      head: { key: snapshotKey, offset: snapshot.selection.head, base: base(snapshotKey) }, affinity: snapshot.selection.affinity
    } : retained);
    kept = null; retained = null; lastSnapshot = snapshot;
    record();
    if (!previous || binding.dirty()) { focus(); return; }
    const map = (point: KeptSplitPoint) => {
      const field = readBufferedFieldKey(point.key).field;
      const rows = ports.document()?.rows ?? [], own = rows.find(row => bufferedFieldKey(row.id, field) === point.key);
      const targets = (selected: typeof rows) => selected.flatMap(row => {
        const key = bufferedFieldKey(row.id, field), cell = cellOf(key);
        if (!cell) return [];
        const length = projection(runs(cell)).length;
        if (!own && !length) return [];
        const current = ports.painted.base(key) ?? caret.text(key);
        return [{ key, base: current, length: current?.text.length ?? length }];
      });
      const after = targets(own ? [own] : []), more = () => targets(rows.filter(row => row !== own));
      return followPaintedCaret(point.base, after, point.offset, point.key, more);
    };
    const anchor = map(previous.anchor), head = map(previous.head);
    caret.afterPaint(() => {
      if (!open || !anchor || !head || binding.dirty()) return;
      const cell = cellOf(anchor.key), end = cellOf(head.key), active = root.ownerDocument.activeElement;
      if (!cell || !end || active !== root.ownerDocument.body && !root.contains(active)) return;
      cell.focus({ preventScroll: true });
      const selection = root.ownerDocument.getSelection();
      if (cell === end) placeSelection(cell, selection, { anchor: anchor.offset, head: head.offset, affinity: previous.affinity });
      else {
        const a = posToDom(cell, anchor.offset), h = posToDom(end, head.offset);
        try { selection?.setBaseAndExtent(a.node, a.offset, h.node, h.offset); } catch {}
      }
      focus();
      retained = capture();
    });
  }

  const binding = ports.field({
    foldSpaceForm: true,
    fields: () => root.querySelectorAll<HTMLElement>(CELLS),
    field: cellOf,
    rowId: keyOf,
    base: key => ports.painted.base(key),
    painted: key => ports.painted.text(key),
    normalize: () => {},
    reset, runs, repaint,
    selection: () => {
      const active = root.ownerDocument.activeElement;
      return active instanceof HTMLElement && root.contains(active) && active.matches(CELLS) ? at(keyOf(active), ports.page.selection(active)) : null;
    },
    composition: value => { if (value !== undefined) composing = value; return composing; },
    restore: (key, range) => {
      const cell = cellOf(key);
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

  function target(event: InputEvent, cell: Element): FlowRange | null {
    const range = typeof event.getTargetRanges === "function" ? event.getTargetRanges()[0] : undefined;
    if (!range) return null;
    const from = domToPos(cell, range.startContainer, range.startOffset), to = domToPos(cell, range.endContainer, range.endOffset);
    return from === null || to === null ? null : at(keyOf(cell), { from: Math.min(from, to), to: Math.max(from, to) });
  }

  function step(event: Event, cell: Element | null): void {
    const text = cell?.matches(CELLS) === true ? cell : null;
    if (event.type === "keydown") { binding.keydown(event as KeyboardEvent); return; }
    if (event.type === "focusout") { if (!composing) binding.finish(); return; }
    if (event.type === "compositionend") { binding.end(event as CompositionEvent); return; }
    if (event.type === "input") { if (text) binding.input(); return; }
    if (text && (event.type === "compositionstart" || event.type === "beforeinput") && !ports.painted.base(keyOf(text)) && !ports.readable(keyOf(text))) {
      refuse(event, "buffer-no-visual"); return;
    }
    if (event.type === "compositionstart") { if (text) binding.start(event, at(keyOf(text), ports.page.selection(text))); return; }
    if (event.type === "beforeinput" && text) {
      const input = event as InputEvent;
      if (binding.beforeInput(input, at(keyOf(text), ports.page.selection(text)), target(input, text))) return;
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
  if (caret) { root.addEventListener("focusin", focus); root.ownerDocument.addEventListener("selectionchange", selectionChanged); }
  const stopPainted = ports.onPainted(caret ? painted : record), stopCheck = ports.beforePaint(() => {
    binding.canPaint();
    if (!caret) return;
    kept = capture();
  });
  record();
  focus();
  return {
    binding,
    dispose: () => {
      if (!ports.shown(() => binding.dispose())) return false;
      open = false;
      stopPainted(); stopCheck();
      for (const type of TYPES) root.removeEventListener(type, listener, true);
      root.removeEventListener("focusin", focus);
      root.ownerDocument.removeEventListener("selectionchange", selectionChanged);
      ports.painted.clear();
      return true;
    }
  };
}
