import type { LengthHolder } from "../../core/document/timing.ts";
import { hasSetLength, parseBeatLength } from "../../core/document/timing.ts";
import { estimatedSeconds, formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { cssAttr } from "../common/dom.ts";
import { beatAt, beatLengthCommand } from "../../application/commands/beat-length.ts";

import type { ReadTimePorts } from "./ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

interface ReadTimeEditor {
 rowId: string | null;
 btn: HTMLElement;
 input: HTMLInputElement;
 prefill: string;
 wasSet: boolean;
}
type ReadTimeDocument = Pick<DocumentView, "rows">;
type ReadTimeNullableIdArgs<T extends readonly unknown[]> = T extends [infer Id, ...infer Rest] ? [Id | null, ...Rest] : never;
type ReadTimeBeatAt = (...args: ReadTimeNullableIdArgs<Parameters<typeof beatAt>>) => ReturnType<typeof beatAt>;
type ReadTimeLengthCommand = (...args: ReadTimeNullableIdArgs<Parameters<typeof beatLengthCommand>>) => ReturnType<typeof beatLengthCommand>;
interface ReadTimePortUse extends Omit<ReadTimePorts, "document"> {
 readonly document: {
  readonly read: ReadTimePorts["document"]["read"];
  readonly numbering: ReadTimePorts["document"]["numbering"];
  readonly current: (...args: Parameters<ReadTimePorts["document"]["current"]>) => ReadTimeDocument | null;
 };
}
let ports: ReadTimePorts | null = null;
let editing: ReadTimeEditor | null = null;

export function readTimeEditing() { return editing ? editing.rowId : null; }

function applyBeatLength(rowId: string | null, seconds: number | null | undefined) {
  const outcome = (ports as ReadTimePortUse).edits.run((beatLengthCommand as ReadTimeLengthCommand)(rowId, seconds, (ports as ReadTimePortUse).edits.stamps));
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

export function setBeatLength(rowId: string | null, seconds: number | null | undefined) {
  if (!ports) return false;
  return applyBeatLength(rowId, seconds);
}

function openReadTimeEditor(btn: HTMLElement | null) {
  if (!btn || !ports) return;
  const rowId = btn.getAttribute("data-id");
  const beat = (ports as ReadTimePortUse).document.read((beatAt as ReadTimeBeatAt)(rowId));
  if (!beat) return;
  closeReadTimeEditor(false);
  const row = beat.row;
  const wasSet = hasSetLength(row as LengthHolder);
  const doc = (ports as ReadTimePortUse).document.current();
  const secs = rowSeconds(row, doc, (ports as ReadTimePortUse).text.productionReaders);
  const estimate = formatDuration(estimatedSeconds(row, doc, (ports as ReadTimePortUse).text.productionReaders));
  const prefill = wasSet || secs >= 0.5 ? formatDuration(secs) : "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "row-read-input";
  input.value = prefill;
  input.setAttribute("inputmode", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", "Beat " + ((ports as ReadTimePortUse).document.numbering().beats[row.id]?.full ?? "") + " length");
  input.placeholder = estimate;
  input.title = "A length like 1:30, 90 or 1m30s. Leave it empty to use the estimate (" + estimate + ").";
  btn.hidden = true;
  (btn.parentNode as ParentNode).insertBefore(input, btn.nextSibling);
  const rowEl = btn.closest(".row");
  if (rowEl) rowEl.classList.add("is-setting-length");
  editing = { rowId: rowId, btn: btn, input: input, prefill: prefill, wasSet: wasSet };
  input.addEventListener("keydown", onEditorKeydown);
  input.addEventListener("blur", onEditorBlur);
  input.focus();
  input.select();
}

function closeReadTimeEditor(commit: boolean, fromBlur?: boolean) {
  if (!editing) return true;
  const ed = editing;
  if (commit) {
    const text = ed.input.value.trim();
    const unchanged = text === ed.prefill;
    if (!unchanged) {
      const secs = parseBeatLength(text);
      if (typeof secs === "number" && isNaN(secs)) {
        if (!fromBlur) {
          ed.input.setAttribute("aria-invalid", "true");
          (ports as ReadTimePortUse).notices.show("That isn’t a length — try 1:30, 90 or 1m30s. Leave it empty to use the estimate.", "error");
          ed.input.select();
          return false;
        }
        (ports as ReadTimePortUse).notices.show("Beat length unchanged — “" + text + "” isn’t a length.", "error");
      } else {
        editing = null;
        teardown(ed);
        (ports as ReadTimePortUse).paint.afterThisPaint(
          function () { setBeatLength(ed.rowId, secs); },
          function () { applyBeatLength(ed.rowId, secs); }
        );
        refocus(ed, !fromBlur);
        return true;
      }
    }
  }
  editing = null;
  teardown(ed);
  refocus(ed, !fromBlur);
  return true;
}

function teardown(ed: ReadTimeEditor) {
  ed.input.removeEventListener("keydown", onEditorKeydown);
  ed.input.removeEventListener("blur", onEditorBlur);
  if (ed.input.parentNode) ed.input.parentNode.removeChild(ed.input);
  ed.btn.hidden = false;
  const rowEl = ed.btn.closest(".row");
  if (rowEl) rowEl.classList.remove("is-setting-length");
}

function refocus(ed: ReadTimeEditor, wanted: boolean) {
  if (!wanted) return;
  const btn = ed.btn.isConnected ? ed.btn
    : document.querySelector<HTMLElement>('#rows .row-read[data-id="' + cssAttr(ed.rowId) + '"]');
  if (btn) btn.focus({ preventScroll: true });
}

function onEditorKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    closeReadTimeEditor(true, false);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeReadTimeEditor(false, false);
  } else {
    e.stopPropagation();
    if (editing) editing.input.removeAttribute("aria-invalid");
  }
}

function onEditorBlur() {
  closeReadTimeEditor(true, true);
}

export function startReadTime(given: ReadTimePorts) {
  ports = given;
  const offs: (() => void)[] = [];
  let disposed = false;
  const owner = { dispose: function () {
    if (disposed) return;
    disposed = true;
    closeReadTimeEditor(false, true);
    while (offs.length) (offs.pop() as () => void)();
    ports = null;
  } };
  const rowsEl = document.getElementById("rows");
  if (!rowsEl) return owner;
  function listen<K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void) {
    (rowsEl as HTMLElement).addEventListener(type, fn);
    offs.push(function () { (rowsEl as HTMLElement).removeEventListener(type, fn); });
  }
  listen("mousedown", function (e) {
    const btn = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest<HTMLElement>(".row-read");
    if (btn) e.preventDefault();
  });
  listen("click", function (e) {
    const btn = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest<HTMLElement>(".row-read");
    if (!btn) return;
    e.preventDefault();
    openReadTimeEditor(btn);
  });
  listen("keydown", function (e) {
    if (!((e.target as HTMLElement).classList && (e.target as HTMLElement).classList.contains("row-read"))) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = String(e.key).toLowerCase();
    if (k !== "z" && k !== "y") return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) (ports as ReadTimePortUse).undo.redo(); else (ports as ReadTimePortUse).undo.undo();
  });
  return owner;
}
