import { startWriter } from "../../features/writer/writer.js";
import { writerActions as definitions } from "../../features/writer/actions.ts";
import type { WriterFeaturePorts } from "../../features/writer/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader, refresh } from "./ports/document.ts";
import { edits, writerEditing, writerUndo } from "./ports/editing.ts";
import { text } from "./ports/text.ts";
import { writerPanels } from "./ports/panels.ts";
import { writerPreferences, writerView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { actions } from "./ports/actions.ts";
import { screen } from "./ports/screen.ts";
import { splitRowFieldCore } from "./rows.ts";
import { hiddenShotStripHtml } from "../../features/rows/hide-shot.ts";
import { currentHideShot } from "./hide-shot.ts";
import { sectionHeaderHtml, sectionRowEntries } from "../../features/rows/section-rows.ts";
import { sectionGroups } from "../../core/document/sections.ts";
import { formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { sectionView } from "./editor-owners.ts";
import { shotHiding } from "./shot-hiding.ts";
import { currentRowsRender } from "./render.ts";
import { hideTagGhost, scheduleIdleRefresh } from "../../features/tags/production-tags.ts";

const writer = owned<ReturnType<typeof startWriter>>();
const connections = new Set<(control: ReturnType<typeof startWriter> | null) => void>();

export function connectWriter(controlChanged: (control: ReturnType<typeof startWriter> | null) => void): () => void {
  connections.add(controlChanged);
  controlChanged(writer.owner());
  return () => {
    if (!connections.delete(controlChanged)) return;
    controlChanged(null);
  };
}

export function mountWriterRuntimeFeature() {
  return writer.replace(() => {
    const render = currentRowsRender();
    if (!render) throw new Error("Writer needs the row renderer to be mounted");
    const ports: WriterFeaturePorts = {
      document: documentReader, edits, text, editing: writerEditing, undo: writerUndo,
      rows: { splitField: splitRowFieldCore },
      hiding: { renderGroups: (rows, renderRow) => {
        const doc = documentReader.current();
        if (!doc) return "";
        if (!Array.isArray(doc.sections) || !doc.sections.length) return currentHideShot()?.renderGroups(rows, renderRow) ?? "";
        const totals = new Map(sectionGroups(doc).map(group => [group.section.id,
          formatDuration(doc.rows.slice(group.start, group.end).reduce((sum, row) => sum + rowSeconds(row, doc, text.productionReaders), 0))]));
        return sectionRowEntries({ rows, sections: doc.sections }, shotHiding(), sectionView()).map(item =>
          "section" in item ? sectionHeaderHtml(item, !edits.allowed(), totals.get(item.section.id) ?? "") :
            "strip" in item ? hiddenShotStripHtml(item.strip) : renderRow(item.row, item.index)).join("");
      } },
      panels: writerPanels, preferences: writerPreferences, view: writerView, notices, actions,
      formatting: {
        state: render.cellFormatState,
        direction: render.toggleCellDirection,
        toggle: render.toggleCellFormat
      },
      dismissTagGhost: hideTagGhost, scheduleStats: scheduleIdleRefresh,
      cancelStats: () => { refresh.cancel(["writerStats"]); }
    };
    const mounted = startWriter(ports);
    const control = { ...mounted, dispose: () => {
      if (writer.owner() === control) writer.stop();
      else mounted.dispose();
    } };
    return control;
  }, (control) => [() => {
    for (const connected of connections) connected(control);
    return () => { for (const connected of connections) connected(null); };
  }]);
}

export const stopWriterRuntimeFeature = writer.stop;
export const writerControls = writer.owner;

export function writerActions() {
  return definitions(writer.owner, { screen });
}
