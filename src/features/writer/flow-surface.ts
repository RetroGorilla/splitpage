import {
  backspaceAt, beatPos, caretAt, comparePos, deleteForwardAt, enterAt, enterInHeading, finalizeHeading, flowOf, headingPos, inlineMarkdown, SCENE_NAME_MAX,
  isCollapsed, isPendingHeading, joinWithPrevious, lineBreakAt, logicalText, orderedRange, pasteText, renameHeading, replaceRange,
  setMarkAcross, selectionToOwnBeat, startParagraph, stepFrom, typeWithMarks, withinOneBeat
} from "../../core/flow/flow.ts";
import { removeEmptyHeading as emptyHeadingEdit } from "../../core/flow/remove-empty-heading.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowPos, FlowRange, FlowRow } from "../../core/flow/flow.ts";
import { typingMarks } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength, projection } from "../../core/text/runs.ts";
import { editorKeys, resolveSelection, takeSnapshot } from "../../core/text/selection.ts";
import { hasSetLength } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import type { MarkName, Marks, Run } from "../../core/text/runs.ts";
import { domKeys, domToPos, posToDom } from "../common/cell-dom.ts";
import { createFlowBeatMenu } from "./flow-beat-menu.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import { createWriterBuffer } from "./flow-buffer.ts";
import { bufferedFieldTarget, headingFieldKey } from "../../application/editing/buffered-field-key.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import type { PaintedText, PaintedTextSource } from "../../application/editing/ports.ts";
import type { EditorSelection } from "../../application/editing/selection.ts";
import type { CommonDocumentSession } from "../../application/session/document-session.ts";

const ZWSP = String.fromCharCode(0x200B);
const ZWSP_ALL = new RegExp(ZWSP, "g");
const INPUT_MARKS: Readonly<Record<string, MarkName>> = {
  formatBold: "b", formatItalic: "i", formatUnderline: "u", formatStrikeThrough: "s"
};

export interface SurfacePorts {
  readonly clipboard?: {
    readonly mount: (handlers: Readonly<Record<"copy" | "cut" | "paste", (event: ClipboardEvent) => void>>) => () => void;
    readonly copy: (range: FlowRange, data: DataTransfer, cut: boolean) => void;
    readonly paste: (range: FlowRange, data: Pick<DataTransfer, "getData">) => FlowOutcome | undefined;
  };
  readonly paintedText?: PaintedTextSource;
  readonly bufferedText?: BufferedFieldPorts;
  readonly lifetime: Pick<CommonDocumentSession, "epoch">;
  readonly heldSelection: Pick<EditorSelection<object, unknown, unknown>, "rememberFlow" | "resolveFlow" | "forget">;
  readonly root: HTMLElement;
  readonly doc: () => FlowDoc;
  readonly flow: FlowPorts;
  readonly decode: (html: string) => Run[];
  readonly storedHtml: (html: string) => string;
  readonly moveBeat: (range: FlowRange, direction: -1 | 1) => void;
  readonly editingBlocked: () => boolean;
  readonly syncBeat: (rowId: string, runs: readonly Run[]) => void;
  readonly commit: (name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange | null) => FlowOutcome;
  readonly undo: (dir: "undo" | "redo") => void;
  readonly notice: (text: string) => void;
  readonly changed: () => void;
  readonly selectionMoved: (range: FlowRange | null) => void;
  readonly settings: () => SurfaceSettings;
  readonly openFind: () => void;
  readonly plainVisual: (row: FlowRow) => string;
  readonly beatInput?: (event: InputEvent, beat: HTMLElement) => void;
  readonly typeAtBeatEdge?: (beat: HTMLElement, text: string) => boolean;
  readonly beatKeydown?: (event: KeyboardEvent, beat: HTMLElement) => boolean;
  readonly beatSelection?: (beat: HTMLElement | null) => void;
  readonly leaveBeat?: (beat: HTMLElement) => void;
  readonly openVisual?: (rowId: string) => void;
}

export interface SurfaceSettings {
  readonly enter: "single" | "double";
  readonly tick: "delete" | "join";
  readonly gapTyping: "before" | "here";
  readonly markdown: boolean;
}

export interface Surface {
  readonly settle?: () => boolean;
  readonly finish: () => FlowRange | null;
  readonly paint: () => void;
  readonly repaint: () => void;
  readonly refreshBeat: (rowId: string) => void;
  readonly focusBack: () => void;
  readonly selection: () => FlowRange | null;
  readonly place: (range: FlowRange, scroll?: boolean) => void;
  readonly restoreAfterReplay: (range: FlowRange) => void;
  readonly prepareVisual: (range: FlowRange) => FlowRange | null;
  readonly format: (mark: MarkName) => void;
  readonly pendingMarks: () => Marks | null;
  readonly apply: (name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange | null) => FlowOutcome;
  readonly toOwnBeat: (range: FlowRange) => string | null;
  readonly domRange: (range: FlowRange) => Range | null;
  readonly domCheck: () => string[];
  readonly paintedBase: (rowId: string) => PaintedText | null;
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

function withMark(marks: Marks, mark: MarkName, on: boolean): Marks {
  const kept = Object.entries(marks).filter(([name]) => name !== mark);
  if (on) kept.push([mark, true]);
  return Object.fromEntries(kept) as Marks;
}

function beatHtml(runs: readonly Run[]): string {
  const html = toHtml(runs);
  if (!html) return ZWSP;
  return /<br\s*\/?>$/.test(html) ? html + ZWSP : html;
}

export function createSurface(inputPorts: SurfacePorts): Surface {
  const storedHeading = (sceneId: string): string | null => inputPorts.paintedText?.read(headingFieldKey(sceneId), "heading")?.text ?? null;
  const ports: SurfacePorts = inputPorts.bufferedText
    ? { ...inputPorts, syncBeat: () => {}, flow: { ...inputPorts.flow, storedHeading } } : inputPorts;
  const root = ports.root;
  const epoch = ports.lifetime.epoch();
  const rendered = new WeakMap<HTMLElement, string>();
  const paintedBeats = ports.paintedText ? createPaintedBeats(ports.paintedText) : null;
  // why: a shared heading shows its stored text, edge spaces included, so the screen and painted record match it
  const headingText = (scene: { readonly id: string; readonly name: string }): string =>
    paintedBeats ? storedHeading(scene.id) ?? scene.name : scene.name;
  let composing = false;
  const queuedPastes: Pick<DataTransfer, "getData">[] = [];
  let mouseDown = false;
  let clicks = 0;
  let pending: { pos: FlowPos; marks: Marks } | null = null;
  let pendingHeading: string | null = null;
  const headingCandidates = new Set<string>();
  const emptyHeadings = new Map<string, string>();
  let lastBeat: string | null = null;
  let painting = false;
  let repaintOwed = false;
  const compositionTargets = new Set<HTMLElement>();
  let syncingComposition = false;
  const beatMenu = createFlowBeatMenu(root, {
    canJoin: rowId => {
      const rows = ports.doc().rows;
      const index = rows.findIndex(row => row.id === rowId);
      return { back: index > 0, next: index >= 0 && index < rows.length - 1 };
    },
    joinBack: rowId => {
      apply("join", doc => joinWithPrevious(doc, rowId, ports.flow), selection() ?? heldRange());
    },
    joinNext: rowId => {
      apply("join", doc => {
        const next = doc.rows[doc.rows.findIndex(row => row.id === rowId) + 1];
        return next ? joinWithPrevious(doc, next.id, ports.flow) : null;
      }, selection() ?? heldRange());
    },
    addVisual: rowId => { ports.openVisual?.(rowId); }
  });

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
      found = (prev.textContent || "").replace(ZWSP_ALL, "");
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
    el.classList.toggle("is-pending-heading", headingCandidates.has(row.id) && isPendingHeading(ports.doc(), row.id, ports.flow));
    if (el.getAttribute("data-num") !== label) el.setAttribute("data-num", label);
    if (!text && visual) {
      const note = ports.plainVisual(row) + (hasSetLength(row) ? " · " + formatDuration(row.lengthSeconds) : "");
      if (el.getAttribute("data-visual") !== note) el.setAttribute("data-visual", note);
    }
    else el.removeAttribute("data-visual");
    syncSpots(el, !noGap && !!text, !text);
  }

  function paint(): void {
    // why: a composed batch can publish edits that re-enter paint before its remaining targets have synced
    if (composing || syncingComposition) { repaintOwed = true; return; }
    beatMenu.hide();
    syncComposition();
    repaintOwed = false;
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
        const name = emptyHeadings.get(block.scene.id) ?? headingText(block.scene);
        if (el.textContent !== name) el.textContent = name;
        sceneLetter++;
        beatNumber = 0;
        sceneTag = String.fromCharCode(65 + (sceneLetter % 26));
        if (el.getAttribute("data-letter") !== sceneTag) el.setAttribute("data-letter", sceneTag);
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
    // why: the base is what this pass showed, so it is read here; a later read could describe text nobody saw
    if (paintedBeats) paintedBeats.record([...doc.rows.map(row => ({ id: row.id, text: projection(cellOf(row)) })),
      ...flowOf(doc).flatMap(block => block.kind === "heading" ? [{ id: headingFieldKey(block.scene.id), text: emptyHeadings.get(block.scene.id) ?? headingText(block.scene) }] : [])],
    entry => entry.text);
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

  function selection(allowStale = false): FlowRange | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
    const anchor = posFromDom(sel.anchorNode, sel.anchorOffset);
    const head = posFromDom(sel.focusNode, sel.focusOffset);
    const range = anchor && head ? { anchor, head } : null;
    if (range && !allowStale && !rangeExists(range)) {
      ports.heldSelection.forget();
      sel.removeAllRanges();
      return null;
    }
    return range;
  }

  function rangeExists(range: FlowRange): boolean {
    const doc = ports.doc();
    return [range.anchor, range.head].every(pos => pos.kind === "beat"
      ? doc.rows.some(row => row.id === pos.rowId)
      : flowOf(doc).some(block => block.kind === "heading" && block.scene.id === pos.sceneId));
  }

  function heldRange(): FlowRange | null {
    const range = ports.heldSelection.resolveFlow();
    if (range && (!rangeExists(range) || !rangeFits(range))) {
      ports.heldSelection.forget();
      return null;
    }
    return range;
  }

  function rangeFits(range: FlowRange): boolean {
    const doc = ports.doc();
    return [range.anchor, range.head].every(pos => {
      if (pos.offset < 0) return false;
      if (pos.kind === "beat") {
        const row = doc.rows.find(item => item.id === pos.rowId);
        return !!row && pos.offset <= cellLength(cellOf(row));
      }
      return flowOf(doc).some(block => block.kind === "heading" && block.scene.id === pos.sceneId && pos.offset <= headingText(block.scene).length);
    });
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
    ports.heldSelection.rememberFlow(epoch, range);
    root.focus({ preventScroll: true });
    sel.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    noteSelection();
    if (scroll) {
      const target = elementOf(h.node);
      if (target) target.scrollIntoView({ block: "nearest" });
    }
  }

  // why: the app paints from outside on undo, reloads and merges; a beat whose text changed gets a new DOM, so the
  // selection is carried across by model position. Composing text must never be repainted, so that waits.
  function remapForRepaint(range: FlowRange): FlowRange | null {
    if (!isCollapsed(range)) return rangeExists(range) && rangeFits(range) ? range : null;
    const key = (pos: FlowPos) => pos.kind === "beat" ? "beat:" + pos.rowId : "heading:" + pos.sceneId;
    const shown = new Map(Array.from(root.querySelectorAll<HTMLElement>(".wr-beat, .wr-heading"), el =>
      [el.classList.contains("wr-beat") ? "beat:" + el.dataset.id : "heading:" + el.dataset.scene, el]));
    const doc = ports.doc();
    const current = new Map(flowOf(doc).flatMap(block => block.kind === "heading"
      ? [["heading:" + block.scene.id, headingText(block.scene).split("")]] as [string, readonly string[]][]
      : block.beats.map(row => ["beat:" + row.id, editorKeys(cellOf(row))] as [string, readonly string[]])));
    const world = { epoch, order: [...current.keys()], keys: (id: string) => current.get(id) ?? null };
    const resolve = (anchor: FlowPos, head: FlowPos) => {
      const el = shown.get(key(anchor));
      if (!el) return null;
      return resolveSelection(takeSnapshot({ epoch, rowId: key(anchor), field: "audioText", anchor: anchor.offset,
        head: head.offset, affinity: anchor.offset > 0 ? "backward" : "forward" }, anchor.kind === "beat" ? domKeys(el) : (el.textContent ?? "").split(""), [...shown.keys()]), world);
    };
    const point = (id: string, offset: number): FlowPos => id.startsWith("beat:") ? beatPos(id.slice(5), offset) : headingPos(id.slice(8), offset);
    const mapped = resolve(range.anchor, range.head);
    return mapped ? { anchor: point(mapped.rowId, mapped.anchor), head: point(mapped.rowId, mapped.head) } : null;
  }

  function repaint(): void {
    if (composing || syncingComposition) { repaintOwed = true; return; }
    const selected = selection(true);
    const before = selected ? remapForRepaint(selected) : null;
    if (selected && !before) {
      ports.heldSelection.forget();
      window.getSelection()?.removeAllRanges();
    }
    if (before) ports.heldSelection.rememberFlow(epoch, before);
    const focused = document.activeElement === root;
    if (before && !focused) window.getSelection()?.removeAllRanges();
    paint();
    if (!before || !focused) return;
    const now = selection();
    const doc = ports.doc();
    if (!now || comparePos(doc, now.anchor, before.anchor) !== 0 || comparePos(doc, now.head, before.head) !== 0) place(before);
    noteSelection();
  }

  function focusBack(): void {
    const first = ports.doc().rows[0];
    const target = heldRange() ?? (first ? caretAt(beatPos(first.id, 0)) : null);
    if (target) place(target, true);
    else root.focus({ preventScroll: true });
  }

  function apply(name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange | null, focus = true): FlowOutcome {
    const outcome = ports.commit(name, operation, before ?? selection());
    if (!outcome) return null;
    if ("refused" in outcome) { ports.notice(outcome.refused); return outcome; }
    if ("move" in outcome) { place(caretAt(outcome.move), true); return outcome; }
    paint();
    if (focus) place(outcome.selection, true);
    else ports.heldSelection.rememberFlow(epoch, outcome.selection);
    if (outcome.notice) ports.notice(outcome.notice);
    ports.changed();
    noteSelection();
    return outcome;
  }

  function repairOrphans(edited?: HTMLElement | null): boolean {
    let found = false;
    const local = edited?.parentElement?.classList.contains("wr-par") ? edited : null;
    const isBeat = (node: Node | null): node is HTMLElement => isElement(node) && node.classList.contains("wr-beat");
    function repairChild(child: ChildNode): void {
      if (isBeat(child)) return;
      const text = (child.textContent || "").replace(ZWSP_ALL, "");
      found = true;
      if (text) {
        const previous = child.previousSibling;
        const next = child.nextSibling;
        const home = isBeat(previous) ? previous : isBeat(next) ? next : null;
        if (home) {
          home.insertAdjacentText(home === previous ? "beforeend" : "afterbegin", text);
          syncBeatEl(home);
        }
      }
      child.remove();
    }
    if (local) {
      let child = local.previousSibling;
      if (child && !isBeat(child)) {
        while (child.previousSibling && !isBeat(child.previousSibling)) child = child.previousSibling;
        while (child && child !== local) {
          const next: ChildNode | null = child.nextSibling;
          repairChild(child);
          child = next;
        }
      }
      child = local.nextSibling;
      while (child && !isBeat(child)) {
        const next: ChildNode | null = child.nextSibling;
        repairChild(child);
        child = next;
      }
    } else {
      root.querySelectorAll<HTMLElement>(":scope > .wr-par").forEach(par => {
        Array.from(par.childNodes).forEach(repairChild);
      });
      Array.from(root.childNodes).forEach(function (child) {
        if (isElement(child) && (child.classList.contains("wr-par") || child.classList.contains("wr-heading"))) return;
        const text = (child.textContent || "").replace(ZWSP_ALL, "");
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
    }
    (local ?? root).querySelectorAll<HTMLElement>(local ? ".wr-beat" : ".wr-beat .wr-beat").forEach(function (inner) {
      found = true;
      inner.replaceWith(...Array.from(inner.childNodes));
    });
    return found;
  }

  function syncBeatEl(el: HTMLElement, typed = false): void {
    if (ports.editingBlocked()) return;
    const rowId = el.getAttribute("data-id");
    if (!rowId) return;
    const stored = ports.storedHtml(el.innerHTML.replace(ZWSP_ALL, ""));
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
    updatePendingHeading(rowId, el, typed);
  }

  function updatePendingHeading(rowId: string, el: HTMLElement, typed = false): void {
    const eligible = isPendingHeading(ports.doc(), rowId, ports.flow);
    if (typed && eligible) headingCandidates.add(rowId);
    const isPending = eligible && headingCandidates.has(rowId);
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
    apply("inline-markdown", doc => {
      const live = doc.rows.find(item => item.id === row.id);
      const converted = live && inlineMarkdown(ports.flow.cells(live.audioText), range.head.offset);
      if (!converted) return null;
      const rows = doc.rows.map(item => item.id === row.id ? { ...item, audioText: toHtml(converted.cell) } : item);
      return { rows, sections: doc.sections as FlowEdit["sections"], removedComments: [], selection: caretAt(beatPos(row.id, converted.caret)) };
    }, range);
    pending = { pos: beatPos(row.id, made.caret), marks: withMark(typingMarks(made.cell, made.caret), made.mark, false) };
  }

  function typedInModel(text: string, at: number): void {
    const range = selection();
    if (range?.head.kind !== "beat") return;
    const beat = beatEl(range.head.rowId);
    if (beat) updatePendingHeading(range.head.rowId, beat, at < 2);
    if (/[*~]$/.test(text)) maybeInlineMarkdown();
  }

  function onInput(event: Event): void {
    if (painting) return;
    if (composing) {
      const target = elementOf(event.target as Node | null)?.closest<HTMLElement>(".wr-beat, .wr-heading")
        ?? elementOf(window.getSelection()?.focusNode ?? null)?.closest<HTMLElement>(".wr-beat, .wr-heading");
      if (target && root.contains(target)) compositionTargets.add(target);
      return;
    }
    const input = event as InputEvent;
    const sel = window.getSelection();
    const el = elementOf(sel?.anchorNode ?? null);
    const beat = el?.closest<HTMLElement>(".wr-beat") ?? null;
    const heading = el?.closest<HTMLElement>(".wr-heading") ?? null;
    const repaired = repairOrphans(beat);
    if (beat) {
      ports.beatInput?.(input, beat);
      const offset = selection()?.head.offset ?? 2;
      syncBeatEl(beat, input.inputType === "insertText" && offset - (input.data?.length ?? 0) < 2);
      if (input.inputType === "insertText" && input.data && /[*~]$/.test(input.data)) maybeInlineMarkdown();
    } else if (heading) {
      const id = heading.getAttribute("data-scene") as string;
      const name = (heading.textContent || "").replace(ZWSP_ALL, "");
      const pos = selection()?.head ?? headingPos(id, name.length);
      if (name.trim()) {
        emptyHeadings.delete(id);
        apply("rename-scene", doc => renameHeading(doc, id, name, pos.offset), null);
      } else {
        emptyHeadings.set(id, name);
      }
    }
    if (repaired) paint();
    ports.changed();
    noteSelection();
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
      const header = flowOf(doc).some(block => block.kind === "heading" && block.scene.firstSceneId === to.rowId);
      if (prev && prev.id === from.rowId && !header) return { anchor: from, head: beatPos(prev.id, beatLength(prev.id)) };
    }
    return { anchor: from, head: to };
  }

  function onlyBoundary(range: FlowRange): boolean {
    const doc = ports.doc();
    const { from, to } = orderedRange(doc, range);
    if (to.offset !== 0) return false;
    const positions = flowOf(doc).flatMap(block => block.kind === "heading"
      ? [{ pos: headingPos(block.scene.id, 0), length: headingText(block.scene).length }]
      : block.beats.map(row => ({ pos: beatPos(row.id, 0), length: cellLength(cellOf(row)) })));
    const index = positions.findIndex(item => comparePos(doc, item.pos, { ...from, offset: 0 }) === 0);
    const start = positions[index], next = positions[index + 1];
    return !!start && !!next && from.offset === start.length && comparePos(doc, next.pos, to) === 0;
  }

  function onBeforeInput(event: Event): void {
    if (event.defaultPrevented) return;
    const input = event as InputEvent;
    if (composing) return;
    const type = input.inputType;
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      ports.undo(type === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (type.startsWith("format")) {
      event.preventDefault();
      const mark = INPUT_MARKS[type];
      if (mark) format(mark, range0(input));
      return;
    }
    if (type === "insertFromPaste" || type === "insertFromDrop" || type === "deleteByCut" || type === "deleteByDrag") {
      event.preventDefault();
      return;
    }
    const range = selection();
    if (!range) return;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      const target = range0(input) ?? range;
      if (type === "insertParagraph" && isCollapsed(target) && target.head.kind === "heading" && emptyHeadings.has(target.head.sceneId)) {
        removeEmptyHeading(target.head.sceneId, range, "below");
        return;
      }
      apply(type === "insertLineBreak" ? "line-break" : "enter", doc => type === "insertLineBreak"
        ? lineBreakAt(doc, target, ports.flow)
        : isCollapsed(target) && target.head.kind === "heading"
          ? enterInHeading(doc, target.head, ports.flow)
          : isCollapsed(target) && target.head.kind === "beat" && pendingHeading === target.head.rowId
            ? finalizeHeading(doc, target.head.rowId, target.head.offset, null, ports.flow)
          : enterAt(doc, target, ports.flow), range);
      return;
    }
    if (type === "insertText" || type === "insertReplacementText") {
      const data = input.data ?? input.dataTransfer?.getData("text/plain") ?? "";
      const target = range0(input) ?? range;
      if (type === "insertText" && data && isCollapsed(range) && isCollapsed(target) &&
          range.head.kind === "beat" && comparePos(ports.doc(), range.head, target.head) !== 0 &&
          ports.settings().gapTyping === "here") {
        const row = currentBeatRow(range);
        const beat = beatEl(range.head.rowId);
        if (row && beat) {
          event.preventDefault();
          const marks = pending && comparePos(ports.doc(), pending.pos, range.head) === 0
            ? pending.marks : typingMarks(cellOf(row), range.head.offset);
          const made = typeWithMarks(ports.doc(), range.head, data, marks, ports.flow);
          const updated = made && "rows" in made ? made.rows.find(item => item.id === row.id) : null;
          if (updated && made && "rows" in made) {
            beat.innerHTML = beatHtml(ports.flow.cells(updated.audioText));
            place(made.selection);
            ports.beatInput?.(input, beat);
            syncBeatEl(beat, range.head.offset < 2);
            typedInModel(data, range.head.offset);
            ports.changed();
            noteSelection();
          }
          pending = null;
          return;
        }
      }
      if (pending && type === "insertText" && isCollapsed(target) && isCollapsed(range) &&
          comparePos(ports.doc(), pending.pos, target.head) === 0 && comparePos(ports.doc(), pending.pos, range.head) === 0 && input.data) {
        event.preventDefault();
        const marks = pending.marks;
        apply("type", doc => typeWithMarks(doc, range.head, input.data ?? "", marks, ports.flow), range);
        pending = null;
        typedInModel(input.data, range.head.offset);
        return;
      }
      pending = null;
      if (isCollapsed(target) && withinOneBeat(range) && range.head.kind === "beat" && data) {
        const beat = beatEl(range.head.rowId);
        if (beat && ports.typeAtBeatEdge?.(beat, data)) {
          event.preventDefault();
          syncBeatEl(beat);
          ports.changed();
          return;
        }
      }
      if (!isCollapsed(target) && !withinOneBeat(target)) {
        event.preventDefault();
        apply("replace-selection", doc => replaceRange(doc, target, data ? [{ text: data, marks: typingMarksFor(target, doc) }] : [], ports.flow, true), range);
        return;
      }
      if (ports.settings().gapTyping === "before" && isCollapsed(range) && range.head.kind === "beat" && range.head.offset === 0 && beatLength(range.head.rowId)) {
        const redirect = caretBeforeTick(range.head.rowId);
        if (redirect) {
          event.preventDefault();
          apply("type", doc => {
            const row = doc.rows.find(item => item.id === redirect.rowId);
            return row ? typeWithMarks(doc, beatPos(redirect.rowId, redirect.offset), input.data ?? "", typingMarks(cellOf(row), redirect.offset), ports.flow) : null;
          }, null);
          return;
        }
      }
      return;
    }
    if (!type.startsWith("delete")) return;
    const backward = type.endsWith("Backward") || type === "deleteContentBackward";
    const target = range0(input);
    const effective = target && !isCollapsed(target) ? target : range;
    const resolved = isCollapsed(range) ? resolveInBeat(effective) : effective;
    const atBoundary = isCollapsed(resolved) || onlyBoundary(effective);
    if (atBoundary && isCollapsed(range) && type === "deleteContentBackward" && range.head.offset === 0) {
      event.preventDefault();
      if (range.head.kind === "heading" && emptyHeadings.has(range.head.sceneId)) {
        removeEmptyHeading(range.head.sceneId, range, "above");
        return;
      }
      apply("backspace", doc => backspaceAt(doc, range.head, ports.flow, { tick: ports.settings().tick }), range);
      return;
    }
    if (atBoundary && isCollapsed(range) && type === "deleteContentForward") {
      const pos = range.head;
      const atEnd = pos.kind === "beat" ? pos.offset >= beatLength(pos.rowId) : (headingEl(pos.sceneId)?.textContent || "").length <= pos.offset;
      if (atEnd) {
        event.preventDefault();
        apply("delete", doc => deleteForwardAt(doc, pos, ports.flow), range);
        return;
      }
    }
    if (isCollapsed(effective)) {
      if (backward && effective.head.offset === 0) {
        event.preventDefault();
        if (effective.head.kind === "heading" && emptyHeadings.has(effective.head.sceneId)) {
          removeEmptyHeading(effective.head.sceneId, range, "above");
          return;
        }
        apply("backspace", doc => backspaceAt(doc, effective.head, ports.flow, { tick: ports.settings().tick }), range);
      }
      return;
    }
    const isHeadingOnly = resolved.anchor.kind === "heading" && resolved.head.kind === "heading" && resolved.anchor.sceneId === resolved.head.sceneId;
    if (isHeadingOnly) {
      return;
    }
    if (isCollapsed(resolved)) {
      event.preventDefault();
      apply(backward ? "backspace" : "delete", doc => backward
        ? backspaceAt(doc, range.head, ports.flow, { tick: ports.settings().tick })
        : deleteForwardAt(doc, range.head, ports.flow), range);
      return;
    }
    // why: native edits stay in the caret's beat; Chromium can aim a word delete at the next or previous beat
    const elsewhere = resolved.anchor.kind === "beat" && (range.head.kind !== "beat" || resolved.anchor.rowId !== range.head.rowId);
    if (!withinOneBeat(resolved) || coversWholeBeat(resolved) || elsewhere) {
      event.preventDefault();
      apply("delete-selection", doc => replaceRange(doc, resolved, [], ports.flow), range);
    }
  }

  function typingMarksFor(range: FlowRange, doc: FlowDoc): Marks {
    const { from } = orderedRange(doc, range);
    if (from.kind !== "beat") return {};
    const row = doc.rows.find(item => item.id === from.rowId);
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
    if (event.altKey) return;
    if (range.head.kind === "beat") {
      const beat = beatEl(range.head.rowId);
      if (beat) syncBeatEl(beat);
    }
    if (event.shiftKey && !(event.ctrlKey || event.metaKey)) {
      apply("line-break", doc => lineBreakAt(doc, range, ports.flow), range);
      return;
    }
    if (isCollapsed(range) && range.head.kind === "heading" && emptyHeadings.has(range.head.sceneId)) {
      removeEmptyHeading(range.head.sceneId, range, "below");
      return;
    }
    if (!isCollapsed(range) && ports.settings().enter === "double") {
      apply("enter", doc => enterAt(doc, range, ports.flow), range);
      return;
    }
    let caret = range;
    if (!isCollapsed(range)) {
      const cleared = apply("delete-selection", doc => replaceRange(doc, range, [], ports.flow), range);
      if (!cleared || !("selection" in cleared)) return;
      caret = cleared.selection;
    }
    const pos = caret.head;
    if (pos.kind === "heading") {
      apply("enter-heading", doc => enterInHeading(doc, pos, ports.flow), caret);
      return;
    }
    if (pendingHeading && pendingHeading === pos.rowId) {
      const row = pos.rowId;
      pendingHeading = null;
      apply("make-heading", doc => finalizeHeading(doc, row, pos.offset, null, ports.flow), caret);
      return;
    }
    if (ports.settings().enter === "double") {
      apply("enter", doc => enterAt(doc, caret, ports.flow), caret);
      return;
    }
    apply("start-paragraph", doc => startParagraph(doc, pos, ports.flow), caret);
  }

  function format(mark: MarkName, target?: FlowRange | null): void {
    const before = selection() ?? heldRange();
    if (before && !rangeFits(before)) {
      ports.heldSelection.forget();
      window.getSelection()?.removeAllRanges();
      return;
    }
    let range = target ?? before;
    if (!range) return;
    if (target && before) {
      const doc = ports.doc();
      const selected = orderedRange(doc, before);
      const intended = orderedRange(doc, target);
      if (comparePos(doc, selected.from, intended.from) === 0 && comparePos(doc, selected.to, intended.to) === 0) range = before;
    }
    place(range);
    if (isCollapsed(range)) {
      if (range.head.kind !== "beat") return;
      const row = currentBeatRow(range);
      if (!row) return;
      const base = pending && comparePos(ports.doc(), pending.pos, range.head) === 0 ? pending.marks : typingMarks(cellOf(row), range.head.offset);
      pending = { pos: range.head, marks: withMark(base, mark, !base[mark]) };
      ports.selectionMoved(range);
      return;
    }
    apply("format", doc => setMarkAcross(doc, range, mark, ports.flow), before);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
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
    if (event.altKey && !ctrl && (key === "ArrowUp" || key === "ArrowDown") && range.head.kind === "beat") {
      event.preventDefault();
      const beat = beatEl(range.head.rowId);
      if (beat) syncBeatEl(beat);
      ports.moveBeat(range, key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (withinOneBeat(range) && range.head.kind === "beat") {
      const beat = beatEl(range.head.rowId);
      if (beat && ports.beatKeydown?.(event, beat)) {
        syncBeatEl(beat);
        ports.changed();
        return;
      }
    }
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
      const offset = range.head.offset;
      const id = range.head.rowId;
      apply("join", doc => {
        const index = doc.rows.findIndex(row => row.id === id);
        const row = doc.rows[index];
        const next = doc.rows[index + 1];
        const target = offset === 0 || !next ? id : next.id;
        return row ? joinWithPrevious(doc, target, ports.flow) : null;
      }, range);
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
    if (ports.clipboard) ports.clipboard.copy(range, event.clipboardData, false);
    else event.clipboardData.setData("text/plain", logicalText(ports.doc(), range, ports.flow));
  }

  function onCut(event: ClipboardEvent): void {
    const range = selection();
    if (!range || isCollapsed(range) || !event.clipboardData) return;
    event.preventDefault();
    if (ports.clipboard) ports.clipboard.copy(range, event.clipboardData, true);
    else event.clipboardData.setData("text/plain", logicalText(ports.doc(), range, ports.flow));
    apply("cut", doc => replaceRange(doc, range, [], ports.flow), range);
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    if (!event.clipboardData) return;
    const values = new Map(Array.from(event.clipboardData.types, type => [type, event.clipboardData?.getData(type) ?? ""]));
    const data = { getData: (type: string) => values.get(type) ?? "" };
    if (composing) { queuedPastes.push(data); return; }
    pasteData(data);
  }

  function pasteData(data: Pick<DataTransfer, "getData">): void {
    const range = selection();
    const text = data.getData("text/plain");
    if (!range) return;
    const { from } = orderedRange(ports.doc(), range);
    if (from.kind === "beat" && from.offset < 2) {
      headingCandidates.delete(from.rowId);
      if (pendingHeading === from.rowId) pendingHeading = null;
    }
    const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n+/);
    apply("paste", doc => {
      const structural = ports.clipboard?.paste(range, data);
      return structural === undefined ? text ? pasteText(doc, range, paragraphs, ports.flow) : null : structural;
    }, range);
  }

  function noteSelection(): void {
    const range = selection();
    if (range) ports.heldSelection.rememberFlow(epoch, range);
    const head = range?.head;
    if (head?.kind === "beat" && headingCandidates.has(head.rowId) && isPendingHeading(ports.doc(), head.rowId, ports.flow)) {
      const row = ports.doc().rows.find(item => item.id === head.rowId);
      const lineEnd = row ? projection(cellOf(row)).indexOf("\n") : -1;
      if (lineEnd === -1 || head.offset <= lineEnd) pendingHeading = head.rowId;
    }
    const currentBeat = head && head.kind === "beat" ? head.rowId : null;
    if (range && document.activeElement === root && !composing) transitionBeat(currentBeat);
    if (pending && (!range || !isCollapsed(range) || comparePos(ports.doc(), pending.pos, range.head) !== 0)) pending = null;
    ports.beatSelection?.(currentBeat && document.activeElement === root && !composing ? beatEl(currentBeat) : null);
    ports.selectionMoved(range);
  }

  function transitionBeat(next: string | null): void {
    if (lastBeat === next) return;
    const previous = lastBeat;
    lastBeat = next;
    if (previous) {
      const beat = beatEl(previous);
      if (beat) {
        beat.classList.remove("is-current");
        const before = selection();
        ports.leaveBeat?.(beat);
        syncBeatEl(beat);
        if (before && document.activeElement === root) {
          const after = selection();
          if (!after || comparePos(ports.doc(), before.anchor, after.anchor) !== 0 ||
              comparePos(ports.doc(), before.head, after.head) !== 0) place(before);
        }
      }
    }
    if (next) beatEl(next)?.classList.add("is-current");
  }

  function onHostBlur(event: Event): void {
    const next = (event as FocusEvent).relatedTarget;
    if (!next || next === document.body || composing) return;
    transitionBeat(null);
    leavePendingHeading(true);
    leaveEmptyHeadings(true);
    ports.beatSelection?.(null);
  }

  function removeEmptyHeading(id: string, range: FlowRange | null, landing: "above" | "below" | "keep"): void {
    emptyHeadings.delete(id);
    const before = caretAt(headingPos(id, 0));
    apply("remove-empty-heading", doc => emptyHeadingEdit(doc, id, range, landing, ports.flow), before, document.activeElement === root);
  }

  function leaveEmptyHeadings(force = false): void {
    if (composing || mouseDown) return;
    const range = selection();
    if (!force && !range) return;
    for (const [id] of emptyHeadings) {
      if (!force && range?.head.kind === "heading" && range.head.sceneId === id) continue;
      removeEmptyHeading(id, range, "keep");
    }
  }

  function leavePendingHeading(force = false): void {
    if (!pendingHeading || mouseDown || composing) return;
    const range = selection() ?? heldRange();
    if (!force) {
      if (!range || document.activeElement !== root) return;
      const block = flowOf(ports.doc()).find(item => item.kind === "paragraph" && item.beats.some(row => row.id === pendingHeading));
      const at = range.head;
      if (block?.kind === "paragraph" && at.kind === "beat" && block.beats.some(row => row.id === at.rowId)) {
        const first = block.beats.find(row => row.id === pendingHeading);
        const lineEnd = first ? projection(cellOf(first)).indexOf("\n") : -1;
        if (lineEnd === -1 || (at.rowId === pendingHeading && at.offset <= lineEnd)) return;
      }
    }
    const row = pendingHeading;
    pendingHeading = null;
    apply("make-heading", doc => finalizeHeading(doc, row, null, range, ports.flow), range, document.activeElement === root);
  }

  function prepareVisual(range: FlowRange): FlowRange | null {
    if (!pendingHeading || composing || !withinOneBeat(range) || range.head.kind !== "beat") return range;
    const row = pendingHeading;
    const target = range.head;
    pendingHeading = null;
    const outcome = apply("make-heading", doc => {
      const result = finalizeHeading(doc, row, null, range, ports.flow);
      if (!result || !("selection" in result)) return result;
      if (result.rows.some(beat => beat.id === target.rowId)) {
        const selected = result.selection;
        return withinOneBeat(selected) && selected.head.kind === "beat" && selected.head.rowId === target.rowId
          ? result : { ...result, selection: caretAt(beatPos(target.rowId, 0)) };
      }
      const oldScenes = new Set(flowOf(doc).flatMap(block => block.kind === "heading" ? [block.scene.id] : []));
      const heading = result.sections?.find(scene => !oldScenes.has(scene.id));
      return heading ? { ...result, selection: caretAt(headingPos(heading.id, Math.min(heading.name.length, Math.max(0, target.offset - 2)))) } : result;
    }, range);
    if (!ports.doc().rows.some(beat => beat.id === target.rowId)) return null;
    return outcome && "selection" in outcome ? outcome.selection : range;
  }

  function onSelectionChange(): void {
    if (painting) return;
    noteSelection();
    leavePendingHeading();
    if (document.activeElement === root) leaveEmptyHeadings();
  }

  function onCompositionStart(): void { composing = true; }

  function onCompositionEnd(): void {
    composing = false;
    syncComposition();
    ports.changed();
    if (repaintOwed) repaint();
    for (const data of queuedPastes.splice(0)) pasteData(data);
  }

  function syncComposition(): void {
    if (composing || syncingComposition) return;
    syncingComposition = true;
    try {
      const at = selection()?.head;
      const targets = Array.from(compositionTargets).filter(el => root.contains(el));
      const headings = targets.filter(el => el.classList.contains("wr-heading")).map(el => ({
        id: el.getAttribute("data-scene") as string, name: (el.textContent ?? "").replace(ZWSP_ALL, "")
      }));
      repairOrphans();
      for (const el of targets) {
        if (el.classList.contains("wr-beat") && root.contains(el)) syncBeatEl(el, true);
      }
      for (const { id, name } of headings) {
        if (!name.trim()) { emptyHeadings.set(id, name); continue; }
        emptyHeadings.delete(id);
        const offset = at?.kind === "heading" && at.sceneId === id ? at.offset : name.length;
        apply("rename-scene", doc => renameHeading(doc, id, name, offset), null);
      }
      compositionTargets.clear();
    } finally {
      syncingComposition = false;
    }
  }

  function finish(): FlowRange | null {
    const at = selection() ?? heldRange();
    composing = false;
    syncComposition();
    for (const data of queuedPastes.splice(0)) pasteData(data);
    transitionBeat(null);
    leavePendingHeading(true);
    leaveEmptyHeadings(true);
    return at && rangeExists(at) ? at : heldRange();
  }

  function onMouseDown(event: Event): void {
    if (!composing && beatMenu.openAtTick(event as MouseEvent)) return;
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
    if (document.activeElement === root) leaveEmptyHeadings();
  }

  function toOwnBeat(range: FlowRange): string | null {
    if (isCollapsed(range)) return range.head.kind === "beat" ? range.head.rowId : null;
    if (!withinOneBeat(range) || range.head.kind !== "beat") return null;
    const outcome = apply("own-beat", doc => selectionToOwnBeat(doc, range, ports.flow), range);
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
      const stored = ports.storedHtml(el.innerHTML.replace(ZWSP_ALL, ""));
      const shown = projection(ports.decode(stored));
      const held = projection(cellOf(row));
      if (shown !== held) problems.push("beat " + row.id + " shows " + JSON.stringify(shown) + " but holds " + JSON.stringify(held));
    });
    root.querySelectorAll(":scope > .wr-par > :not(.wr-beat)").forEach(() => problems.push("stray element in a paragraph"));
    root.querySelectorAll(":scope > .wr-par").forEach(par => {
      par.childNodes.forEach(node => { if (isText(node) && node.data.replace(ZWSP_ALL, "")) problems.push("stray text in a paragraph: " + node.data); });
    });
    return problems;
  }

  function sceneOf(sceneId: string): { readonly name: string } | null {
    const doc = ports.doc();
    for (const block of flowOf(doc)) if (block.kind === "heading" && block.scene.id === sceneId) return { name: headingText(block.scene) };
    return null;
  }

  const buffered = ports.bufferedText ? createWriterBuffer(ports.bufferedText, {
    root, base: rowId => paintedBeats?.base(rowId) ?? null,
    painted: rowId => paintedBeats?.text(rowId),
    normalize: () => {
      const focus = elementOf(window.getSelection()?.focusNode ?? null);
      repairOrphans(focus?.closest<HTMLElement>(".wr-beat") ?? null);
    },
    reset: rowId => {
      const heading = bufferedFieldTarget(rowId);
      if (heading?.field === "heading") {
        const el = headingEl(heading.owner), scene = sceneOf(heading.owner);
        if (el && scene) { el.textContent = scene.name; paintedBeats?.field(rowId, scene.name); }
        return;
      }
      const el = beatEl(rowId), row = ports.doc().rows.find(row => row.id === rowId);
      if (!el) return;
      if (!row) { el.remove(); return; }
      const runs = cellOf(row), html = beatHtml(runs);
      el.innerHTML = html; rendered.set(el, html);
      decorate(el, row, el.getAttribute("data-num") ?? "");
      paintedBeats?.field(rowId, projection(runs));
    },
    runs: beat => beat.classList.contains("wr-heading") ? [{ text: (beat.textContent ?? "").replace(ZWSP_ALL, ""), marks: {} }]
      : ports.decode(ports.storedHtml(beat.innerHTML.replace(ZWSP_ALL, ""))),
    selection: () => selection(true), repaint: rowId => {
      const el = beatEl(rowId); if (el) rendered.delete(el);
      repaint();
    },
    unsettled: (key, text) => bufferedFieldTarget(key)?.field !== "heading" ? null
      : !cappedText(text, SCENE_NAME_MAX) ? { reason: "buffer-heading-empty", hold: true }
        : Array.from(text).length > SCENE_NAME_MAX ? { reason: "buffer-heading-length", hold: false } : null,
    composition: value => { if (value !== undefined) composing = value; return composing; },
    restore: (rowId, offsets) => {
      const heading = bufferedFieldTarget(rowId);
      const exists = heading?.field === "heading" ? sceneOf(heading.owner) !== null : ports.doc().rows.some(row => row.id === rowId);
      if (offsets) place(offsets);
      else if (!exists) {
        const first = ports.doc().rows[0];
        if (first) place(caretAt(beatPos(first.id, 0)));
      }
    },
    changed: ports.changed
  }) : null;
  // why: an empty heading stays held until a keystroke gives it text, so a key that only types must not settle it
  const typingKey = (key: KeyboardEvent): boolean => !key.metaKey && key.ctrlKey === key.altKey
    && (Array.from(key.key).length === 1 || ["Shift", "CapsLock", "AltGraph", "Dead"].includes(key.key));
  const ready = (event: Event): boolean => {
    if (!buffered || buffered.finish()) return true;
    event.preventDefault(); return false;
  };
  const clipboardActions = {
    copy: buffered ? (event: ClipboardEvent) => {
      if (composing) {
        const range = selection(true), selected = range && domRange(range);
        if (selected && event.clipboardData) { event.preventDefault(); event.clipboardData.setData("text/plain", selected.toString()); }
      } else if (ready(event)) onCopy(event);
    } : onCopy,
    cut: buffered ? (event: ClipboardEvent) => { if (ready(event)) onCut(event); } : onCut,
    paste: buffered ? (event: ClipboardEvent) => { if (ready(event)) onPaste(event); } : onPaste
  };
  const listeners: [EventTarget, string, EventListener][] = [
    [root, "beforeinput", buffered ? event => {
      const input = event as InputEvent, native = typeof input.getTargetRanges === "function" ? range0(input) : null;
      if (!buffered.beforeInput(input, selection(true), native)) onBeforeInput(event);
    } : onBeforeInput],
    [root, "input", buffered ? event => {
      buffered.input();
      const input = event as InputEvent;
      if (!buffered.dirty() && input.inputType === "insertText" && input.data && /[*~]$/.test(input.data)) maybeInlineMarkdown();
      if (!buffered.dirty()) noteSelection();
    } : onInput],
    [root, "keydown", buffered ? event => {
      const key = event as KeyboardEvent;
      if (composing || key.isComposing || key.keyCode === 229) {
        const range = selection(true), at = range?.head;
        const beat = at?.kind === "beat" ? beatEl(at.rowId) : null;
        const boundary = at?.kind === "beat" && (key.key === "Backspace" && at.offset === 0
          || key.key === "Delete" && beat !== null && at.offset === domKeys(beat).length);
        const command = key.key === "Tab" || key.key === "Enter" && !key.isComposing && key.keyCode !== 229
          || (key.ctrlKey || key.metaKey) && /^[zybiuvx]$/i.test(key.key)
          || key.altKey && ["ArrowUp", "ArrowDown", "Backspace"].includes(key.key) || boundary;
        if (composing && command) ready(event);
        return;
      }
      buffered.keydown(key);
      if (buffered.held() && typingKey(key)) return;
      if (ready(event)) onKeydown(key);
    } : onKeydown as EventListener],
    ...ports.clipboard ? [] : [
      [root, "copy", clipboardActions.copy as EventListener] as [EventTarget, string, EventListener],
      [root, "cut", clipboardActions.cut as EventListener] as [EventTarget, string, EventListener],
      [root, "paste", clipboardActions.paste as EventListener] as [EventTarget, string, EventListener]
    ],
    [root, "compositionstart", buffered ? event => { buffered.start(event, selection(true)); } : onCompositionStart],
    [root, "compositionend", buffered ? event => { buffered.end(event as CompositionEvent); } : onCompositionEnd],
    [root, "mousedown", onMouseDown],
    [root, "focusout", buffered ? event => { if (!composing && ready(event)) onHostBlur(event); } : onHostBlur],
    ...buffered ? [[root, "drop", ((event: Event) => { ready(event); event.preventDefault(); }) as EventListener] as [EventTarget, string, EventListener],
      [root, "focusin", (() => {}) as EventListener] as [EventTarget, string, EventListener]] : [],
    [window, "mouseup", onMouseUp],
    [document, "selectionchange", buffered ? () => { if (!buffered.dirty()) onSelectionChange(); } : onSelectionChange]
  ];
  const guarded = buffered ? listeners.map(([target, name, handler]): [EventTarget, string, EventListener] =>
    [target, name, event => { buffered.native(event, () => handler(event)); }]) : listeners;
  guarded.forEach(([target, name, handler]) => target.addEventListener(name, handler));
  const clipboardHandlers = buffered ? {
    copy: (event: ClipboardEvent) => { buffered.native(event, () => clipboardActions.copy(event)); },
    cut: (event: ClipboardEvent) => { buffered.native(event, () => clipboardActions.cut(event)); },
    paste: (event: ClipboardEvent) => { buffered.native(event, () => clipboardActions.paste(event)); }
  } : clipboardActions;
  const stopClipboard = ports.clipboard?.mount(clipboardHandlers);

  return {
    ...(buffered ? { settle: buffered.finish } : {}),
    finish: buffered ? () => buffered.finish() ? finish() : selection(true) : finish,
    paint: buffered ? () => { if (buffered.canPaint()) paint(); } : paint,
    repaint: buffered ? () => { if (buffered.canPaint()) repaint(); } : repaint,
    refreshBeat: rowId => {
      if (composing || syncingComposition || buffered && !buffered.canPaint()) { repaintOwed = true; return; }
      const el = beatEl(rowId);
      const row = ports.doc().rows.find(beat => beat.id === rowId);
      if (el && row) decorate(el, row, el.getAttribute("data-num") ?? "");
    },
    focusBack,
    selection: () => selection() ?? heldRange(),
    place,
    restoreAfterReplay: range => {
      pendingHeading = null;
      if (emptyHeadings.size) {
        emptyHeadings.clear();
        paint();
      }
      place(range, true);
    },
    prepareVisual,
    format: buffered ? mark => { if (buffered.finish()) format(mark); } : format,
    pendingMarks: () => pending ? pending.marks : null,
    apply: buffered ? (name, operation, before) => buffered.finish() ? apply(name, operation, before) : null : apply,
    toOwnBeat,
    domRange,
    domCheck,
    paintedBase: rowId => buffered?.base(rowId) ?? (paintedBeats ? paintedBeats.base(rowId) : null),
    dispose: () => {
      if (buffered && !buffered.dispose()) return;
      stopClipboard?.();
      beatMenu.dispose();
      paintedBeats?.clear();
      if (ports.lifetime.epoch() === epoch) ports.heldSelection.forget();
      compositionTargets.clear();
      queuedPastes.length = 0;
      guarded.forEach(([target, name, handler]) => target.removeEventListener(name, handler));
    }
  };
}
