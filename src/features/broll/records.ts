import { resetBrollAnchoring } from "../../application/broll-anchoring.ts";
import { addShotPropCommand } from "../../application/commands/broll-records.ts";
import { cellRuns, cellTextCommand } from "../../application/commands/cell-text.ts";
import { rewriteCellsCommand } from "../../application/commands/document-edit.ts";
import type { CellRewrite } from "../../application/commands/document-edit.ts";
import { brollSeedOf } from "../../application/production/broll-records.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import { BROLL_CLOSERS, BROLL_MARKER_RE, BROLL_STATUS_IDS } from "../../core/document/broll.ts";
import type { BrollStatusId } from "../../core/document/broll.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { brollEntries as readBrollEntries, brollMarkerLines, brollSortedForList } from "../../core/production/broll.ts";
import type { BrollEntry } from "../../core/production/broll.ts";
import { holdsMedia } from "../../core/production/tags.ts";
import { deleteRange, insertBrollKey, insertText, replaceWithBrollKey } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { projection } from "../../core/text/runs.ts";
import { isInsideTagOrLink } from "../common/dom.ts";
import type { BrollRecordsMount, BrollRecordsPorts } from "./ports.ts";

export interface BrollStatusLook {
  readonly id: BrollStatusId;
  readonly label: string;
  readonly color: string;
}

const BROLL_STATUS_LOOKS: Record<BrollStatusId, { readonly label: string; readonly color: string }> = {
  unshot: { label: "To shoot", color: "var(--text-dim)" },
  shot: { label: "Shot", color: "var(--ok)" }
};

export const BROLL_STATUSES: readonly BrollStatusLook[] = BROLL_STATUS_IDS.map(function (id) {
  const look = BROLL_STATUS_LOOKS[id];
  return { id: id, label: look.label, color: look.color };
});

export function brollStatus(id: unknown): BrollStatusLook | null {
  for (let i = 0; i < BROLL_STATUSES.length; i++) {
    if (BROLL_STATUSES[i]?.id === id) return BROLL_STATUSES[i] ?? null;
  }
  return null;
}

function brollAtLineStart(node: Node): boolean {
  if (node.nodeType !== 3) return false;
  const parentEl = node.parentNode as Element | null;
  const cell = parentEl && parentEl.closest ? parentEl.closest(".cell-editable") : null;
  if (!cell) return false;

  let n: Node = node;
  while (true) {
    let prev = n.previousSibling;
    while (prev && prev.nodeType === 3 && !(prev.nodeValue || "").trim()) prev = prev.previousSibling;
    if (prev) return prev.nodeType === 1 && (prev as Element).tagName === "BR";
    const parent = n.parentNode;
    if (parent === cell) return true;
    if (!parent || parent.nodeType !== 1) return false;
    n = parent;
  }
}

export function createBrollRecords(ports: BrollRecordsPorts): BrollRecordsMount {
  resetBrollAnchoring();

  function brollRow(rowId: string | null) {
    const i = rowId ? ports.document.read(function (doc) { return rowIndexOf(doc, rowId); }) : -1;
    const doc = ports.document.current();
    return i === -1 || !doc ? null : doc.rows[i] ?? null;
  }

  function brollEntries(): BrollEntry[] {
    const doc = ports.document.current();
    return doc ? readBrollEntries(doc, ports.text.productionReaders, ports.ids, ports.text.htmlToPlainText) : [];
  }

  function brollUnshotCount(): number {
    if (!ports.document.current()?.brollShots) return 0;
    return brollEntries().filter(function (e) { return e.status !== "shot"; }).length;
  }

  function scheduleBrollRefresh(): void {
    ports.refresh("broll");
  }

  function brollRenamed(doc: DocumentView, entry: BrollEntry, newName: string): CellRewrite[] {
    const row = doc.rows[rowIndexOf(doc, entry.rowId)];
    if (!row) return [];
    const html = row.visualText;
    const target = entry.ordinal >= 0 ? brollMarkerLines(ports.text.cellOf(html))[entry.ordinal] : null;
    if (!target) return [];
    const keyText = target.marker.key ? (target.marker.key.text || "B-roll:") : "B-roll:";

    if (holdsMedia(html)) {
      const body = ports.text.inertBody(html);
      const line = ports.anchors.htmlLines(body)[target.index];
      if (!line) return [];
      const holder = document.createElement("div");
      holder.innerHTML = ports.anchors.keyHtml(entry.id, keyText) + " " + escapeHtml(newName);
      line.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      Array.prototype.slice.call(holder.childNodes).forEach(function (n: Node) {
        body.insertBefore(n, line.br);
      });
      return [{ rowId: row.id, field: "visualText", html: ports.text.sanitizeHtml(body.innerHTML) }];
    }

    const at = target.line.start;
    let cell = deleteRange(ports.text.cellOf(html), at, target.line.end);
    cell = insertBrollKey(cell, at, entry.id, keyText, {});
    cell = insertText(cell, at + 1, " " + newName, {});
    return [{ rowId: row.id, field: "visualText", html: toHtml(cell) }];
  }

  return {
    brollEntries,
    scheduleBrollRefresh,
    addBrollProp: function (shotId, rawName) {
      return ports.edits.edit(addShotPropCommand(shotId, rawName));
    },
    brollShotsByProp: function () {
      const out: Record<string, string[]> = Object.create(null);
      if (!ports.document.current()?.brollShots) return out;
      brollSortedForList(brollEntries()).forEach(function (e) {
        e.props.forEach(function (p) {
          const k = "prop " + normalizeTagName(p.name);
          if (!out[k]) out[k] = [];
          out[k].push(e.name || "Untitled shot");
        });
      });
      return out;
    },
    maybeCaptureBroll: function (e, cellEl) {
      if (e.inputType !== "insertText" || !e.data) return;
      if (cellEl.getAttribute("data-field") !== "visualText") return;
      if (BROLL_CLOSERS.indexOf(e.data.charAt(e.data.length - 1)) === -1) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const offset = range.startOffset;
      if (!brollAtLineStart(node)) return;
      if (isInsideTagOrLink(node.parentNode as Element | null)) return;
      const head = (node as Text).data.slice(0, offset);
      const m = BROLL_MARKER_RE.exec(head);
      if (!m || m[0].length !== head.length) return;

      const id = ports.ids.id("bs"), keyText = (m[1] ?? "") + (m[2] ?? "");
      ports.cells.edit(cellEl, function (cell) {
        const from = ports.position(cellEl, node, 0), to = ports.position(cellEl, node, offset);
        if (from === null || to === null) return null;
        if (projection(cell).slice(from, to) !== head.replace(/\u200B/g, "")) return null;
        const r = replaceWithBrollKey(cell, from, to, id, keyText);
        const row = brollRow(cellEl.getAttribute("data-id"));
        return { cell: r.cell, sel: { from: r.end, to: r.end }, records: { shots: [{ id: id, ...brollSeedOf(row, ports.text) }] } };
      });
      scheduleBrollRefresh();
    },
    anchorBrollInLeftCell: function (cellEl) {
      if (!ports.document.current() || cellEl.getAttribute("data-field") !== "visualText") return 0;
      const row = brollRow(cellEl.getAttribute("data-id"));
      if (!row) return 0;
      const copy = { id: row.id, visualText: row.visualText };
      const n = ports.anchors.inRows([copy]);
      if (!n) return 0;
      const took = ports.paint.whileShown(function () {
        const outcome = ports.edits.run(cellTextCommand(row.id, "visualText", cellRuns(ports.scriptCellOf(copy.visualText)), ports.edits.text));
        if (outcome.kind === "failed") throw outcome.error;
        if (outcome.kind !== "applied" && outcome.kind !== "committed") return false;
        cellEl.innerHTML = row.visualText ?? "";
        ports.caretSpot(cellEl);
        return true;
      });
      if (!took) return 0;
      scheduleBrollRefresh();
      return n;
    },
    renameBrollInScript: function (entry, newName) {
      const planned = ports.document.read(function (doc) { return doc ? brollRenamed(doc, entry, newName) : []; });
      if (!planned.length) return false;
      ports.edits.edit(rewriteCellsCommand("rename-broll-shot", function (doc) { return brollRenamed(doc, entry, newName); }, ports.edits.stamps, { needs: "edit", stamped: false }));
      return true;
    },
    updateBrollBadge: function () {
      const badge = document.getElementById("broll-badge");
      if (!badge || !ports.document.current()) return;
      const n = brollUnshotCount();
      if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
      else badge.hidden = true;
    },
    dispose: function () {}
  };
}
