import { beatPos, caretAt, isCollapsed, withinOneBeat } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowRange, FlowRow } from "../../core/flow/flow.ts";
import { hasSetLength } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { posToDom } from "../common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { ensureTrailingCaretSpot } from "../common/dom.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";

export interface FlowVisualBoxPorts {
  readonly buffer?: FlowVisualBufferMount;
  readonly opened?: (cell: HTMLElement, range: FlowRange, first: boolean) => void;
  readonly closing?: () => boolean;
  readonly closed?: (cell: HTMLElement) => void;
  readonly repaint?: (paint: () => void) => void;
  readonly root: HTMLElement;
  readonly doc: () => FlowDoc;
  readonly selection: () => FlowRange | null;
  readonly prepare: (range: FlowRange) => FlowRange | null;
  readonly place: (range: FlowRange) => void;
  readonly current: () => boolean;
  readonly blocked: () => boolean;
  readonly plainVisual: (row: FlowRow) => string;
  readonly thumbnails: (row: FlowRow) => string;
  readonly save: (range: FlowRange, html: string, first: boolean) => FlowRange | null;
  readonly input: (event: InputEvent, cell: HTMLElement) => void;
  readonly beforeWrite?: (cell: Element) => ((selection?: CellRange | null) => void) | null;
  readonly leave: (cell: HTMLElement) => void;
  readonly keydown: (event: KeyboardEvent, cell: HTMLElement) => boolean;
  readonly notice: (text: string) => void;
  readonly undo: (dir: "undo" | "redo") => void;
  readonly paste: (cell: HTMLElement, data: Pick<DataTransfer, "getData">) => void;
}

export interface FlowVisualBufferControl {
  readonly painted: () => void;
  readonly refresh: (paint: () => void) => void;
  readonly finish: () => boolean;
  readonly selectionStart: (range: FlowRange) => boolean;
  readonly selectionEnd: () => void;
  readonly dispose: () => boolean;
}

export type FlowVisualBufferMount = (root: HTMLElement, repaint: () => void) => FlowVisualBufferControl;

export function createFlowVisualBox(ports: FlowVisualBoxPorts) {
  return ports.buffer ? bufferedVisualBox(ports, ports.buffer) : standaloneVisualBox(ports);
}

function bufferedVisualBox(ports: FlowVisualBoxPorts, mount: FlowVisualBufferMount): ReturnType<typeof standaloneVisualBox> {
  let binding: FlowVisualBufferControl | null = null, selection: FlowRange | null = null, composing = false;
  const control = standaloneVisualBox({ ...ports,
    input: () => {}, leave: () => {}, keydown: () => false, beforeWrite: () => null,
    opened: (cell, range, first) => { selection = first ? range : null; cell.dataset.field = first ? "selection-visual" : "visualText"; binding?.painted(); },
    closing: () => { if (binding && !binding.finish()) return false; binding?.selectionEnd(); return true; },
    closed: target => { target.dataset.field = "inactive-visual"; selection = null; binding?.painted(); },
    repaint: paint => { if (binding) binding.refresh(paint); else paint(); },
    save: (range, html, first) => {
      if (!first) return range;
      try {
        const next = ports.save(range, html, first);
        if (next?.head.kind === "beat") { cell.dataset.id = next.head.rowId; cell.dataset.field = "visualText"; selection = null; }
        return next;
      } finally { binding?.selectionEnd(); binding?.painted(); }
    },
    paste: (target, data) => {
      const range = target.ownerDocument.getSelection()?.rangeCount ? target.ownerDocument.getSelection()?.getRangeAt(0).cloneRange() : null;
      const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: data.getData("text/plain") });
      Object.defineProperty(event, "getTargetRanges", { value: () => range ? [range] : [] });
      if (!target.dispatchEvent(event)) return;
      ports.paste(target, data);
      target.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: data.getData("text/plain") }));
    }
  });
  const box = control.element, cell = box.querySelector<HTMLElement>(".wr-flow-visual-text") as HTMLElement;
  cell.dataset.field = "inactive-visual";
  const gate = (event: Event): void => {
    if (!ports.current() || ports.blocked() && ["beforeinput", "input", "compositionstart", "compositionend"].includes(event.type)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "input") { cell.innerHTML = selection ? "" : ports.doc().rows.find(row => row.id === cell.dataset.id)?.visualText ?? ""; binding?.painted(); }
      return;
    }
    if (event.type === "compositionstart") composing = true;
    if (event.type === "compositionend") composing = false;
    if (selection && (event.type === "beforeinput" || event.type === "compositionstart") && !binding?.selectionStart(selection)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const types = ["beforeinput", "input", "compositionstart", "compositionend", "keydown", "cut", "paste", "drop"];
  for (const type of types) box.addEventListener(type, gate, true);
  binding = mount(box, control.refresh);
  const stopped = (event: Event): void => { if (event.defaultPrevented) event.stopImmediatePropagation(); };
  for (const type of types) box.addEventListener(type, stopped, true);
  const released = (): void => { if (!composing && selection) binding?.selectionEnd(); };
  box.addEventListener("keyup", released);
  return { ...control, dispose: () => {
    if (!binding?.dispose()) return;
    for (const type of types) { box.removeEventListener(type, gate, true); box.removeEventListener(type, stopped, true); }
    box.removeEventListener("keyup", released); binding = null; control.dispose();
  } };
}

function standaloneVisualBox(ports: FlowVisualBoxPorts) {
  const root = ports.root;
  const doc = root.ownerDocument;
  const parent = root.parentElement;
  const note = doc.createElement("button");
  note.type = "button";
  note.className = "wr-visual-note";
  note.hidden = true;
  note.title = "Edit visual";
  const noteText = doc.createTextNode("");
  note.append(noteText);
  const box = doc.createElement("div");
  box.className = "wr-flow-visual-box";
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Visual");
  box.innerHTML = '<div class="wr-flow-visual-heading"><strong>Visual</strong><div class="mini-toolbar"><button type="button" class="tb-tag wr-flow-visual-tag">Tag</button></div><button type="button" class="wr-flow-visual-close" aria-label="Close visual">Close</button></div>' +
    '<div class="wr-flow-visual-text cell-editable" contenteditable="true" role="textbox" aria-label="Visual text" aria-multiline="true" spellcheck="true" data-field="visualText" data-undo-owner="document"></div>' +
    '<div class="wr-flow-visual-pictures"></div><div class="wr-flow-visual-hint">Add pictures in the split view.</div>';
  const cell = box.querySelector<HTMLElement>(".wr-flow-visual-text") as HTMLElement;
  const pictures = box.querySelector<HTMLElement>(".wr-flow-visual-pictures") as HTMLElement;
  const closeButton = box.querySelector<HTMLButtonElement>(".wr-flow-visual-close") as HTMLButtonElement;
  const toolbar = doc.querySelector(".writer-bar");
  const button = doc.createElement("button");
  button.type = "button";
  button.id = "wr-visual";
  button.textContent = "Visual";
  button.title = "Edit this beat's visual";
  toolbar?.append(button);
  parent?.append(note, box);
  let target: FlowRange | null = null;
  let first = false;
  let composing = false;
  let dirty = false;
  let noteRow: string | null = null;
  let shownHtml = "";
  let saving = false;

  function rowOf(id: string): FlowRow | undefined { return ports.doc().rows.find(row => row.id === id); }

  function save(): void {
    if (!target || !dirty || !ports.current() || composing || ports.blocked()) return;
    dirty = false;
    let next: FlowRange | null;
    saving = true;
    try { next = ports.save(target, cell.innerHTML, first); }
    finally { saving = false; }
    if (!next || next.head.kind !== "beat") return;
    target = next;
    first = false;
    cell.dataset.id = next.head.rowId;
    shownHtml = rowOf(next.head.rowId)?.visualText ?? "";
  }

  function rejected(): boolean {
    if (!ports.blocked()) return false;
    dirty = false;
    cell.innerHTML = first ? "" : shownHtml;
    const at = posToDom(cell, Number.MAX_SAFE_INTEGER);
    window.getSelection()?.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
    return true;
  }

  function close(restore = true): void {
    if (box.hidden) return;
    if (ports.closing && !ports.closing()) return;
    composing = false;
    save();
    if (!first && ports.current() && !ports.blocked()) ports.leave(cell);
    const range = target;
    target = null;
    box.hidden = true;
    ports.closed?.(cell);
    if (restore && range && ports.current()) ports.place(range);
  }

  function position(): void {
    if (!target || target.head.kind !== "beat") return;
    const beat = root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(target.head.rowId) + '"]');
    const rect = beat?.getClientRects()[0];
    if (!rect) return;
    const width = Math.min(360, window.innerWidth - 24);
    box.style.width = width + "px";
    box.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px";
    const height = box.getBoundingClientRect().height;
    box.style.top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12)) + "px";
  }

  function open(range: FlowRange | null, highlight?: { from: number; to: number }): void {
    close(false);
    if (!ports.current() || !range) return;
    if (!withinOneBeat(range)) { ports.notice("Visuals must stay within one beat."); return; }
    if (range.head.kind !== "beat") { ports.notice("Put the caret in a beat to edit its visual."); return; }
    range = ports.prepare(range);
    if (!range || range.head.kind !== "beat") { ports.notice("Put the caret in a beat to edit its visual."); return; }
    const row = rowOf(range.head.rowId);
    if (!row) return;
    target = range;
    first = !isCollapsed(range);
    dirty = false;
    cell.dataset.id = row.id;
    cell.innerHTML = first ? "" : row.visualText ?? "";
    shownHtml = row.visualText ?? "";
    pictures.innerHTML = first ? "" : ports.thumbnails(row);
    box.hidden = false;
    ports.opened?.(cell, range, first);
    position();
    cell.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (highlight) {
      const points: { node: Node; offset: number }[] = [];
      function walk(parent: Node): void {
        Array.from(parent.childNodes).forEach((node, index) => {
          if (node.nodeType === 3) {
            const text = node as Text;
            for (let offset = 0; offset < text.length; offset++) {
              if (text.data[offset] !== "\u200b") points.push({ node: text, offset });
            }
          } else if (node instanceof HTMLElement && node.tagName === "BR") points.push({ node: parent, offset: index });
          else if (node instanceof HTMLElement && !node.matches("img, .video-embed-card")) walk(node);
        });
      }
      walk(cell);
      const point = (offset: number) => points[Math.max(0, offset)] ?? { node: cell, offset: cell.childNodes.length };
      const a = point(highlight.from), h = point(highlight.to);
      selection?.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    } else {
      const at = posToDom(cell, Number.MAX_SAFE_INTEGER);
      selection?.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
    }
  }

  function refreshUnbuffered(): void {
    if (!ports.current()) { close(false); note.hidden = true; return; }
    if (target?.head.kind === "beat" && !rowOf(target.head.rowId)) close(false);
    if (target?.head.kind === "beat" && !first && !composing && !dirty && !saving) {
      const row = rowOf(target.head.rowId);
      if (row && (row.visualText ?? "") !== shownHtml) {
        shownHtml = row.visualText ?? "";
        const kept = doc.activeElement === cell ? cellSelection(cell) : null;
        const restore = ports.beforeWrite?.(cell);
        cell.innerHTML = shownHtml;
        if (kept) {
          ensureTrailingCaretSpot(cell);
          setCellSelection(cell, kept.from, kept.to);
        }
        restore?.(kept);
        pictures.innerHTML = ports.thumbnails(row);
      }
    }
    const range = ports.selection();
    const head = range?.head;
    const row = head?.kind === "beat" ? rowOf(head.rowId) : undefined;
    const label = row ? ports.plainVisual(row) : "";
    noteRow = row?.id ?? null;
    note.hidden = !label || !range || !isCollapsed(range);
    if (row && !note.hidden) {
      const caption = label + (hasSetLength(row) ? " · " + formatDuration(row.lengthSeconds) : "");
      if (noteText.data !== caption) noteText.data = caption;
      const beat = root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(row.id) + '"]');
      const rect = beat?.getClientRects()[0];
      const holder = parent?.getBoundingClientRect();
      if (rect && holder && parent) {
        note.style.top = rect.top - holder.top + parent.scrollTop + "px";
        const left = root.offsetLeft + root.offsetWidth + 16;
        note.style.left = left + "px";
        note.style.maxWidth = Math.max(0, parent.clientWidth - left - 16) + "px";
      }
    }
    position();
  }

  const repaint = ports.repaint;
  const refresh = repaint ? () => { repaint(refreshUnbuffered); } : refreshUnbuffered;

  function onInput(event: Event): void {
    if (rejected()) return;
    dirty = true;
    if (composing || (event as InputEvent).isComposing) return;
    save();
    saving = true;
    try { ports.input(event as InputEvent, cell); }
    finally {
      if (target?.head.kind === "beat") shownHtml = rowOf(target.head.rowId)?.visualText ?? "";
      saving = false;
    }
    refresh();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || composing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      const redo = event.key.toLowerCase() === "y" || event.shiftKey;
      close();
      ports.undo(redo ? "redo" : "undo");
      return;
    }
    if (!ports.blocked() && ports.keydown(event, cell)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      if (rejected()) return;
      ports.paste(cell, { getData: type => type === "text/plain" ? "\n" : "" });
      dirty = true;
      save();
    }
  }

  function onBeforeInput(event: Event): void {
    const input = event as InputEvent;
    if (input.inputType === "historyUndo" || input.inputType === "historyRedo") {
      event.preventDefault();
      event.stopPropagation();
      close();
      ports.undo(input.inputType === "historyUndo" ? "undo" : "redo");
    }
    if (input.inputType === "insertParagraph" || input.inputType === "insertLineBreak") {
      event.preventDefault();
      if (rejected()) return;
      ports.paste(cell, { getData: type => type === "text/plain" ? "\n" : "" });
      dirty = true;
      save();
    }
  }

  function onCompositionStart(): void { composing = true; }
  function onCompositionEnd(): void { composing = false; save(); refresh(); }
  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (rejected()) return;
    if (event.clipboardData) ports.paste(cell, event.clipboardData);
    dirty = true;
    save();
  }
  function onDrop(event: Event): void { event.preventDefault(); event.stopPropagation(); }
  function keepSelection(event: Event): void { event.preventDefault(); }
  function onButton(): void { open(ports.selection()); }
  function onNote(): void {
    if (!noteRow) return;
    const range = ports.selection();
    open(range?.head.kind === "beat" && range.head.rowId === noteRow ? range : caretAt(beatPos(noteRow, 0)));
  }
  function onClose(): void { close(); }
  function outside(event: Event): void {
    const element = event.target as Node;
    if ((element as Element).closest?.("#tag-edit-action, #tag-open-hint, #tag-ghost")) return;
    if (!box.hidden && !box.contains(element) && !button.contains(element) && !note.contains(element)) close(false);
  }
  const listeners: [EventTarget, string, EventListener][] = [
    [cell, "input", onInput], [cell, "keydown", onKeydown as EventListener], [cell, "beforeinput", onBeforeInput],
    [cell, "compositionstart", onCompositionStart], [cell, "compositionend", onCompositionEnd],
    [cell, "paste", onPaste as EventListener], [cell, "drop", onDrop],
    [button, "mousedown", keepSelection], [button, "click", onButton], [note, "mousedown", keepSelection], [note, "click", onNote],
    [closeButton, "click", onClose], [doc, "mousedown", outside], [window, "resize", refresh]
  ];
  if (parent) listeners.push([parent, "scroll", refresh]);
  listeners.forEach(([element, event, handler]) => element.addEventListener(event, handler));
  return {
    element: box,
    open,
    refresh,
    close,
    dispose(): void {
      close(false);
      listeners.forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      button.remove(); note.remove(); box.remove();
    }
  };
}
