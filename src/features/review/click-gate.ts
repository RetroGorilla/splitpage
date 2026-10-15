export const REVIEW_SAFE_ACTIONS: ReadonlySet<string> = new Set([
  "toggle-reply", "reply-post", "reply-cancel",
  "link-confirm", "link-cancel", "video-confirm", "video-cancel",
  "jump-tag", "jump-row", "writer-jump",
  "gallery-open", "gallery-open-videos",
  "tag-expand", "bulk-clear",
  "export-breakdown", "export-packing-gear"
]);

export interface ReviewClickGatePorts {
  readonly reviewMode: () => boolean;
  readonly refuse: () => void;
}

export type ReviewClickGate = (target: Element) => boolean;

function refusedInReview(target: Element): boolean {
  const toolbarButton = target.closest(".mini-toolbar button[data-cmd]");
  if (toolbarButton) return toolbarButton.getAttribute("data-cmd") !== "comment";
  const actionEl = target.closest("[data-action]");
  return actionEl !== null && !REVIEW_SAFE_ACTIONS.has(actionEl.getAttribute("data-action") ?? "");
}

export function createReviewClickGate(ports: ReviewClickGatePorts): ReviewClickGate {
  return (target) => {
    if (!ports.reviewMode() || !refusedInReview(target)) return false;
    ports.refuse();
    return true;
  };
}
