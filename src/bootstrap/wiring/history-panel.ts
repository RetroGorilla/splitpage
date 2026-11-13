import { startHistoryPanel } from "../../features/history/panel.ts";
import type { HistoryPanelControl, HistoryPanelPorts } from "../../features/history/ports.ts";
import { historyActions as definitions } from "../../features/history/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { historyOwner } from "./history.ts";
import type { SessionMergeOwner } from "../../application/session/session-merge-ports.ts";
import { documentReader } from "./ports/document.ts";
import { panelControl as panels } from "./ports/panels.ts";
import { notices } from "./ports/effects.ts";
import { personColors } from "./ports/person-colors.ts";
import { historyPreferences } from "./ports/preferences.ts";
import { ids } from "./ports/identity.ts";
import { screen } from "./ports/screen.ts";
import { capabilities } from "./ports/capabilities.ts";

const panel = owned<HistoryPanelControl>();
export function historyPanelControls(): HistoryPanelControl {
  const current = panel.owner();
  if (!current) throw new Error("The history panel is not started yet");
  return current;
}
export function mountHistoryPanelFeature(merge: Pick<SessionMergeOwner, "restoreMergeSnapshot">): HistoryPanelControl {
  return panel.replace(() => {
    const ports: HistoryPanelPorts = {
      capability: capabilities,
      history: { listDocHistory: (...args) => historyOwner().listDocHistory(...args) },
      document: documentReader,
      merge: { restoreMergeSnapshot: (...args) => merge.restoreMergeSnapshot(...args) },
      panels, effects: notices, personColors, ids,
      preferences: historyPreferences
    };
    return startHistoryPanel(ports);
  });
}
export const stopHistoryPanelFeature = panel.stop;
export const historyActions = () => definitions(historyPanelControls, screen);
export const renderHistory = () => historyPanelControls().renderHistory();
export const restoreSnapshotFromCard: HistoryPanelControl["restoreSnapshotFromCard"] = (...args) => historyPanelControls().restoreSnapshotFromCard(...args);
export const toastLastEditor: HistoryPanelControl["toastLastEditor"] = (...args) => { historyPanelControls().toastLastEditor(...args); };
