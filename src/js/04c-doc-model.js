import { inertBody, sanitizeHtml } from "./04-richtext.js";
import { defaultTagId, normalizeCell } from "../core/text/runs.ts";
import { syncCommentAnchors as syncAnchorsThrough } from "../core/text/anchors.ts";

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

export function fromHtml(html, opts) {
  opts = opts || {};
  var tagId = opts.tagId || defaultTagId;
  var runs = [];
  var body = inertBody(sanitizeHtml(html == null ? "" : String(html)));
  (function walk(node, marks) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        var t = String(child.nodeValue || "").replace(/[\r\n]+/g, " ");
        if (t) runs.push({ text: t, marks: marks });
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName;
      if (tag === "BR") { runs.push({ text: "\n", marks: marks }); return; }
      if (tag === "IMG") {
        if (opts.onMedia) {
          opts.onMedia({ kind: "image", ref: {
            sha256: child.getAttribute("data-blob"),
            width: Number(child.getAttribute("data-w")) || null,
            height: Number(child.getAttribute("data-h")) || null,
            mime: child.getAttribute("data-mime") || null
          } });
        }
        return;
      }
      var cls = child.classList;
      if (tag === "A" && cls && cls.contains("video-embed-card")) {
        if (opts.onMedia) opts.onMedia({ kind: "video", href: child.getAttribute("href") });
        return;
      }
      if (tag === "SPAN" && cls && cls.contains("broll-key")) {
        runs.push({ atom: "broll", id: child.getAttribute("data-broll-id"), text: child.textContent, marks: marks });
        return;
      }
      var next = Object.assign({}, marks);
      if (tag === "STRONG") next.b = true;
      else if (tag === "EM") next.i = true;
      else if (tag === "U") next.u = true;
      else if (tag === "S") next.s = true;
      else if (tag === "MARK") next.hl = true;
      else if (tag === "A") next.href = child.getAttribute("href");
      else if (tag === "SPAN" && cls && cls.contains("tag-anchor")) {
        next.tag = tagId(child.getAttribute("data-tag-cat"), child.getAttribute("data-tag-name"));
      } else if (tag === "SPAN" && cls && cls.contains("cmt-anchor")) {
        next.cmt = (marks.cmt || []).concat([child.getAttribute("data-cmt")]);
      } else if (tag === "SPAN" && cls && cls.contains("stage-dir")) {
        next.dir = true;
      } else if (tag === "SPAN" && cls && cls.contains("audio-cue")) {
        next.cue = true;
      }
      walk(child, next);
    });
  })(body, {});
  return normalizeCell(runs, opts);
}

var CELL_CACHE_BUDGET = 2000000;
var cellCache = new Map();
var cellCacheChars = 0;

export function cellOf(html) {
  var key = html == null ? "" : String(html);
  var hit = cellCache.get(key);
  if (hit !== undefined) return hit;
  var cell = fromHtml(key);
  if (cellCacheChars > CELL_CACHE_BUDGET) { cellCache.clear(); cellCacheChars = 0; }
  cellCache.set(key, cell);
  cellCacheChars += key.length;
  return cell;
}

export function syncCommentAnchors(state) {
  return syncAnchorsThrough(state, cellOf);
}

export function __init() {}
