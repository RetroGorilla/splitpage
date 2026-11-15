import { escapeHtml } from "../../core/document/text-policy.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { peopleOf, PERSON_NAME_MAX } from "../../core/production/records.ts";
import type { Person } from "../../core/production/records.ts";
import { typingMarks } from "../../core/text/edits.ts";
import { OBJ, projection, whoName } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { insertWho, startsWho } from "../../core/text/who.ts";
import { cellSelection } from "../common/cell-selection.ts";
import { isInsideTagOrLink } from "../common/dom.ts";
import type { WhoListMount, WhoListPorts } from "./ports.ts";

const ZWSP_RE = new RegExp(String.fromCharCode(0x200B), "g");
const LIST_MAX = 8;

interface OpenWho {
  readonly cellEl: Element;
  readonly from: number;
  query: string;
  items: string[];
  active: number;
}

export function whoOpensAt(text: string, caret: number): number | null {
  const at = caret - 1;
  if (at < 0 || text.charAt(at) !== "@") return null;
  return startsWho(text.slice(0, at)) ? at : null;
}

function folded(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

export function whoChoices(people: readonly Person[], query: string): string[] | null {
  if (query.indexOf("\n") !== -1 || query.indexOf(OBJ) !== -1 || /^\s/.test(query) || query.length > PERSON_NAME_MAX) return null;
  const want = folded(query);
  const found = people.filter(function (p) { return folded(p.name).indexOf(want) === 0; }).map(function (p) { return p.name; });
  if (/\s/.test(query) && !found.length) return null;
  const items = found.slice(0, LIST_MAX);
  const typed = whoName(query);
  if (typed && !found.some(function (n) { return normalizeTagName(n) === normalizeTagName(typed); })) items.push(typed);
  return items;
}

function isWhoCell(cellEl: Element): boolean {
  return cellEl.getAttribute("data-field") === "visualText" && !!cellEl.closest("#rows, .wr-flow-visual-box");
}

export function startWhoList(ports: WhoListPorts): WhoListMount {
  let open: OpenWho | null = null;
  let disposed = false;
  const picked: (() => void)[] = [];

  function listEl(): HTMLElement | null { return document.getElementById("who-list"); }

  function cellNow(cellEl: Element): Run[] {
    return ports.text.fromHtml(ports.text.storedHtmlFromDom(cellEl.innerHTML.replace(ZWSP_RE, "")));
  }

  function caretIn(cellEl: Element): number | null {
    if (document.activeElement !== cellEl) return null;
    const sel = cellSelection(cellEl);
    return sel && sel.from === sel.to ? sel.from : null;
  }

  function hide(): void {
    const el = listEl();
    if (el) { el.hidden = true; el.innerHTML = ""; }
  }

  function paint(o: OpenWho): void {
    const el = listEl();
    if (!el) return;
    if (!o.items.length) { hide(); return; }
    el.innerHTML = o.items.map(function (name, i) {
      return '<li role="option" class="who-option" data-i="' + i + '" aria-selected="' + (i === o.active) + '">' + escapeHtml(name) + "</li>";
    }).join("");
    el.hidden = false;
    const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
    const rect = (range && range.getClientRects()[0]) || o.cellEl.getBoundingClientRect();
    const h = el.offsetHeight, w = el.offsetWidth;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
    el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8)) + "px";
    el.style.top = top + "px";
  }

  function cancel(): void {
    open = null;
    hide();
  }

  function settle(o: OpenWho): boolean {
    if (!o.cellEl.isConnected) return false;
    const caret = caretIn(o.cellEl);
    if (caret === null || caret <= o.from) return false;
    const text = projection(cellNow(o.cellEl));
    if (text.charAt(o.from) !== "@") return false;
    const query = text.slice(o.from + 1, caret);
    const items = whoChoices(peopleOf(ports.document.current()), query);
    if (!items) return false;
    if (query !== o.query) o.active = 0;
    o.query = query;
    o.items = items;
    o.active = Math.min(o.active, Math.max(0, items.length - 1));
    return true;
  }

  function refresh(): void {
    const o = open;
    if (!o) return;
    if (settle(o)) paint(o); else cancel();
  }

  function maybeOpen(e: { inputType?: string; data?: string | null }, cellEl: Element): void {
    if (open && open.cellEl === cellEl) { refresh(); return; }
    if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== "@" || !isWhoCell(cellEl)) return;
    const node = window.getSelection()?.anchorNode;
    if (!node || isInsideTagOrLink(node.nodeType === 1 ? node as Element : node.parentElement)) return;
    const caret = caretIn(cellEl);
    if (caret === null) return;
    const from = whoOpensAt(projection(cellNow(cellEl)), caret);
    if (from === null) return;
    open = { cellEl: cellEl, from: from, query: "", items: [], active: 0 };
    refresh();
  }

  function pick(): boolean {
    const o = open;
    if (!o || !settle(o)) { cancel(); return false; }
    const name = o.items[o.active];
    cancel();
    if (!name) return false;
    const done = ports.cells.edit(o.cellEl, function (cell, sel) {
      if (!sel || sel.from !== sel.to) return null;
      const text = projection(cell);
      if (text.charAt(o.from) !== "@" || text.slice(o.from + 1, sel.from) !== o.query) return null;
      const res = insertWho(cell, o.from, sel.from, name, typingMarks(cell, o.from + 1));
      return res ? { cell: res.cell, sel: { from: res.end, to: res.end } } : null;
    });
    if (done) picked.slice().forEach(function (listener) { listener(); });
    return true;
  }

  function keydown(e: KeyboardEvent, cellEl: Element): boolean {
    const o = open;
    if (!o || o.cellEl !== cellEl || e.isComposing) return false;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return true; }
    if (!o.items.length || !plain) return false;
    if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return pick(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = o.items.length;
      o.active = (o.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      paint(o);
      return true;
    }
    return false;
  }

  function onListDown(e: MouseEvent): void {
    const item = (e.target as Element | null)?.closest?.(".who-option");
    if (!item || !open) return;
    e.preventDefault();
    open.active = Number(item.getAttribute("data-i")) || 0;
    pick();
  }

  const list = listEl();
  if (list) list.addEventListener("mousedown", onListDown);

  return {
    maybeOpen: maybeOpen,
    refresh: refresh,
    keydown: keydown,
    cancel: cancel,
    isOpen: function (cellEl) { return !!open && (!cellEl || open.cellEl === cellEl); },
    onPicked: function (listener) {
      picked.push(listener);
      return function () {
        const at = picked.indexOf(listener);
        if (at !== -1) picked.splice(at, 1);
      };
    },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      cancel();
      if (list) list.removeEventListener("mousedown", onListDown);
      picked.length = 0;
    }
  };
}
