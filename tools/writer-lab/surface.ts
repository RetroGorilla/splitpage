import {
  backspaceAt, beatPos, caretAt, comparePos, deleteForwardAt, enterAt, enterInHeading, finalizeHeading, flowOf, headingPos, inlineMarkdown,
  isCollapsed, isPendingHeading, joinWithPrevious, lineBreakAt, logicalText, orderedRange, pasteText, renameHeading, replaceRange,
  setMarkAcross, selectionToOwnBeat, startBeat, startParagraph, stepFrom, typeWithMarks, withinOneBeat
} from "../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowPos, FlowRange, FlowRow } from "../../src/core/flow/flow.ts";
import { typingMarks } from "../../src/core/text/edits.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { cellLength, projection } from "../../src/core/text/runs.ts";
import type { MarkName, Marks, Run } from "../../src/core/text/runs.ts";
import { domToPos, posToDom } from "../../src/features/common/cell-dom.ts";

const ZWSP = "​";

export interface SurfacePorts {
  readonly root: HTMLElement;
  readonly doc: () => FlowDoc;
  readonly flow: FlowPorts;
  readonly decode: (html: string) => Run[];
  readonly storedHtml: (html: string) => string;
  readonly syncBeat: (rowId: string, runs: readonly Run[]) => void;
  readonly commit: (name: string, edit: FlowEdit, before: FlowRange | null) => void;
  readonly undo: (dir: "undo" | "redo") => void;
  readonly breakCoalescing: () => void;
  readonly notice: (text: string) => void;
  readonly changed: () => void;
  readonly selectionMoved: (range: FlowRange | null) => void;
  readonly settings: () => SurfaceSettings;
  readonly openFind: () => void;
  readonly plainVisual: (row: FlowRow) => string;
}

export interface SurfaceSettings {
  readonly enter: "single" | "double";
  readonly tick: "delete" | "join";
  readonly gapTyping: "before" | "here";
  readonly markdown: boolean;
}

export interface Surface {
  readonly paint: () => void;
  readonly selection: () => FlowRange | null;
  readonly place: (range: FlowRange, scroll?: boolean) => void;
  readonly format: (mark: MarkName) => void;
  readonly pendingMarks: () => Marks | null;
  readonly apply: (name: string, outcome: FlowOutcome, before: FlowRange | null) => void;
  readonly toOwnBeat: (range: FlowRange) => string | null;
  readonly domRange: (range: FlowRange) => Range | null;
  readonly domCheck: () => string[];
  readonly dispose: () => void;
}

function isText(node: Node | null): node is Text {
  return !!node && node.nodeType === 3;
}

function isElement(node: Node | null): node is HTMLElement {
  return !!node && node.nodeType === 1;
}

function elementOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  return isElement(node) ? node : node.parentElement;
}

function beatHtml(runs: readonly Run[]): string {
  const html = toHtml(runs);
  if (!html) return ZWSP;
  return /<br\s*\/?>$/.test(html) ? html + ZWSP : html;
}

export function createSurface(ports: SurfacePorts): Surface {
  const root = ports.root;
  const rendered = new WeakMap<HTMLElement, string>();
  let composing = false;
  let mouseDown = false;
  let clicks = 0;
  let pending: { pos: FlowPos; marks: Marks } | null = null;
  let pendingHeading: string | null = null;
  let lastBeat: string | null = null;
  let painting = false;

  function cellOf(row: FlowRow): readonly Run[] { return ports.flow.cells(row.audioText); }

  function beatEl(rowId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(rowId) + '"]');
  }

  function headingEl(sceneId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>('.wr-heading[data-scene="' + CSS.escape(sceneId) + '"]');
  }

  function textBefore(el: HTMLElement): string | null {
    let found: string | null = null;
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
      found = (prev.textContent || "").replace(/​/g, "");
      if (found) return found;
    }
    return found;
  }

  // why: a run-on beat starts with a zero-width space so the browser sees a word break there; without it
  // double-click, Ctrl+arrow, line wrapping and spellcheck all read "store" + "and" as one word
  function syncSpots(el: HTMLElement, lead: boolean, empty: boolean): void {
    const first = el.firstChild;
    if (empty) {
      if (el.textContent === ZWSP) return;
      if (!(el.textContent || "").includes(ZWSP)) el.appendChild(document.createTextNode(ZWSP));
      return;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const keepFirst = lead && text === first;
      const keepEnd = !text.nextSibling && text.previousSibling?.nodeName === "BR" && text.parentNode === el;
      for (let at = text.data.length - 1; at >= 0; at--) {
        if (text.data[at] !== ZWSP) continue;
        if ((keepFirst && at === 0) || (keepEnd && at === text.data.length - 1)) continue;
        text.deleteData(at, 1);
      }
    }
    if (!lead) return;
    if (isText(first)) {
      if (first.data[0] !== ZWSP) first.insertData(0, ZWSP);
    } else {
      el.insertBefore(document.createTextNode(ZWSP), first);
    }
  }

  function decorate(el: HTMLElement, row: FlowRow, label: string): void {
    const cell = cellOf(row);
    const text = projection(cell);
    const visual = ports.flow.hasVisual(row);
    const before = textBefore(el);
    const noGap = before === null || /\s$/.test(before) || /^\s/.test(text);
    el.classList.toggle("is-empty", !text);
    el.classList.toggle("is-visual-only", !text && visual);
    el.classList.toggle("is-blank", !text && !visual);
    el.classList.toggle("is-filmed", row.status === "shot");
    el.classList.toggle("no-gap", noGap);
    el.setAttribute("data-num", label);
    if (!text && visual) el.setAttribute("data-visual", ports.plainVisual(row));
    else el.removeAttribute("data-visual");
    syncSpots(el, !noGap && !!text, !text);
  }

  function paint(): void {
    painting = true;
    const doc = ports.doc();
    const keptBeats = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>(".wr-beat").forEach(el => keptBeats.set(el.getAttribute("data-id") as string, el));
    const keptHeads = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>(".wr-heading").forEach(el => keptHeads.set(el.getAttribute("data-scene") as string, el));
    const pars = Array.from(root.querySelectorAll<HTMLElement>(":scope > .wr-par"));
    let cursor: Node | null = root.firstChild;
    function place(parent: Node, node: Node, at: Node | null): Node | null {
      if (node === at) return at ? at.nextSibling : null;
      parent.insertBefore(node, at);
      return at;
    }
    let sceneLetter = 0, beatNumber = 0;
    let sceneTag = "A";
    if (flowOf(doc)[0]?.kind === "heading") sceneLetter = -1;
    flowOf(doc).forEach(function (block) {
      if (block.kind === "heading") {
        let el = keptHeads.get(block.scene.id);
        if (!el) {
          el = document.createElement("h2");
          el.className = "wr-heading";
          el.setAttribute("data-scene", block.scene.id);
        }
        keptHeads.delete(block.scene.id);
        if (el.textContent !== block.scene.name) el.textContent = block.scene.name;
        sceneLetter++;
        beatNumber = 0;
        sceneTag = String.fromCharCode(65 + (sceneLetter % 26));
        el.setAttribute("data-letter", sceneTag);
        cursor = place(root, el, cursor);
        return;
      }
      let par: HTMLElement | undefined = isElement(cursor) && cursor.classList.contains("wr-par") ? cursor : pars.shift();
      if (par && par === cursor) { const at = pars.indexOf(par); if (at !== -1) pars.splice(at, 1); }
      if (!par) {
        par = document.createElement("div");
        par.className = "wr-par";
      }
      cursor = place(root, par, cursor);
      let inner: Node | null = par.firstChild;
      block.beats.forEach(function (row) {
        let el = keptBeats.get(row.id);
        const runs = cellOf(row);
        const html = beatHtml(runs);
        if (!el) {
          el = document.createElement("span");
          el.className = "wr-beat";
          el.setAttribute("data-id", row.id);
          el.setAttribute("data-field", "audioText");
          el.innerHTML = html;
          rendered.set(el, html);
        } else if (rendered.get(el) !== html) {
          el.innerHTML = html;
          rendered.set(el, html);
        }
        keptBeats.delete(row.id);
        beatNumber++;
        inner = place(par as Node, el, inner);
        decorate(el, row, sceneTag + beatNumber);
      });
      while (inner) {
        const next: Node | null = inner.nextSibling;
        if (!isElement(inner) || !inner.classList.contains("wr-beat")) (par as Node).removeChild(inner);
        inner = next;
      }
      const leftovers = Array.from(par.children).filter(child => child.classList.contains("wr-beat") && !block.beats.some(row => row.id === child.getAttribute("data-id")));
      leftovers.forEach(child => child.remove());
    });
    while (cursor) {
      const next: Node | null = cursor.nextSibling;
      root.removeChild(cursor);
      cursor = next;
    }
    keptBeats.forEach(el => { if (el.isConnected) el.remove(); });
    keptHeads.forEach(el => { if (el.isConnected) el.remove(); });
    painting = false;
  }

  function posFromDom(node: Node, offset: number): FlowPos | null {
    const el = elementOf(node);
    if (!el || !root.contains(el)) return null;
    const beat = el.closest<HTMLElement>(".wr-beat");
    if (beat) {
      const at = domToPos(beat, node, offset);
      return at === null ? null : beatPos(beat.getAttribute("data-id") as string, at);
    }
    const heading = el.closest<HTMLElement>(".wr-heading");
    if (heading) {
      const probe = document.createRange();
      probe.selectNodeContents(heading);
      probe.setEnd(node, offset);
      return headingPos(heading.getAttribute("data-scene") as string, probe.toString().length);
    }
    const holder = isElement(node) ? node : el;
    const child = holder.childNodes[isElement(node) ? offset : 0] as Node | undefined;
    if (child) return firstPosIn(child) ?? lastPosBefore(holder, isElement(node) ? offset : 0);
    return lastPosBefore(holder, holder.childNodes.length);
  }

  function firstPosIn(node: Node): FlowPos | null {
    if (!isElement(node)) return null;
    if (node.classList.contains("wr-heading")) return headingPos(node.getAttribute("data-scene") as string, 0);
    const beat = node.classList.contains("wr-beat") ? node : node.querySelector<HTMLElement>(".wr-beat");
    return beat ? beatPos(beat.getAttribute("data-id") as string, 0) : null;
  }

  function lastPosIn(node: Node): FlowPos | null {
    if (!isElement(node)) return null;
    if (node.classList.contains("wr-heading")) return headingPos(node.getAttribute("data-scene") as string, (node.textContent || "").length);
    const beats = node.classList.contains("wr-beat") ? [node] : Array.from(node.querySelectorAll<HTMLElement>(".wr-beat"));
    const beat = beats[beats.length - 1];
    if (!beat) return null;
    return beatPos(beat.getAttribute("data-id") as string, beatLength(beat.getAttribute("data-id") as string));
  }

  function beatLength(rowId: string): number {
    const row = ports.doc().rows.find(item => item.id === rowId);
    return row ? cellLength(cellOf(row)) : 0;
  }

  function lastPosBefore(holder: Node, index: number): FlowPos | null {
    for (let at = index - 1; at >= 0; at--) {
      const found = lastPosIn(holder.childNodes[at] as Node);
      if (found) return found;
    }
    return holder === root ? null : posFromDom(holder.parentNode as Node, Array.prototype.indexOf.call((holder.parentNode as Node).childNodes, holder));
  }

  function selection(): FlowRange | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
    const anchor = posFromDom(sel.anchorNode, sel.anchorOffset);
    const head = posFromDom(sel.focusNode, sel.focusOffset);
    return anchor && head ? { anchor, head } : null;
  }

  function domPoint(pos: FlowPos): { node: Node; offset: number } | null {
    if (pos.kind === "beat") {
      const el = beatEl(pos.rowId);
      if (!el) return null;
      const point = posToDom(el, pos.offset);
      return isText(point.node) && point.node.data[point.offset] === ZWSP ? { node: point.node, offset: point.offset + 1 } : point;
    }
    const el = headingEl(pos.sceneId);
    if (!el) return null;
    const text = el.firstChild;
    if (!isText(text)) return { node: el, offset: 0 };
    return { node: text, offset: Math.min(pos.offset, text.length) };
  }

  function place(range: FlowRange, scroll?: boolean): void {
    const a = domPoint(range.anchor), h = domPoint(range.head);
    const sel = window.getSelection();
    if (!a || !h || !sel) return;
    root.focus({ preventScroll: true });
    sel.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    if (scroll) {
      const target = elementOf(h.node);
      if (target) target.scrollIntoView({ block: "nearest" });
    }
  }

  function apply(name: string, outcome: FlowOutcome, before: FlowRange | null): void {
    if (!outcome) return;
    if ("refused" in outcome) { ports.notice(outcome.refused); return; }
    if ("move" in outcome) { place(caretAt(outcome.move), true); return; }
    ports.commit(name, outcome, before);
    paint();
    place(outcome.selection, true);
    if (outcome.notice) ports.notice(outcome.notice);
    ports.changed();
    noteSelection();
  }

  function repairOrphans(): boolean {
    let found = false;
    root.querySelectorAll<HTMLElement>(":scope > .wr-par").forEach(function (par) {
      Array.from(par.childNodes).forEach(function (child) {
        if (isElement(child) && child.classList.contains("wr-beat")) return;
        const text = (child.textContent || "").replace(/​/g, "");
        found = true;
        if (text) {
          const previous = child.previousSibling;
          const next = child.nextSibling;
          const home = isElement(previous) && previous.classList.contains("wr-beat") ? previous : isElement(next) && next.classList.contains("wr-beat") ? next : null;
          if (home) {
            home.insertAdjacentText(home === previous ? "beforeend" : "afterbegin", text);
            syncBeatEl(home);
          }
        }
        child.remove();
      });
    });
    Array.from(root.childNodes).forEach(function (child) {
      if (isElement(child) && (child.classList.contains("wr-par") || child.classList.contains("wr-heading"))) return;
      const text = (child.textContent || "").replace(/​/g, "");
      found = true;
      if (text) {
        const previous = child.previousSibling;
        const home = isElement(previous) ? (previous.classList.contains("wr-beat") ? previous : previous.querySelector<HTMLElement>(".wr-beat:last-child")) : null;
        if (home) {
          home.insertAdjacentText("beforeend", text);
          syncBeatEl(home);
        }
      }
      child.remove();
    });
    root.querySelectorAll<HTMLElement>(".wr-beat .wr-beat").forEach(function (inner) {
      found = true;
      inner.replaceWith(...Array.from(inner.childNodes));
    });
    return found;
  }

  function syncBeatEl(el: HTMLElement): void {
    const rowId = el.getAttribute("data-id");
    if (!rowId) return;
    const stored = ports.storedHtml(el.innerHTML.replace(/​/g, ""));
    const runs = ports.decode(stored);
    ports.syncBeat(rowId, runs);
    rendered.set(el, beatHtml(runs));
    const doc = ports.doc();
    const index = doc.rows.findIndex(row => row.id === rowId);
    const row = doc.rows[index];
    if (row) {
      decorate(el, row, el.getAttribute("data-num") || "");
      const nextEl = el.nextElementSibling as HTMLElement | null;
      const next = doc.rows[index + 1];
      if (nextEl && next) decorate(nextEl, next, nextEl.getAttribute("data-num") || "");
    }
    updatePendingHeading(rowId, el);
  }

  function updatePendingHeading(rowId: string, el: HTMLElement): void {
    const isPending = isPendingHeading(ports.doc(), rowId, ports.flow);
    el.classList.toggle("is-pending-heading", isPending);
    if (isPending) pendingHeading = rowId;
    else if (pendingHeading === rowId) pendingHeading = null;
  }

  function currentBeatRow(range: FlowRange): FlowRow | null {
    if (range.head.kind !== "beat") return null;
    const id = range.head.rowId;
    return ports.doc().rows.find(row => row.id === id) ?? null;
  }

  function maybeInlineMarkdown(): void {
    if (!ports.settings().markdown) return;
    const range = selection();
    if (!range || !isCollapsed(range) || range.head.kind !== "beat") return;
    const row = currentBeatRow(range);
    if (!row) return;
    const made = inlineMarkdown(ports.flow.cells(row.audioText), range.head.offset);
    if (!made) return;
    const doc = ports.doc();
    const rows = doc.rows.map(item => item.id === row.id ? { ...item, audioText: toHtml(made.cell) } : item);
    ports.breakCoalescing();
    apply("inline-markdown", { rows, sections: doc.sections as FlowEdit["sections"], removedComments: [], selection: caretAt(beatPos(row.id, made.caret)) }, range);
    const marks: Record<string, unknown> = { ...typingMarks(made.cell, made.caret) };
    delete marks[made.mark];
    pending = { pos: beatPos(row.id, made.caret), marks: marks as Marks };
  }

  function onInput(event: Event): void {
    if (composing || painting) return;
    const input = event as InputEvent;
    const repaired = repairOrphans();
    const sel = window.getSelection();
    const el = elementOf(sel?.anchorNode ?? null);
    const beat = el?.closest<HTMLElement>(".wr-beat") ?? null;
    const heading = el?.closest<HTMLElement>(".wr-heading") ?? null;
    if (beat) {
      syncBeatEl(beat);
      if (input.inputType === "insertText" && input.data && /[*~]$/.test(input.data)) maybeInlineMarkdown();
    } else if (heading) {
      const id = heading.getAttribute("data-scene") as string;
      const name = (heading.textContent || "").replace(/​/g, "");
      const pos = selection()?.head ?? headingPos(id, name.length);
      if (name) {
        apply("rename-scene", renameHeading(ports.doc(), id, name, pos.offset), null);
      } else {
        apply("remove-scene", replaceRange(ports.doc(), { anchor: headingPos(id, 0), head: headingPos(id, 0) }, [], ports.flow), null);
      }
    }
    if (repaired) paint();
    ports.changed();
  }

  function range0(event: InputEvent): FlowRange | null {
    const targets = event.getTargetRanges();
    const target = targets[0];
    if (!target) return null;
    const anchor = posFromDom(target.startContainer, target.startOffset);
    const head = posFromDom(target.endContainer, target.endOffset);
    return anchor && head ? { anchor, head } : null;
  }

  function coversWholeBeat(range: FlowRange): boolean {
    if (!withinOneBeat(range) || range.anchor.kind !== "beat") return false;
    const { from, to } = orderedRange(ports.doc(), range);
    return from.offset === 0 && to.offset >= beatLength(range.anchor.rowId);
  }

  function resolveInBeat(range: FlowRange): FlowRange {
    const doc = ports.doc();
    const { from, to } = orderedRange(doc, range);
    if (from.kind === "beat" && to.kind === "beat" && from.rowId !== to.rowId && to.offset === 0) {
      const index = doc.rows.findIndex(row => row.id === (to as { rowId: string }).rowId);
      const prev = doc.rows[index - 1];
      if (prev && prev.id === from.rowId) return { anchor: from, head: beatPos(prev.id, beatLength(prev.id)) };
    }
    return { anchor: from, head: to };
  }

  function onBeforeInput(event: Event): void {
    const input = event as InputEvent;
    if (composing) return;
    const type = input.inputType;
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      ports.undo(type === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (type === "insertFromPaste" || type === "insertFromDrop" || type === "deleteByCut" || type === "deleteByDrag" || type.startsWith("format")) {
      event.preventDefault();
      return;
    }
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      return;
    }
    const range = selection();
    if (!range) return;
    if (type === "insertText" || type === "insertReplacementText") {
      const data = input.data ?? input.dataTransfer?.getData("text/plain") ?? "";
      if (pending && isCollapsed(range) && comparePos(ports.doc(), pending.pos, range.head) === 0 && input.data) {
        event.preventDefault();
        apply("type", typeWithMarks(ports.doc(), range.head, input.data, pending.marks, ports.flow), range);
        pending = null;
        return;
      }
      const target = range0(input) ?? range;
      if (!isCollapsed(target) && !withinOneBeat(target)) {
        event.preventDefault();
        ports.breakCoalescing();
        apply("replace-selection", replaceRange(ports.doc(), target, data ? [{ text: data, marks: typingMarksFor(target) }] : [], ports.flow), range);
        return;
      }
      if (ports.settings().gapTyping === "before" && isCollapsed(range) && range.head.kind === "beat" && range.head.offset === 0 && beatLength(range.head.rowId)) {
        const redirect = caretBeforeTick(range.head.rowId);
        if (redirect) {
          event.preventDefault();
          const row = ports.doc().rows.find(item => item.id === redirect.rowId) as FlowRow;
          apply("type", typeWithMarks(ports.doc(), beatPos(redirect.rowId, redirect.offset), input.data ?? "", typingMarks(cellOf(row), redirect.offset), ports.flow), null);
          return;
        }
      }
      return;
    }
    if (!type.startsWith("delete")) return;
    const backward = type.endsWith("Backward") || type === "deleteContentBackward";
    if (isCollapsed(range) && type === "deleteContentBackward" && range.head.offset === 0) {
      event.preventDefault();
      ports.breakCoalescing();
      apply("backspace", backspaceAt(ports.doc(), range.head, ports.flow, { tick: ports.settings().tick }), range);
      return;
    }
    if (isCollapsed(range) && type === "deleteContentForward") {
      const pos = range.head;
      const atEnd = pos.kind === "beat" ? pos.offset >= beatLength(pos.rowId) : (headingEl(pos.sceneId)?.textContent || "").length <= pos.offset;
      if (atEnd) {
        event.preventDefault();
        ports.breakCoalescing();
        apply("delete", deleteForwardAt(ports.doc(), pos, ports.flow), range);
        return;
      }
    }
    const target = range0(input);
    const effective = target && !isCollapsed(target) ? target : range;
    if (isCollapsed(effective)) {
      if (backward && effective.head.offset === 0) {
        event.preventDefault();
        ports.breakCoalescing();
        apply("backspace", backspaceAt(ports.doc(), effective.head, ports.flow, { tick: ports.settings().tick }), range);
      }
      return;
    }
    const resolved = resolveInBeat(effective);
    const isHeadingOnly = resolved.anchor.kind === "heading" && resolved.head.kind === "heading" && resolved.anchor.sceneId === resolved.head.sceneId;
    if (isHeadingOnly) {
      const scene = resolved.anchor.sceneId;
      const whole = comparePos(ports.doc(), resolved.anchor, resolved.head) !== 0
        && Math.min(resolved.anchor.offset, resolved.head.offset) === 0
        && Math.max(resolved.anchor.offset, resolved.head.offset) >= (headingEl(scene)?.textContent || "").length;
      if (whole) {
        event.preventDefault();
        ports.breakCoalescing();
        apply("remove-scene", replaceRange(ports.doc(), resolved, [], ports.flow), range);
      }
      return;
    }
    if (isCollapsed(resolved)) {
      event.preventDefault();
      ports.breakCoalescing();
      apply(backward ? "backspace" : "delete", backward
        ? backspaceAt(ports.doc(), range.head, ports.flow, { tick: ports.settings().tick })
        : deleteForwardAt(ports.doc(), range.head, ports.flow), range);
      return;
    }
    // why: native edits stay in the caret's beat; Chromium can aim a word delete at the next or previous beat
    const elsewhere = resolved.anchor.kind === "beat" && (range.head.kind !== "beat" || resolved.anchor.rowId !== range.head.rowId);
    if (!withinOneBeat(resolved) || coversWholeBeat(resolved) || elsewhere) {
      event.preventDefault();
      ports.breakCoalescing();
      apply("delete-selection", replaceRange(ports.doc(), resolved, [], ports.flow), range);
    }
  }

  function typingMarksFor(range: FlowRange): Marks {
    const { from } = orderedRange(ports.doc(), range);
    if (from.kind !== "beat") return {};
    const row = ports.doc().rows.find(item => item.id === from.rowId);
    return row ? typingMarks(cellOf(row), from.offset) : {};
  }

  function caretBeforeTick(rowId: string): { rowId: string; offset: number } | null {
    const doc = ports.doc();
    const el = beatEl(rowId);
    const prevEl = el?.previousElementSibling as HTMLElement | null;
    if (!prevEl || !prevEl.classList.contains("wr-beat") || prevEl.classList.contains("is-empty")) return null;
    const index = doc.rows.findIndex(row => row.id === rowId);
    const prev = doc.rows[index - 1];
    return prev ? { rowId: prev.id, offset: cellLength(cellOf(prev)) } : null;
  }

  function onEnter(event: KeyboardEvent, range: FlowRange): void {
    event.preventDefault();
    ports.breakCoalescing();
    const doc = ports.doc();
    if (event.shiftKey) {
      apply("line-break", lineBreakAt(doc, range, ports.flow), range);
      return;
    }
    if (!isCollapsed(range) && !event.altKey && ports.settings().enter === "double") {
      apply("enter", enterAt(doc, range, ports.flow), range);
      return;
    }
    let caret = range;
    if (!isCollapsed(range)) {
      const cleared = replaceRange(doc, range, [], ports.flow);
      apply("delete-selection", cleared, range);
      if (!cleared || !("selection" in cleared)) return;
      caret = cleared.selection;
    }
    const pos = caret.head;
    if (event.altKey) {
      apply("start-beat", startBeat(ports.doc(), pos, ports.flow), caret);
      return;
    }
    if (pos.kind === "heading") {
      apply("enter-heading", enterInHeading(ports.doc(), pos, ports.flow), caret);
      return;
    }
    if (pendingHeading && pendingHeading === pos.rowId) {
      const row = pos.rowId;
      pendingHeading = null;
      apply("make-heading", finalizeHeading(ports.doc(), row, pos.offset, null, ports.flow), caret);
      return;
    }
    if (ports.settings().enter === "double") {
      apply("enter", enterAt(ports.doc(), caret, ports.flow), caret);
      return;
    }
    apply("start-paragraph", startParagraph(ports.doc(), pos, ports.flow), caret);
  }

  function format(mark: MarkName): void {
    const range = selection();
    if (!range) return;
    if (isCollapsed(range)) {
      if (range.head.kind !== "beat") return;
      const row = currentBeatRow(range);
      if (!row) return;
      const base = pending && comparePos(ports.doc(), pending.pos, range.head) === 0 ? pending.marks : typingMarks(cellOf(row), range.head.offset);
      const marks: Record<string, unknown> = { ...base };
      if (marks[mark]) delete marks[mark];
      else marks[mark] = true;
      pending = { pos: range.head, marks: marks as Marks };
      ports.selectionMoved(range);
      return;
    }
    ports.breakCoalescing();
    apply("format", setMarkAcross(ports.doc(), range, mark, ports.flow), range);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (composing) return;
    const key = event.key;
    const range = selection();
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.altKey && (key === "z" || key === "Z")) {
      event.preventDefault();
      ports.undo(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (ctrl && !event.altKey && (key === "y" || key === "Y")) {
      event.preventDefault();
      ports.undo("redo");
      return;
    }
    if (ctrl && !event.altKey && (key === "f" || key === "F")) {
      event.preventDefault();
      ports.openFind();
      return;
    }
    if (!range) return;
    if (key === "Enter") { onEnter(event, range); return; }
    if ((key === "ArrowRight" || key === "ArrowLeft") && !ctrl && !event.shiftKey && !event.altKey && isCollapsed(range) && range.head.kind === "beat" && !beatLength(range.head.rowId)) {
      // why: an empty beat's caret spot has two sides but looks like one, so a native press seems to do nothing
      const step = stepFrom(ports.doc(), range.head.rowId, key === "ArrowRight", ports.flow);
      if (step) {
        event.preventDefault();
        place(caretAt(step), true);
      }
      return;
    }
    if (event.altKey && key === "Backspace") {
      event.preventDefault();
      if (range.head.kind !== "beat") return;
      ports.breakCoalescing();
      const offset = range.head.offset;
      const id = range.head.rowId;
      const doc = ports.doc();
      const index = doc.rows.findIndex(row => row.id === id);
      const row = doc.rows[index];
      const next = doc.rows[index + 1];
      const target = offset === 0 || !next ? id : next.id;
      if (row) apply("join", joinWithPrevious(doc, target, ports.flow), range);
      return;
    }
    if (ctrl && !event.altKey && !event.shiftKey) {
      const mark: MarkName | null = key === "b" || key === "B" ? "b" : key === "i" || key === "I" ? "i" : key === "u" || key === "U" ? "u" : null;
      if (mark) {
        event.preventDefault();
        format(mark);
      }
    }
  }

  function onCopy(event: ClipboardEvent): void {
    const range = selection();
    if (!range || isCollapsed(range) || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", logicalText(ports.doc(), range, ports.flow));
  }

  function onCut(event: ClipboardEvent): void {
    onCopy(event);
    const range = selection();
    if (!range || isCollapsed(range)) return;
    event.preventDefault();
    ports.breakCoalescing();
    apply("cut", replaceRange(ports.doc(), range, [], ports.flow), range);
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const range = selection();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!range || !text) return;
    const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n+/);
    ports.breakCoalescing();
    apply("paste", pasteText(ports.doc(), range, paragraphs, ports.flow), range);
  }

  function noteSelection(): void {
    const range = selection();
    const head = range?.head;
    const currentBeat = head && head.kind === "beat" ? head.rowId : null;
    if (lastBeat !== currentBeat) {
      if (lastBeat) beatEl(lastBeat)?.classList.remove("is-current");
      if (currentBeat) beatEl(currentBeat)?.classList.add("is-current");
      lastBeat = currentBeat;
    }
    if (pending && (!range || !isCollapsed(range) || comparePos(ports.doc(), pending.pos, range.head) !== 0)) pending = null;
    ports.selectionMoved(range);
  }

  function leavePendingHeading(): void {
    if (!pendingHeading || mouseDown || composing) return;
    const range = selection();
    if (!range) return;
    const at = range.head;
    if (at.kind === "beat" && at.rowId === pendingHeading) return;
    const row = pendingHeading;
    pendingHeading = null;
    ports.breakCoalescing();
    apply("make-heading", finalizeHeading(ports.doc(), row, null, range, ports.flow), null);
  }

  function onSelectionChange(): void {
    if (painting) return;
    noteSelection();
    leavePendingHeading();
  }

  function onCompositionStart(): void { composing = true; }

  function onCompositionEnd(): void {
    composing = false;
    window.setTimeout(function () {
      repairOrphans();
      root.querySelectorAll<HTMLElement>(".wr-beat").forEach(function (el) {
        const row = ports.doc().rows.find(item => item.id === el.getAttribute("data-id"));
        if (!row) return;
        const stored = ports.storedHtml(el.innerHTML.replace(/​/g, ""));
        if (toHtml(ports.decode(stored)) !== toHtml(cellOf(row))) syncBeatEl(el);
      });
      ports.changed();
    }, 0);
  }

  function onMouseDown(event: Event): void {
    mouseDown = true;
    clicks = (event as MouseEvent).detail;
  }

  // why: a triple-click ends at the next paragraph's start, and deleting that would pull the next paragraph up
  function trimTripleClick(): void {
    const range = selection();
    if (!range || isCollapsed(range)) return;
    const doc = ports.doc();
    const { from } = orderedRange(doc, range);
    if (from.kind !== "beat") return;
    const block = flowOf(doc).find(item => item.kind === "paragraph" && item.beats.some(row => row.id === from.rowId));
    if (!block || block.kind !== "paragraph") return;
    const last = block.beats[block.beats.length - 1] as FlowRow;
    place({ anchor: beatPos((block.beats[0] as FlowRow).id, 0), head: beatPos(last.id, beatLength(last.id)) });
  }

  function onMouseUp(): void {
    mouseDown = false;
    if (clicks === 3) trimTripleClick();
    clicks = 0;
    leavePendingHeading();
  }

  function toOwnBeat(range: FlowRange): string | null {
    if (isCollapsed(range)) return range.head.kind === "beat" ? range.head.rowId : null;
    if (!withinOneBeat(range) || range.head.kind !== "beat") return null;
    ports.breakCoalescing();
    const outcome = selectionToOwnBeat(ports.doc(), range, ports.flow);
    apply("own-beat", outcome, range);
    return outcome && "selection" in outcome && outcome.selection.head.kind === "beat" ? outcome.selection.head.rowId : range.head.rowId;
  }

  function domRange(range: FlowRange): Range | null {
    const { from, to } = orderedRange(ports.doc(), range);
    const start = domPoint(from), end = domPoint(to);
    if (!start || !end) return null;
    const made = document.createRange();
    made.setStart(start.node, start.offset);
    made.setEnd(end.node, end.offset);
    return made;
  }

  function domCheck(): string[] {
    const problems: string[] = [];
    if (composing) return problems;
    ports.doc().rows.forEach(function (row) {
      const el = beatEl(row.id);
      if (!el) { problems.push("beat " + row.id + " has no element"); return; }
      const stored = ports.storedHtml(el.innerHTML.replace(/​/g, ""));
      const shown = projection(ports.decode(stored));
      const held = projection(cellOf(row));
      if (shown !== held) problems.push("beat " + row.id + " shows " + JSON.stringify(shown) + " but holds " + JSON.stringify(held));
    });
    root.querySelectorAll(":scope > .wr-par > :not(.wr-beat)").forEach(() => problems.push("stray element in a paragraph"));
    root.querySelectorAll(":scope > .wr-par").forEach(par => {
      par.childNodes.forEach(node => { if (isText(node) && node.data.replace(/​/g, "")) problems.push("stray text in a paragraph: " + node.data); });
    });
    return problems;
  }

  const listeners: [EventTarget, string, EventListener][] = [
    [root, "beforeinput", onBeforeInput],
    [root, "input", onInput],
    [root, "keydown", onKeydown as EventListener],
    [root, "copy", onCopy as EventListener],
    [root, "cut", onCut as EventListener],
    [root, "paste", onPaste as EventListener],
    [root, "compositionstart", onCompositionStart],
    [root, "compositionend", onCompositionEnd],
    [root, "mousedown", onMouseDown],
    [window, "mouseup", onMouseUp],
    [document, "selectionchange", onSelectionChange]
  ];
  listeners.forEach(([target, name, handler]) => target.addEventListener(name, handler));

  return {
    paint,
    selection,
    place,
    format,
    pendingMarks: () => pending ? pending.marks : null,
    apply,
    toOwnBeat,
    domRange,
    domCheck,
    dispose: () => listeners.forEach(([target, name, handler]) => target.removeEventListener(name, handler))
  };
}
