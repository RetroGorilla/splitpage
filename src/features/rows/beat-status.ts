import type { CommandOutcome } from "../../application/session/document-session.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ShotHiding } from "../../application/shot-hiding.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { SessionChange } from "../../application/session/change-set.ts";
import { beatStatus, beatStatusCommand, setBeatFilmedCommand, shotGrace } from "../../application/commands/beat-status.ts";
import { targetLengthOf } from "../../core/document/timing.ts";
import { formatDuration, rowSeconds, targetClock, totalSeconds } from "../../core/production/timing.ts";

interface BeatStatusPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "run" | "stamps">;
  readonly text: Pick<TextServices, "productionReaders">;
  readonly hideShot: () => boolean;
  readonly shots: Pick<ShotHiding, "armGrace" | "clearGrace">;
  readonly element: (id: string) => HTMLElement | null;
}

export interface BeatStatus {
  readonly updateScriptStats: () => void;
  readonly statsFollowChange: (change: SessionChange) => void;
  readonly onScriptStats: (listener: (targetSeconds: number) => void) => () => void;
  readonly cycleRowStatus: (rowId: string) => void;
  readonly setFilmed: (rowId: string, filmed: boolean) => void;
}

const LENGTH_TITLE = "The script's read time, from the Audio column — click to set your reading speed or a target length";

function paintLength(el: HTMLElement | null, totalHtml: string, slotHtml: string, title: string): void {
  if (!el) return;
  const totalEl = el.querySelector(".rd-length-total");
  const slotEl = el.querySelector(".rd-length-slot");
  if (totalEl && totalEl.innerHTML !== totalHtml) totalEl.innerHTML = totalHtml;
  if (slotEl && slotEl.innerHTML !== slotHtml) slotEl.innerHTML = slotHtml;
  if (el.title !== title) el.title = title;
}

export function createBeatStatus(ports: BeatStatusPorts): BeatStatus {
  const statsListeners: ((targetSeconds: number) => void)[] = [];

  function updateScriptStats(): void {
    const doc = ports.document.current();
    if (!doc) return;
    const readers = ports.text.productionReaders;
    const target = targetLengthOf({ targetSeconds: doc["targetSeconds"] });
    const total = totalSeconds(doc, readers);
    const remaining = ports.hideShot() ? doc.rows.reduce(function (n, r) {
      return n + (r.status === "shot" ? 0 : rowSeconds(r, doc, readers));
    }, 0) : 0;
    const totalText = formatDuration(total);
    let totalHtml = totalText;
    let slotHtml = "";
    let title = LENGTH_TITLE;
    if (target) {
      const tc = targetClock(total, target);
      slotHtml = '<span class="rd-length-of"> / ' + tc.target + '</span>' +
        '<span class="rd-length-delta' + (tc.over ? ' is-over' : '') + '">' +
        tc.delta + (tc.over ? ' over' : ' left') + '</span>';
      title = "Read time " + totalText + " against a " + tc.target + " target, " +
        tc.delta + (tc.over ? " over" : " left") +
        (ports.hideShot() ? " (" + formatDuration(remaining) + " still to film)" : "") +
        " — click to change the target or your reading speed";
    } else if (ports.hideShot()) {
      totalHtml = formatDuration(remaining) + '<span class="rd-length-of"> / ' + totalText + '</span>';
      title = formatDuration(remaining) + " still to film of " + totalText +
        " — click to set your reading speed or a target length";
    }
    paintLength(ports.element("runtime-chip"), totalHtml, slotHtml, title);
    paintLength(ports.element("length-status"), totalHtml, slotHtml, title);
    statsListeners.slice().forEach(function (listener) { listener(target || 0); });

    const chip = ports.element("progress-chip");
    const text = ports.element("progress-text");
    const toggle = ports.element("hide-shot-toggle");
    if (!chip || !text) return;
    const rows = doc.rows;
    const shot = rows.filter(function (r) { return r.status === "shot"; }).length;
    const shown = shot > 0 || ports.hideShot();
    chip.hidden = !shown;
    if (toggle) toggle.hidden = !shown && toggle.ownerDocument.activeElement !== toggle;
    if (shown) text.textContent = shot + "/" + rows.length + " filmed";
  }

  return {
    setFilmed: function (rowId, filmed) {
      const before = ports.document.read(beatStatus(rowId));
      const outcome = ports.edits.run(setBeatFilmedCommand(rowId, filmed, ports.edits.stamps));
      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind !== "applied" && outcome.kind !== "committed") return;
      if (ports.hideShot()) {
        const grace = shotGrace(before, ports.document.read(beatStatus(rowId)));
        if (grace === "arm") ports.shots.armGrace(rowId);
        else if (grace === "clear") ports.shots.clearGrace(rowId);
      }
    },
    updateScriptStats,
    statsFollowChange: function (change) {
      const changes = change.changes;
      if (changes.docFields.indexOf("targetSeconds") !== -1 || changes.cells.some(function (cell) { return cell.field === "status" || cell.field === "lengthSeconds"; })) updateScriptStats();
    },
    onScriptStats: function (listener) {
      statsListeners.push(listener);
      return function () {
        const at = statsListeners.indexOf(listener);
        if (at !== -1) statsListeners.splice(at, 1);
      };
    },
    cycleRowStatus: function (rowId) {
      const before = ports.document.read(beatStatus(rowId));
      const outcome: CommandOutcome = ports.edits.run(beatStatusCommand(rowId, ports.edits.stamps));
      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind !== "applied" && outcome.kind !== "committed") return;
      if (ports.hideShot()) {
        const grace = shotGrace(before, ports.document.read(beatStatus(rowId)));
        if (grace === "arm") ports.shots.armGrace(rowId);
        else if (grace === "clear") ports.shots.clearGrace(rowId);
      }
    }
  };
}
