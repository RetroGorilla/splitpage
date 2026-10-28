import { syncAnchorResolvedClasses } from "../../features/common/comment-anchors.js";
import { currentDocument, onRefresh, onSessionChange } from "../../legacy/session-bridge.ts";
import { onPreferenceChange, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { onScriptStats, statsFollowChange, updateScriptStats } from "./scene-status.ts";
import { historyOwner } from "./history.ts";
import { renderHistory } from "./history-panel.ts";
import { currentProductionTags } from "./production-tags.ts";
import { currentPlainTags } from "./plain-tags.ts";
import { onPainted } from "../../features/rows/render.js";
import { refreshGalleryOverlay } from "../../features/gallery/overlay.js";
import { renderRundown, setRundownExtraSeconds } from "../../features/rundown/rundown.js";
import { paintTargetOverlay } from "../../features/rundown/target.js";
import { refreshAnnotator } from "../../features/gallery/annotate.js";
import { productionPanelsOpen, renderProduction, updateGearCount, updateProductionCount } from "../../features/tags/panels.js";
import { runBrollRefresh } from "../../features/broll/panel.js";
import { scheduleBrollRefresh, updateBrollBadge } from "./broll.ts";
import { captureReplyDrafts, commentsChanged, renderComments } from "../../features/comments/comments.js";
import { writerControls } from "./writer.ts";

let stopPanels: (() => void) | null = null;

export function updateTagBadges(): void {
  updateProductionCount();
  updateGearCount();
  updateBrollBadge();
}

function refreshTagViews(): void {
  updateTagBadges();
  renderProduction();
}

function clockChanged(change: { key: string }): void {
  if (preferences().nameOf(change.key) !== "clock") return;
  renderHistoryPanel();
  if (currentDocument()) renderComments();
}

function renderHistoryPanel(): void {
  try {
    void renderHistory().catch(() => {});
  } catch (error) {
    if (window.console) console.error(error);
  }
}

export function mountPanelListenersFeature(): void {
  stopPanelListenersFeature();
  const stops: (() => void)[] = [
    onPainted((kind: string) => {
      if (kind === "rows") syncAnchorResolvedClasses(currentDocument(), document);
      else if (kind === "screen") {
        const writer = writerControls();
        if (viewFlags().writerOpen() && writer) writer.paintWriterDraw(writer.drawWriter());
        updateScriptStats();
        updateTagBadges();
        scheduleBrollRefresh();
        renderProduction();
        captureReplyDrafts();
        renderComments();
        refreshGalleryOverlay();
      } else if (kind === "tags") {
        updateTagBadges();
        renderProduction();
      } else if (kind === "row") {
        refreshGalleryOverlay();
      }
    }),
    currentProductionTags()?.onTagged(refreshTagViews) ?? (() => {}),
    currentPlainTags()?.onTagged(refreshTagViews) ?? (() => {}),
    onScriptStats((targetSeconds: number) => {
      setRundownExtraSeconds(targetSeconds);
      renderRundown();
      paintTargetOverlay();
    }),
    onSessionChange(commentsChanged),
    onSessionChange(statsFollowChange),
    onSessionChange(refreshAnnotator),
    onRefresh((jobs) => {
      if (!currentDocument()) return;
      if (jobs.has("production")) {
        if (productionPanelsOpen()) renderProduction();
        else updateTagBadges();
        updateScriptStats();
      }
      if (jobs.has("writerStats")) writerControls()?.updateWriterStats();
      if (jobs.has("broll")) runBrollRefresh();
    }),
    historyOwner().onHistoryChange(renderHistoryPanel),
    onPreferenceChange(clockChanged)
  ];
  stopPanels = () => {
    while (stops.length) stops.pop()?.();
  };
}

export function stopPanelListenersFeature(): void {
  const stop = stopPanels;
  stopPanels = null;
  stop?.();
}
