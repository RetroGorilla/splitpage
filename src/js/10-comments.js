import { S } from "./_state.js";
import { formatClock, formatDateClock } from "./00p-prefs.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml, makeId } from "./02-state.js";
import { blobImgHtml } from "./02c-blobs.js";
import { isSha256Hex, normalizeImageRef } from "../../shared/blob-policy.js";
import {
  findRowIndex,
  getEditorName,
  openSidePanel,
  pushSnapshot,
  stampRow,
  syncPanelClass
} from "./03-sync.js";
import {
  cssAttr,
  inertBody,
  plainText,
  safeId,
  sanitizeHtml
} from "./04-richtext.js";
import { editableCellHtml, pad2, render } from "./05-render.js";
import { resetDraftHistory } from "./05d-draft-edit.js";
import { normalizeTagName } from "./07-production-tags.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { personColor } from "./13a-presence.js";
import { htmlToPlainText, queueAutoSave, resumeAutoSave } from "./14-export.js";
import { nowIso } from "../adapters/identity/ids.ts";
import {
  commentMatchesFilterMode,
  commentMatchesAssigneeFilter as matchesAssignee,
  commentRecentOrder,
  compareCommentPositions
} from "../core/document/comments.ts";
export { nowIso };

var commentFilter;

export var TAGGING_HELP_KEY = "splitpage-tagging-help-dismissed";

var taggingHelpReturn = null;

export function showTaggingHelp() {
  var card = document.getElementById("tagging-help");
  if (!card) return;
  var active = document.activeElement;
  if (card.hidden && active && active !== document.body && !card.contains(active)) {
    var range = null;
    try {
      var sel = window.getSelection();
      if (sel.rangeCount && active.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange();
    } catch (e) {}
    taggingHelpReturn = { el: active, range: range };
  }
  card.hidden = false;
  try { localStorage.setItem(TAGGING_HELP_KEY, "0"); } catch (e) {}
  card.focus({ preventScroll: true });
  updateTaggingHelpCover();
}

export function hideTaggingHelp() {
  var card = document.getElementById("tagging-help");
  if (!card || card.hidden) return;
  var hadFocus = card.contains(document.activeElement);
  card.hidden = true;
  card.classList.remove("is-covering");
  try { localStorage.setItem(TAGGING_HELP_KEY, "1"); } catch (e) {}
  var back = taggingHelpReturn;
  taggingHelpReturn = null;
  if (!hadFocus || !back || !document.contains(back.el)) return;
  try { back.el.focus({ preventScroll: true }); } catch (e) { return; }
  if (back.range) {
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(back.range);
    } catch (e) { }
  }
}

var taggingHelpCoverFrame = 0;

function caretRectForCover() {
  var active = document.activeElement;
  if (!active || !active.isContentEditable) return null;
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (!active.contains(range.endContainer)) return null;
  var r = range.getClientRects();
  if (r.length && r[r.length - 1].height) return r[r.length - 1];
  var node = range.endContainer, at = range.endOffset;
  if (node.nodeType === 1 && at > 0) {
    node = node.childNodes[at - 1];
    while (node && node.nodeType === 1 && node.lastChild) node = node.lastChild;
    at = node && node.nodeType === 3 ? node.data.length : 0;
  }
  if (node && node.nodeType === 3 && at > 0) {
    var ch = document.createRange();
    ch.setStart(node, at - 1);
    ch.setEnd(node, at);
    var cr = ch.getClientRects();
    if (cr.length) {
      var last = cr[cr.length - 1];
      return { left: last.right, right: last.right + 1, top: last.top, bottom: last.bottom };
    }
  }
  var el = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentNode;
  var box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  return box ? { left: box.left, right: box.left + 2, top: box.top, bottom: Math.min(box.bottom, box.top + 24) } : null;
}

function fitTaggingHelp(card) {
  var bar = document.querySelector(".topbar");
  var bottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 52;
  card.style.setProperty("--header-bottom", bottom + "px");
}

export function updateTaggingHelpCover() {
  var card = document.getElementById("tagging-help");
  if (!card) return;
  if (card.hidden) { card.classList.remove("is-covering"); return; }
  fitTaggingHelp(card);
  var caret = caretRectForCover();
  var covering = false;
  if (caret) {
    var box = card.getBoundingClientRect();
    var pad = 8;
    covering = caret.right > box.left - pad && caret.left < box.right + pad &&
               caret.bottom > box.top - pad && caret.top < box.bottom + pad;
  }
  card.classList.toggle("is-covering", covering);
}

function scheduleTaggingHelpCover() {
  if (taggingHelpCoverFrame) return;
  var card = document.getElementById("tagging-help");
  if (!card || (card.hidden && !card.classList.contains("is-covering"))) return;
  taggingHelpCoverFrame = requestAnimationFrame(function () {
    taggingHelpCoverFrame = 0;
    updateTaggingHelpCover();
  });
}

function initTaggingHelp() {
  var card = document.getElementById("tagging-help");
  if (!card) return;
  document.getElementById("tagging-help-dismiss").addEventListener("click", hideTaggingHelp);
  card.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    hideTaggingHelp();
  });
  document.addEventListener("selectionchange", scheduleTaggingHelpCover);
  document.addEventListener("input", scheduleTaggingHelpCover, true);
  window.addEventListener("scroll", scheduleTaggingHelpCover, true);
  window.addEventListener("resize", scheduleTaggingHelpCover);
  var bar = document.querySelector(".topbar");
  if (bar && typeof ResizeObserver === "function") new ResizeObserver(scheduleTaggingHelpCover).observe(bar);
}

export var COMMENT_NAME_KEY = "splitpage-comment-author";
var pendingComment = null;
var expandedReplyIds = {};
var replyDrafts = {};
S.deleteCommentArmId = null;
export var deleteCommentArmTimer = null;

export function getSavedAuthorName() {
  try { return localStorage.getItem(COMMENT_NAME_KEY) || ""; } catch (e) { return ""; }
}
export function saveAuthorName(name) {
  try { localStorage.setItem(COMMENT_NAME_KEY, name); } catch (e) {}
}

export var COMMENTS_SORT_KEY = "splitpage-comments-sort";
export function readCommentSortMode() {
  try { return localStorage.getItem(COMMENTS_SORT_KEY) === "recent" ? "recent" : "position"; }
  catch (e) { return "position"; }
}
export function setCommentSortMode(mode) {
  S.commentSortMode = mode === "recent" ? "recent" : "position";
  try { localStorage.setItem(COMMENTS_SORT_KEY, S.commentSortMode); } catch (e) {}
  captureReplyDrafts();
  renderComments();
}

var COMMENTS_FILTER_KEY = "splitpage-comments-filter";
var COMMENTS_FILTER_LEGACY_KEY = "splitpage-comments-hide-resolved";
var COMMENT_FILTER_MODES = { open: true, resolved: true, all: true };

function readCommentFilter() {
  try {
    var raw = localStorage.getItem(COMMENTS_FILTER_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          mode: COMMENT_FILTER_MODES[parsed.mode] ? parsed.mode : "open",
          assignee: typeof parsed.assignee === "string" ? parsed.assignee : ""
        };
      }
    }
    var legacy = localStorage.getItem(COMMENTS_FILTER_LEGACY_KEY);
    if (legacy != null) return { mode: legacy === "true" ? "open" : "all", assignee: "" };
  } catch (e) {}
  return { mode: "open", assignee: "" };
}
function saveCommentFilter() {
  try { localStorage.setItem(COMMENTS_FILTER_KEY, JSON.stringify(commentFilter)); } catch (e) {}
}
export function setCommentFilterMode(mode) {
  commentFilter.mode = COMMENT_FILTER_MODES[mode] ? mode : "open";
  saveCommentFilter();
  captureReplyDrafts();
  renderComments();
}
export function setCommentAssigneeFilter(value) {
  commentFilter.assignee = value || "";
  saveCommentFilter();
  captureReplyDrafts();
  renderComments();
}
function commentMatchesAssigneeFilter(c, assignee) {
  return matchesAssignee(c, assignee, getSavedAuthorName);
}

function commentAssigneeCandidates() {
  var seen = {}, out = [];
  function add(name) {
    var clean = plainText(name || "").trim();
    if (!clean || clean === "Anonymous") return;
    var norm = normalizeTagName(clean);
    if (seen[norm]) return;
    seen[norm] = true;
    out.push(clean);
  }
  (S.state.people || []).forEach(function (p) { add(p.name); });
  (S.state.comments || []).forEach(function (c) {
    add(c.author);
    (c.replies || []).forEach(function (r) { add(r.author); });
  });
  out.sort(function (a, b) { return a.localeCompare(b); });
  return out;
}

export function setCommentAssignee(id, name) {
  var idx = findCommentIndex(id);
  if (idx === -1) return;
  if (reviewBlocked()) { renderComments(); return; }
  S.state.comments[idx].assignee = plainText(name || "").trim().slice(0, 80);
  S.state.comments[idx].updatedAt = nowIso();
  markDirty();
  render();
  queueAutoSave();
}

function commentAssigneeOptionsHtml(current) {
  var candidates = commentAssigneeCandidates();
  var found = false;
  var html = '<option value=""' + (current ? "" : " selected") + '>' +
    (current || reviewMode() ? "Unassigned" : "Assign…") + '</option>';
  candidates.forEach(function (name) {
    var sel = normalizeTagName(name) === normalizeTagName(current || "");
    if (sel) found = true;
    html += '<option value="' + escapeHtml(name) + '"' + (sel ? " selected" : "") + '>' + escapeHtml(name) + '</option>';
  });
  if (current && !found) {
    html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
  }
  return html;
}

function renderCommentFilterBar() {
  if (!S.state) return;
  var seg = document.getElementById("comments-filter-seg");
  if (seg) {
    var modeCounts = { open: 0, resolved: 0, all: 0 };
    S.state.comments.forEach(function (c) {
      if (!commentMatchesAssigneeFilter(c, commentFilter.assignee)) return;
      modeCounts.all++;
      modeCounts[c.resolved ? "resolved" : "open"]++;
    });
    ["open", "resolved", "all"].forEach(function (mode) {
      var btn = seg.querySelector('[data-filter="' + mode + '"]');
      if (!btn) return;
      var on = commentFilter.mode === mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
      var countEl = btn.querySelector(".filter-count");
      if (countEl) countEl.textContent = String(modeCounts[mode]);
    });
  }

  var select = document.getElementById("comments-assignee-filter");
  if (!select) return;
  var mode = commentFilter.mode;
  function countFor(matcher) {
    var n = 0;
    S.state.comments.forEach(function (c) { if (commentMatchesFilterMode(c, mode) && matcher(c)) n++; });
    return n;
  }
  var meNorm = normalizeTagName(getSavedAuthorName());
  var candidates = commentAssigneeCandidates();
  var current = commentFilter.assignee;
  var currentIsSpecial = current === "" || current === "me" || current === "__unassigned__";
  var currentFound = false;
  var html = '<option value="">Everyone (' + countFor(function () { return true; }) + ')</option>' +
    '<option value="me">Assigned to me (' + (meNorm ? countFor(function (c) { return normalizeTagName(c.assignee || "") === meNorm; }) : 0) + ')</option>' +
    '<option value="__unassigned__">Unassigned (' + countFor(function (c) { return !c.assignee; }) + ')</option>' +
    candidates.map(function (name) {
      if (!currentIsSpecial && normalizeTagName(name) === normalizeTagName(current)) currentFound = true;
      var norm = normalizeTagName(name);
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + ' (' +
        countFor(function (c) { return normalizeTagName(c.assignee || "") === norm; }) + ')</option>';
    }).join("");
  if (!currentIsSpecial && current && !currentFound) {
    html += '<option value="' + escapeHtml(current) + '">' + escapeHtml(current) + ' (' +
      countFor(function (c) { return normalizeTagName(c.assignee || "") === normalizeTagName(current); }) + ')</option>';
  }
  select.innerHTML = html;
  select.value = current;
}

export function formatTimestamp(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? formatClock(d) : formatDateClock(d);
  } catch (e) { return ""; }
}

function formatRelativeTime(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    var min = Math.round(sec / 60);
    if (min < 60) return min + (min === 1 ? " minute ago" : " minutes ago");
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
    var day = Math.round(hr / 24);
    if (day < 30) return day + (day === 1 ? " day ago" : " days ago");
    var mon = Math.round(day / 30);
    if (mon < 12) return mon + (mon === 1 ? " month ago" : " months ago");
    var yr = Math.round(mon / 12);
    return yr + (yr === 1 ? " year ago" : " years ago");
  } catch (e) { return ""; }
}

function findAnchorLocationLabel(rowId, field) {
  if (field === "title") return "Document title";
  var idx = findRowIndex(rowId);
  var rowLabel = idx === -1 ? "Deleted row" : ("Row " + pad2(idx + 1));
  var fieldLabel = field === "audioText" ? "Audio" : "Visual";
  return rowLabel + " · " + fieldLabel;
}

function commentLocationHtml(rowId, field) {
  if (field === "title") return "Document title";
  var idx = findRowIndex(rowId);
  var fieldLabel = field === "audioText" ? "Audio" : "Visual";
  if (idx === -1) return "Deleted scene · " + fieldLabel;
  return 'Scene <span class="comment-loc-num">' + pad2(idx + 1) + '</span> · ' + fieldLabel;
}

function commentThreadNumbers() {
  var spans = Array.prototype.slice.call(document.querySelectorAll("#rows .cmt-anchor:not(.resolved)"));
  spans.sort(function (a, b) {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  var nums = Object.create(null);
  spans.forEach(function (el, i) {
    var id = el.getAttribute("data-cmt");
    if (id && !nums[id]) nums[id] = i + 1;
  });
  return nums;
}

function commentAvatarHtml(name) {
  var first = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar comment-avatar" style="--size:28px;--presence:' + personColor(name) +
    '" aria-hidden="true">' + escapeHtml(first.toUpperCase()) + '</span>';
}

function commentTimeHtml(iso, cls) {
  return '<time class="' + cls + '" datetime="' + escapeHtml(iso || "") + '" title="' +
    escapeHtml(formatTimestampAbsolute(iso)) + '">' + escapeHtml(formatRelativeTime(iso)) + '</time>';
}

function formatTimestampAbsolute(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return formatDateClock(d, { year: true });
  } catch (e) { return ""; }
}

function commentPositionCompare(a, b) {
  return compareCommentPositions(a, b, findRowIndex);
}

export function commentEntries(opts) {
  var pieces = !!(opts && opts.pieces);
  var list = (S.state.comments || []).slice();
  list.sort(commentPositionCompare);
  return list.map(function (c) {
    var entry = {
      id: c.id,
      rowIndex: c.field === "title" ? -1 : findRowIndex(c.rowId),
      field: c.field,
      location: findAnchorLocationLabel(c.rowId, c.field),
      author: c.author || "Anonymous",
      body: htmlToPlainText(c.body),
      quoted: c.quotedText || "",
      resolved: !!c.resolved,
      resolvedBy: c.resolved ? (c.resolvedBy || "") : "",
      assignee: c.assignee || "",
      when: formatTimestampAbsolute(c.createdAt),
      replies: (c.replies || []).map(function (rp) {
        var reply = {
          author: rp.author || "Anonymous",
          body: htmlToPlainText(rp.body),
          when: formatTimestampAbsolute(rp.createdAt)
        };
        if (pieces) reply.pieces = bodyPieces(rp.body);
        return reply;
      })
    };
    if (pieces) entry.pieces = commentBodyPieces(c);
    return entry;
  });
}

export function bodyPieces(html) {
  var out = [];
  if (!html) return out;
  var root = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  if (!root.querySelector("img[data-blob]")) {
    var only = htmlToPlainText(html);
    if (only) out.push({ text: only });
    return out;
  }
  var buf = "";
  function flush() {
    var t = buf.replace(/\u00A0/g, " ").trim();
    if (t) out.push({ text: t });
    buf = "";
  }
  (function walk(node) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) { buf += child.nodeValue || ""; return; }
      if (child.nodeType !== 1) return;
      if (child.tagName === "IMG") {
        var sha = child.getAttribute("data-blob");
        if (isSha256Hex(sha)) { flush(); out.push({ image: sha }); }
        return;
      }
      walk(child);
    });
  })(root);
  flush();
  return out;
}

function commentBodyPieces(c) {
  if (c.kind === "conflict" && c.field === "visualImage") {
    var ref = normalizeImageRef(c.imageValue);
    return ref ? [{ image: ref.sha256 }] : [];
  }
  return bodyPieces(c.body);
}

export var COMMENT_IMAGE_TEXT = "[image]";

export function commentBodyText(entry) {
  var pieces = (entry && entry.pieces) || [];
  if (!pieces.some(function (p) { return p.image; })) return entry.body;
  return pieces.map(function (p) { return p.image ? COMMENT_IMAGE_TEXT : p.text; }).join("\n");
}

function anchorTextFromState(cmtId) {
  if (!S.state) return null;
  var cIdx = findCommentIndex(cmtId);
  if (cIdx === -1) return null;
  var c = S.state.comments[cIdx];
  var row = S.state.rows[findRowIndex(c.rowId)];
  if (!row) return null;
  var body = inertBody(row[c.field] || "");
  var span = body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(cmtId) + '"]');
  return span ? span.textContent : null;
}

function anchorLiveText(cmtId) {
  var el = document.querySelector('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  if (el) return el.textContent;
  return anchorTextFromState(cmtId);
}

function unwrapAnchorInState(rowId, field, cmtId) {
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  var html = S.state.rows[idx][field] || "";
  var container = inertBody(html);
  var anchor = container.querySelector('.cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  if (anchor) {
    while (anchor.firstChild) anchor.parentNode.insertBefore(anchor.firstChild, anchor);
    anchor.parentNode.removeChild(anchor);
    S.state.rows[idx][field] = container.innerHTML;
  }
}

export function syncAnchorResolvedClasses() {
  var resolvedIds = {};
  S.state.comments.forEach(function (c) { if (c.resolved) resolvedIds[c.id] = true; });
  document.querySelectorAll("#rows .cmt-anchor").forEach(function (el) {
    var id = el.getAttribute("data-cmt");
    el.classList.toggle("resolved", !!resolvedIds[id]);
  });
}

export function updateCommentsCount() {
  var open = S.state.comments.filter(function (c) { return !c.resolved; }).length;
  var badge = document.getElementById("comments-badge");
  if (open > 0) { badge.hidden = false; badge.textContent = open > 99 ? "99+" : String(open); }
  else badge.hidden = true;
}

function closeFieldPopovers(root) {
  (root || document).querySelectorAll(".link-popover, .video-popover").forEach(function (el) {
    el.hidden = true;
    var input = el.querySelector("input");
    if (input) input.value = "";
  });
}

export function openCommentComposer(ctx) {
  pendingComment = ctx;
  S.savedRange = null;
  S.savedRangeCell = null;
  closeFieldPopovers(document.getElementById("comment-modal"));
  document.getElementById("comment-modal-quote").innerHTML =
    '“<span class="comment-quote-words">' + escapeHtml(ctx.quotedText) + '</span>”';
  var nameInput = document.getElementById("comment-name");
  nameInput.value = getSavedAuthorName();
  var bodyEl = document.getElementById("comment-body-editable");
  bodyEl.innerHTML = "";
  resetDraftHistory(bodyEl);
  document.getElementById("comment-modal").hidden = false;
  setTimeout(function () { bodyEl.focus(); }, 0);
}

export function closeCommentComposer(cancelled) {
  document.getElementById("comment-modal").hidden = true;
  if (cancelled && pendingComment) {
    unwrapAnchorInState(pendingComment.rowId, pendingComment.field, pendingComment.id);
    markDirty();
    render();
  }
  pendingComment = null;
  S.savedRange = null;
  S.savedRangeCell = null;
  closeFieldPopovers(document.getElementById("comment-modal"));
  document.getElementById("comment-body-editable").innerHTML = "";
  resetDraftHistory(document.getElementById("comment-body-editable"));
}

export function postComment() {
  if (!pendingComment) return;
  var nameInput = document.getElementById("comment-name");
  var author = (nameInput.value || "").trim() || "Anonymous";
  saveAuthorName(author);
  var bodyEl = document.getElementById("comment-body-editable");
  var bodyHtml = sanitizeHtml(bodyEl.innerHTML);
  var hasMedia = /<img|video-embed-card/.test(bodyHtml);
  if (!bodyEl.textContent.trim() && !hasMedia) {
    showToast("Write a comment before posting.", "warn");
    return;
  }
  S.state.comments.push({
    id: pendingComment.id,
    rowId: pendingComment.rowId,
    field: pendingComment.field,
    anchorId: pendingComment.id,
    quotedText: pendingComment.quotedText,
    author: author,
    body: bodyHtml,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    assignee: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    kind: "anchor",
    replies: []
  });
  markDirty();
  document.getElementById("comment-modal").hidden = true;
  pendingComment = null;
  bodyEl.innerHTML = "";
  resetDraftHistory(bodyEl);
  render();
  sendNow();
}

function sendNow() {
  if (reviewMode()) resumeAutoSave();
  queueAutoSave();
}

function findCommentIndex(id) {
  for (var i = 0; i < S.state.comments.length; i++) if (S.state.comments[i].id === id) return i;
  return -1;
}

export function openCommentsPanel() {
  if (!S.state) return;
  openSidePanel("comments-panel");
  captureReplyDrafts();
  renderComments();
}
export function closeCommentsPanel() {
  document.getElementById("comments-panel").hidden = true;
  syncPanelClass();
}

export function toggleResolve(id) {
  if (reviewMode()) return;
  var idx = findCommentIndex(id);
  if (idx === -1) return;
  var c = S.state.comments[idx];
  c.resolved = !c.resolved;
  c.updatedAt = nowIso();
  if (c.resolved) { c.resolvedBy = getEditorName(); c.resolvedAt = c.updatedAt; }
  else { c.resolvedBy = null; c.resolvedAt = null; }
  markDirty();
  render();
  queueAutoSave();
}

function deleteComment(id) {
  var idx = findCommentIndex(id);
  if (idx === -1) return;
  var c = S.state.comments[idx];
  unwrapAnchorInState(c.rowId, c.field, c.anchorId);
  S.state.comments.splice(idx, 1);
  delete expandedReplyIds[id];
  delete replyDrafts[id];
  if (commentMenuFor === id) commentMenuFor = null;
  markDirty();
  render();
  queueAutoSave();
}

export function armDeleteComment(btn, id) {
  if (S.deleteCommentArmId === id) {
    clearTimeout(deleteCommentArmTimer);
    S.deleteCommentArmId = null;
    deleteComment(id);
    return;
  }
  S.deleteCommentArmId = id;
  clearTimeout(deleteCommentArmTimer);
  deleteCommentArmTimer = setTimeout(function () {
    S.deleteCommentArmId = null;
    renderComments();
  }, 2800);
  captureReplyDrafts();
  renderComments();
}

export function toggleReplyComposer(id) {
  captureReplyDrafts();
  expandedReplyIds[id] = !expandedReplyIds[id];
  if (!expandedReplyIds[id]) delete replyDrafts[id];
  renderComments();
  if (expandedReplyIds[id]) {
    var input = document.querySelector('.reply-composer[data-for="' + safeId(id, "c") + '"] .cell-editable');
    if (input) input.focus();
  }
}

export function postReply(id) {
  var idx = findCommentIndex(id);
  if (idx === -1) return;
  var card = document.querySelector('.reply-composer[data-for="' + safeId(id, "c") + '"]');
  if (!card) return;
  var nameInput = card.querySelector(".reply-name-input");
  var bodyEl = card.querySelector(".cell-editable");
  var author = (nameInput.value || "").trim() || "Anonymous";
  saveAuthorName(author);
  var bodyHtml = sanitizeHtml(bodyEl.innerHTML);
  if (!bodyEl.textContent.trim()) {
    showToast("Write a reply before posting.", "warn");
    return;
  }
  S.state.comments[idx].replies.push({
    id: makeId("rp"),
    author: author,
    body: bodyHtml,
    createdAt: nowIso()
  });
  S.state.comments[idx].updatedAt = nowIso();
  delete expandedReplyIds[id];
  delete replyDrafts[id];
  markDirty();
  render();
  sendNow();
}

export function jumpToAnchor(cmtId) {
  var cIdx = findCommentIndex(cmtId);
  if (cIdx !== -1) revealRow(S.state.comments[cIdx].rowId);
  var el = document.querySelector('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  if (!el) {
    showToast("That text is no longer in the script.", "warn");
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

export function jumpToComment(cmtId) {
  var idx = findCommentIndex(cmtId);
  var target = idx === -1 ? null : S.state.comments[idx];
  if (target && (!commentMatchesFilterMode(target, commentFilter.mode) ||
      !commentMatchesAssigneeFilter(target, commentFilter.assignee))) {
    commentFilter.mode = "all";
    commentFilter.assignee = "";
    saveCommentFilter();
    captureReplyDrafts();
    renderComments();
  }
  openCommentsPanel();
  setTimeout(function () {
    var card = document.querySelector('.comment-card[data-id="' + safeId(cmtId, "c") + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }, 30);
}

function replyComposerHtml(commentId) {
  var draft = replyDrafts[commentId] || {};
  return (
    '<div class="reply-composer" data-for="' + commentId + '">' +
      editableCellHtml({
        value: draft.body,
        placeholder: "Write a reply…",
        toolbar: "reply"
      }) +
      '<div class="reply-composer-foot">' +
        '<label class="reply-name">Your name' +
          '<input type="text" class="reply-name-input ev-field" placeholder="Your name" value="' +
            escapeHtml(draft.name !== undefined ? draft.name : getSavedAuthorName()) + '" autocomplete="off">' +
        '</label>' +
        '<span class="reply-composer-actions">' +
          '<button type="button" class="reply-cancel" data-action="reply-cancel" data-id="' + commentId + '">Cancel</button>' +
          '<button type="button" class="reply-post" data-action="reply-post" data-id="' + commentId + '">Post reply</button>' +
        '</span>' +
      '</div>' +
    '</div>'
  );
}

function commentReplyHtml(c) {
  return '<div class="comment-reply">' +
    (expandedReplyIds[c.id] ? replyComposerHtml(c.id) :
      '<button type="button" class="comment-reply-open" data-action="toggle-reply" data-id="' + c.id + '">Write a reply…</button>') +
  '</div>';
}

function commentEntryHtml(author, createdAt, bodyHtml, reply) {
  var p = reply ? "reply" : "comment";
  return '<li class="comment-entry' + (reply ? ' reply-card' : '') + '">' +
    commentAvatarHtml(author) +
    '<div class="comment-entry-main">' +
      '<div class="comment-entry-head">' +
        '<span class="' + p + '-author">' + escapeHtml(author) + '</span>' +
        commentTimeHtml(createdAt, p + "-time") +
      '</div>' +
      '<div class="' + p + '-body">' + bodyHtml + '</div>' +
    '</div>' +
  '</li>';
}

var commentMenuFor = null;

function commentMoreHtml(c) {
  var open = commentMenuFor === c.id;
  var armed = S.deleteCommentArmId === c.id;
  return '<span class="comment-more-wrap">' +
    '<button type="button" class="btn-outline is-icon comment-more" data-action="comment-menu" data-id="' + c.id +
      '" aria-haspopup="menu" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="More actions for this thread" title="More">' +
      '<svg aria-hidden="true"><use href="#i-more"/></svg></button>' +
    (open
      ? '<div class="comment-menu" role="menu" aria-label="Actions for this thread">' +
          '<button type="button" role="menuitem" class="comment-menu-item danger' + (armed ? ' armed' : '') +
            '" data-action="delete-comment" data-id="' + c.id + '"' +
            (armed ? ' title="Click again to delete this thread"' : '') + '>' +
            '<svg aria-hidden="true"><use href="#i-trash"/></svg>' +
            '<span class="comment-menu-label">' + (armed ? 'Delete?' : 'Delete') + '</span></button>' +
        '</div>'
      : '') +
  '</span>';
}

function commentMenuEl() {
  return commentMenuFor ? document.querySelector('#comments-list .comment-card[data-id="' + safeId(commentMenuFor, "c") + '"] .comment-menu') : null;
}

function focusCommentMenuItem() {
  var menu = commentMenuEl();
  var item = menu && menu.querySelector(".comment-menu-item");
  if (item) item.focus();
}

function placeCommentMenu() {
  var menu = commentMenuEl();
  if (!menu) return;
  menu.classList.remove("opens-up");
  var list = document.getElementById("comments-list");
  var box = list.getBoundingClientRect();
  var r = menu.getBoundingClientRect();
  if (r.bottom > box.bottom - 8 && r.top - r.height - 40 > box.top + 8) menu.classList.add("opens-up");
}

function closeCommentMenu(refocus) {
  var id = commentMenuFor;
  if (!id) return;
  var menu = commentMenuEl();
  commentMenuFor = null;
  if (S.deleteCommentArmId === id) { clearTimeout(deleteCommentArmTimer); S.deleteCommentArmId = null; }
  if (!menu) return;
  var btn = menu.parentNode.querySelector(".comment-more");
  menu.parentNode.removeChild(menu);
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }
}

export function toggleCommentMenu(id) {
  if (commentMenuFor === id) { closeCommentMenu(true); return; }
  closeCommentMenu(false);
  commentMenuFor = id;
  captureReplyDrafts();
  renderComments();
  focusCommentMenuItem();
}

function onCommentMenuMouseDown(e) {
  if (!commentMenuFor) return;
  if (e.target.closest && e.target.closest('.comment-menu, [data-action="comment-menu"]')) return;
  closeCommentMenu(false);
}

function onCommentMenuKeydown(e) {
  var t = e.target;
  if (!t || !t.closest) return;
  var btn = t.closest('#comments-list [data-action="comment-menu"]');
  if (btn) {
    var id = btn.getAttribute("data-id");
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && commentMenuFor !== id) {
      e.preventDefault();
      e.stopPropagation();
      toggleCommentMenu(id);
    } else if (e.key === "Escape" && commentMenuFor === id) {
      e.preventDefault();
      e.stopPropagation();
      closeCommentMenu(true);
    }
    return;
  }
  var menu = t.closest("#comments-list .comment-menu");
  if (!menu) return;
  var items = Array.prototype.slice.call(menu.querySelectorAll(".comment-menu-item"));
  var i = items.indexOf(t);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) items[e.key === "Home" ? 0 : items.length - 1].focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeCommentMenu(true);
  } else if (e.key === "Tab") {
    closeCommentMenu(false);
  }
}

function commentResolvedNoteHtml(c) {
  if (!c.resolved || !c.resolvedBy) return "";
  return '<div class="comment-resolved-note"><svg aria-hidden="true"><use href="#i-check-circle"/></svg>Resolved by ' + escapeHtml(c.resolvedBy) +
    (c.resolvedAt ? ' · ' + escapeHtml(formatRelativeTime(c.resolvedAt)) : '') + '</div>';
}

function commentCardHtml(c, num) {
  if (c.kind === "conflict") return conflictCardHtml(c);
  var liveText = anchorLiveText(c.id);
  var orphaned = liveText === null || liveText.length === 0;
  var changed = !orphaned && liveText !== c.quotedText;
  var review = reviewMode();
  var entries = commentEntryHtml(c.author, c.createdAt, c.body, false) +
    c.replies.map(function (r) { return commentEntryHtml(r.author, r.createdAt, r.body, true); }).join("");
  return (
    '<div class="comment-card' + (c.resolved ? ' is-resolved' : '') + (orphaned ? '' : ' is-jumpable') +
      '" data-id="' + c.id + '"' + (orphaned ? '' : ' title="Click to jump to this text in the script"') + '>' +
      '<div class="comment-card-head">' +
        '<div class="comment-card-where">' +
          (num ? '<span class="comment-num" role="img" aria-label="Thread ' + num + '">' + num + '</span>' : '') +
          (orphaned
            ? '<span class="comment-loc">' + commentLocationHtml(c.rowId, c.field) + '</span>'
            : '<button type="button" class="jump-link comment-loc" title="Go to these words in the script"><span>' +
                commentLocationHtml(c.rowId, c.field) + '</span><svg aria-hidden="true"><use href="#i-arrow-right"/></svg></button>') +
        '</div>' +
        (orphaned ?
          '<div class="comment-quote orphaned">' +
            (c.quotedText ? '“<span class="comment-quote-words">' + escapeHtml(c.quotedText) + '</span>” ' : '') +
            '<span class="comment-state-tag" title="Text no longer found in the script">No longer in script</span>' +
          '</div>' :
        changed ?
          '<div class="comment-quote changed" title="Originally: “' + escapeHtml(c.quotedText) + '”">' +
            '“<span class="comment-quote-words">' + escapeHtml(liveText) + '</span>” ' +
            '<span class="comment-state-tag" title="Text changed. Originally: “' + escapeHtml(c.quotedText) + '”">Changed</span>' +
          '</div>' :
          '<div class="comment-quote">“<span class="comment-quote-words">' + escapeHtml(c.quotedText) + '</span>”</div>'
        ) +
        commentResolvedNoteHtml(c) +
      '</div>' +
      '<ol class="comment-thread" aria-label="Comments in this thread">' + entries + '</ol>' +
      commentReplyHtml(c) +
      '<div class="comment-actions comment-foot">' +
        (review ? '' :
          '<button type="button" class="btn-outline comment-resolve" data-action="toggle-resolve" data-id="' + c.id + '">' +
            (c.resolved
              ? '<svg aria-hidden="true"><use href="#i-return"/></svg>Unresolve'
              : '<svg class="comment-resolve-tick" aria-hidden="true"><use href="#i-check-circle"/></svg>Resolve') +
          '</button>') +
        '<span class="ev-field comment-assign">' +
          '<svg class="comment-assign-icon" aria-hidden="true"><use href="#i-person"/></svg>' +
          '<select class="comment-assignee-select" id="comment-assignee-' + c.id + '" data-id="' + c.id + '" aria-label="Assign this thread to"' +
            (review ? ' disabled' : '') + '>' +
            commentAssigneeOptionsHtml(c.assignee) +
          '</select>' +
          '<svg class="ev-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg>' +
        '</span>' +
        (review ? '' : commentMoreHtml(c)) +
      '</div>' +
    '</div>'
  );
}

function conflictBodyHtml(c) {
  if (c.field === "visualImage") {
    var ref = normalizeImageRef(c.imageValue);
    return ref ? blobImgHtml(ref, "comment-img") : "";
  }
  return c.body;
}

var CONFLICT_ICON_SVG =
  '<svg class="conflict-flag-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>' +
  '</svg>';

function conflictCardHtml(c) {
  return (
    '<div class="comment-card is-conflict' + (c.resolved ? ' is-resolved' : '') + '" data-id="' + c.id + '">' +
      '<div class="comment-card-head">' +
        '<div class="conflict-flag">' + CONFLICT_ICON_SVG + 'Unmerged edit · ' + escapeHtml(c.conflictField || "Field") + '</div>' +
        '<div class="comment-card-where"><span class="comment-loc">' + commentLocationHtml(c.rowId, c.field) + '</span></div>' +
        '<div class="conflict-note">Someone else changed this at the same time. Their version is live; yours is below.</div>' +
        commentResolvedNoteHtml(c) +
      '</div>' +
      '<ol class="comment-thread" aria-label="Your version">' +
        commentEntryHtml(c.author, c.createdAt,
          '<div class="conflict-body">' + (c.emptyValue ? "<em>(you had cleared this)</em>" : conflictBodyHtml(c)) + '</div>', false) +
      '</ol>' +
      (reviewMode() ? '' :
        '<div class="comment-actions comment-foot">' +
          '<button type="button" class="btn-outline" data-action="restore-conflict" data-id="' + c.id + '">Use my version</button>' +
          '<button type="button" class="btn-outline" data-action="toggle-resolve" data-id="' + c.id + '">' +
            (c.resolved ? "Unresolve" : "Keep theirs") + '</button>' +
          commentMoreHtml(c) +
        '</div>') +
    '</div>'
  );
}

export function restoreConflictValue(commentId) {
  var ci = findCommentIndex(commentId);
  if (ci === -1) return;
  var c = S.state.comments[ci];
  if (c.field === "title") {
    pushSnapshot("Before using your version of the title");
    S.state.title = c.emptyValue ? "" : (c.titleValue || "");
    S.state.comments.splice(ci, 1);
    markDirty();
    render();
    queueAutoSave();
    showToast("Restored your version of the title", "ok");
    return;
  }
  var ri = findRowIndex(c.rowId);
  if (ri === -1) { showToast("That scene no longer exists.", "warn"); return; }

  pushSnapshot("Before using your version of " + (c.conflictField || "a field"));
  if (c.field === "visualImage") {
    delete S.state.rows[ri].visualImage;
    S.state.rows[ri].imageRef = c.emptyValue ? null : (normalizeImageRef(c.imageValue) || null);
  } else {
    S.state.rows[ri][c.field] = c.emptyValue ? "" : sanitizeHtml(c.body);
  }
  stampRow(S.state.rows[ri]);
  S.state.comments.splice(ci, 1);
  markDirty();
  render();
  queueAutoSave();
  showToast("Restored your version of " + (c.conflictField || "the field"), "ok");
}

export function captureReplyDrafts() {
  document.querySelectorAll(".reply-composer").forEach(function (el) {
    var id = el.getAttribute("data-for");
    var body = el.querySelector(".cell-editable");
    var name = el.querySelector(".reply-name-input");
    if (!id) return;
    replyDrafts[id] = { body: body ? body.innerHTML : "", name: name ? name.value : "" };
  });
}

var COMMENTS_HINT_HTML = '<p class="comments-hint">To start a thread, select words in the script and choose Comment.</p>';

export function renderComments() {
  if (!S.state) return;
  var listEl = document.getElementById("comments-list");
  if (!listEl) return;
  renderCommentFilterBar();
  var items = S.state.comments.filter(function (c) {
    return commentMatchesFilterMode(c, commentFilter.mode) && commentMatchesAssigneeFilter(c, commentFilter.assignee);
  });
  items = items.slice().sort(S.commentSortMode === "recent" ? commentRecentOrder : commentPositionCompare);
  if (!items.length) {
    listEl.innerHTML = '<div class="comments-empty">' + (S.state.comments.length ? "No comments match this filter." : "No comments yet.") + '</div>' +
      COMMENTS_HINT_HTML;
    return;
  }
  var a = document.activeElement;
  var focusInMenu = !!(a && a.closest && a.closest("#comments-list .comment-menu"));
  var nums = commentThreadNumbers();
  listEl.innerHTML = items.map(function (c) {
    return commentCardHtml(c, c.resolved ? 0 : nums[c.id] || 0);
  }).join("") + COMMENTS_HINT_HTML;
  if (commentMenuFor) {
    placeCommentMenu();
    if (focusInMenu) focusCommentMenuItem();
  }
}

export function __init() {
  S.commentSortMode = readCommentSortMode();

  commentFilter = readCommentFilter();

  document.addEventListener("mousedown", onCommentMenuMouseDown, true);
  document.addEventListener("keydown", onCommentMenuKeydown, true);

  initTaggingHelp();
}
