import { currentDocument, onRefresh, onSessionChange } from "../../legacy/session-bridge.ts";
import { onPreferenceChange, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { onScriptStats, statsFollowChange, updateScriptStats } from "../../js/01-scene-status.js";
import { onHistoryChange } from "../../js/03a-history-store.js";
import { renderHistory } from "../../js/03-sync.js";
import { onTagged } from "../../js/07-production-tags.js";
import { onPlainTagged } from "../../js/07b-plain-tags.js";
import { onPainted } from "../../js/05-render.js";
import { refreshGalleryOverlay } from "../../js/05e-gallery-overlay.js";
import { renderRundown } from "../../js/05f-rundown.js";
import { paintRundownPresence } from "../../js/05p-rundown-presence.js";
import { paintTargetOverlay } from "../../js/05t-target.js";
import { refreshAnnotator } from "../../js/05w-annotate.js";
import { productionPanelsOpen, renderProduction, updateGearCount, updateProductionCount } from "../../js/08-production-panels.js";
import { runBrollRefresh } from "../../js/08d-broll-panel.js";
import { scheduleBrollRefresh, updateBrollBadge } from "../../js/08c-broll.js";
import { captureReplyDrafts, commentsChanged, renderComments, syncAnchorResolvedClasses } from "../../js/10-comments.js";
import { onPresencePaint, paintPresence } from "../../js/13a-presence.js";
import { drawWriter, paintWriterDraw, updateWriterStats } from "../../js/19-writer.js";

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
      if (kind === "rows") syncAnchorResolvedClasses();
      else if (kind === "screen") {
        if (viewFlags().writerOpen()) paintWriterDraw(drawWriter());
        updateScriptStats();
        updateTagBadges();
        scheduleBrollRefresh();
        renderProduction();
        captureReplyDrafts();
        renderComments();
        paintPresence();
        refreshGalleryOverlay();
      } else if (kind === "tags") {
        updateTagBadges();
        renderProduction();
      } else if (kind === "row") {
        paintPresence();
        refreshGalleryOverlay();
      }
    }),
    onTagged(refreshTagViews),
    onPlainTagged(refreshTagViews),
    onScriptStats(() => {
      renderRundown();
      paintTargetOverlay();
    }),
    onPresencePaint(() => { paintRundownPresence(); }),
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
      if (jobs.has("writerStats")) updateWriterStats();
      if (jobs.has("broll")) runBrollRefresh();
    }),
    onHistoryChange(renderHistoryPanel),
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
