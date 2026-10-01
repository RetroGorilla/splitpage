import { cellOf } from "../legacy/richtext.ts";
import { syncCommentAnchors as syncAnchorsThrough } from "../core/text/anchors.ts";

export { cellOf, fromHtml } from "../legacy/richtext.ts";

export {
  CUE_LINE_RE,
  cellLength,
  commentIds,
  namedTagId,
  normalizeCell,
  projection,
  sameCell,
  tagIds,
  tagNameOf
} from "../core/text/runs.ts";
export {
  addComment,
  breakLine,
  commentRange,
  deleteRange,
  insertBrollKey,
  insertText,
  insideDirection,
  joinCells,
  markThroughout,
  marksAt,
  removeComment,
  replaceText,
  replaceWithBrollKey,
  replaceWithTag,
  retag,
  setMark,
  sliceCell,
  splitCell,
  toggleMark,
  typingMarks
} from "../core/text/edits.ts";
export {
  directionRangeAt,
  directionShortcut,
  directionToggleRange,
  flattenDirections,
  importDirections,
  toggleDirection
} from "../core/text/directions.ts";
export {
  cueLines,
  cueShortcut,
  cuesInCell,
  editCues,
  flattenCues,
  importCues,
  withoutCues
} from "../core/text/cues.ts";
export { toHtml } from "../core/text/html.ts";
export { OMIT_CLOSES, spokenText, toDocxRuns, toMarkdown, toPlainText } from "../core/text/projections.ts";
export { applySteps, invertSteps, touchedCells } from "../core/text/steps.ts";
export { mergeCells } from "../core/merge/cells.ts";

export function syncCommentAnchors(state) {
  return syncAnchorsThrough(state, cellOf);
}

export function __init() {}
