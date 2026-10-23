import { deleteConfirmation } from "../legacy/production-editing-bridge.ts";
import { pad2 } from "../core/production/timing.ts";
import { rowIndexOf } from "../core/document/rows.ts";
import { currentDocument, readSession, runDocumentEdit, sessionStamps } from "../legacy/session-bridge.ts";
import {
  addCommentCommand,
  addReplyCommand,
  deleteCommentCommand,
  restoreConflictCommand,
  setCommentAssigneeCommand,
  toggleResolveCommand,
  unwrapCommentAnchorCommand
} from "../application/commands/comments.ts";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { editorSelection } from "../legacy/editor-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";
import { formatClock, formatDateClock } from "../../shared/clock.js";
import { revealRow } from "./01b-hide-shot.js";
import { blobImgHtml } from "../adapters/storage/02c-blobs.js";
import { normalizeImageRef } from "../../shared/blob-policy.js";
import {
  openSidePanel,
  pushSnapshot,
  syncPanelClass
} from "./03-sync.js";
import {
  cssAttr,
  inertBody,
  plainText,
  safeId,
  sanitizeHtml
} from "./04-richtext.js";
import { editableCellHtml } from "./05-render.js";
import { resetDraftHistory } from "./05d-draft-edit.js";
import { personColor } from "./13a-presence.js";
import { resumeAutoSave } from "./14-export.js";
import { autoSavePolicy } from "../legacy/save-bridge.ts";
import { commentBodyText, commentEntries, formatTimestampAbsolute } from "../adapters/formats/export-projections.ts";
import { makeId, nowIso } from "../adapters/identity/ids.ts";
import {
  commentMatchesFilterMode,
  commentMatchesAssigneeFilter as matchesAssignee,
  commentRecentOrder,
  compareCommentPositions
} from "../core/document/comments.ts";
import { idMap } from "../core/document/id-map.ts";
import { normalizeTagName } from "../core/document/tags.ts";
import { EDITOR_NAME_MAX } from "../core/document/fields.ts";
import { codePointPrefix, escapeHtml } from "../core/document/text-policy.ts";
import { commentSortMode, setCommentSort } from "../application/comment-sort.ts";
import { cleanAuthorName } from "../core/document/people.ts";
import { reviewBlocked, reviewMode } from "../legacy/location-bridge.ts";
export { commentBodyText, commentEntries };

var commentFilter;

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
  preferences().taggingHelpShown();
  card.focus({ preventScroll: true });
  updateTaggingHelpCover();
}

export function hideTaggingHelp() {
  var card = document.getElementById("tagging-help");
  if (!card || card.hidden) return;
  var hadFocus = card.contains(document.activeElement);
  card.hidden = true;
  card.classList.remove("is-covering");
  preferences().taggingHelpDismissed();
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

var pendingComment = null;
var composerVersion = 0;
var bindingsVersion = 0;
var commentTimers = new Set();

function ownsDocument(operation) {
  return stillOwns(Object.assign({}, operation, { connection: captureOperation().connection }));
}

function commentTimer(fn, delay) {
  var version = bindingsVersion;
  var operation = captureOperation();
  var timer = setTimeout(function () {
    if (version !== bindingsVersion) return;
    commentTimers.delete(timer);
    if (ownsDocument(operation)) fn();
  }, delay);
  commentTimers.add(timer);
  return timer;
}

export function captureCommentComposer() {
  var operation = captureOperation();
  var version = composerVersion;
  var modal = document.getElementById("comment-modal");
  var body = document.getElementById("comment-body-editable");
  return function () {
    if (!ownsDocument(operation) || version !== composerVersion) return null;
    var liveModal = document.getElementById("comment-modal");
    var liveBody = document.getElementById("comment-body-editable");
    return liveModal === modal && liveBody === body && liveModal && !liveModal.hidden ? liveBody : null;
  };
}

export function resetCommentBindings() {
  bindingsVersion++;
  composerVersion++;
  commentTimers.forEach(function (timer) { clearTimeout(timer); });
  commentTimers.clear();
  deleteConfirmation().disarm("comment");
  closeCommentMenu(false);
  pendingComment = null;
  expandedReplyIds = idMap();
  replyDrafts = idMap();
  document.getElementById("comment-modal").hidden = true;
  closeCommentsPanel();
  closeFieldPopovers(document.getElementById("comment-modal"));
  var body = document.getElementById("comment-body-editable");
  body.innerHTML = "";
  resetDraftHistory(body);
}

var expandedReplyIds = idMap();
var replyDrafts = idMap();

export var AUTHOR_NAME_FIELDS = "#settings-name, #comment-name, .reply-name-input, #identity-input, #guest-name";
var EMOJI_PART = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;
function wholeEmojiCut(value, at) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return at;
  var seg = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value).containing(at);
  return seg && seg.index < at && EMOJI_PART.test(seg.segment) ? seg.index : at;
}
export function limitAuthorNameField(field) {
  var value = field.value;
  var excess = Array.from(value).length - EDITOR_NAME_MAX;
  if (excess <= 0) return;
  var caret = field.selectionStart;
  var head = typeof caret === "number" && caret === field.selectionEnd ? Array.from(value.slice(0, caret)) : [];
  if (head.length < excess) {
    field.value = value.slice(0, wholeEmojiCut(value, codePointPrefix(value, EDITOR_NAME_MAX).length));
    return;
  }
  var cut = wholeEmojiCut(value, head.slice(0, head.length - excess).join("").length);
  field.value = value.slice(0, cut) + value.slice(caret);
  field.setSelectionRange(cut, cut);
}
export function getSavedAuthorName() {
  return cleanAuthorName(preferences().commentAuthor());
}
export function saveAuthorName(name) {
  preferences().rememberCommentAuthor(cleanAuthorName(name));
}

export function setCommentSortMode(mode) {
  const chosen = setCommentSort(mode);
  preferences().setCommentsSort(chosen);
  captureReplyDrafts();
  renderComments();
}

var COMMENT_FILTER_MODES = { open: true, resolved: true, all: true };

export function setCommentFilterMode(mode) {
  commentFilter.mode = COMMENT_FILTER_MODES[mode] ? mode : "open";
  preferences().setCommentFilter(commentFilter);
  captureReplyDrafts();
  renderComments();
}
export function setCommentAssigneeFilter(value) {
  commentFilter.assignee = value || "";
  preferences().setCommentFilter(commentFilter);
  captureReplyDrafts();
  renderComments();
}
function commentMatchesAssigneeFilter(c, assignee) {
  return matchesAssignee(c, assignee, getSavedAuthorName);
}

function commentAssigneeCandidates() {
  var seen = idMap(), out = [];
  function add(name) {
    var clean = plainText(name || "").trim();
    if (!clean || clean === "Anonymous") return;
    var norm = normalizeTagName(clean);
    if (seen[norm]) return;
    seen[norm] = true;
    out.push(clean);
  }
  (currentDocument()?.people || []).forEach(function (p) { add(p.name); });
  (currentDocument()?.comments || []).forEach(function (c) {
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
  runDocumentEdit(setCommentAssigneeCommand(id, name, sessionStamps.clock));
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
  const doc = currentDocument();
  if (!doc) return;
  var seg = document.getElementById("comments-filter-seg");
  if (seg) {
    var modeCounts = { open: 0, resolved: 0, all: 0 };
    doc.comments.forEach(function (c) {
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
    doc.comments.forEach(function (c) { if (commentMatchesFilterMode(c, mode) && matcher(c)) n++; });
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
    var clock = preferences().clock();
    return sameDay ? formatClock(d, clock) : formatDateClock(d, null, clock);
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

function commentLocationHtml(rowId, field) {
  if (field === "title") return "Document title";
  var idx = readSession(function (doc) { return rowIndexOf(doc, rowId); });
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
    escapeHtml(formatTimestampAbsolute(iso, preferences().clock())) + '">' + escapeHtml(formatRelativeTime(iso)) + '</time>';
}

function commentPositionCompare(a, b) {
  return compareCommentPositions(a, b, function (id) { return readSession(function (doc) { return rowIndexOf(doc, id); }); });
}

function anchorTextFromState(cmtId) {
  const doc = currentDocument();
  if (!doc) return null;
  var cIdx = findCommentIndex(cmtId);
  if (cIdx === -1) return null;
  const c = doc.comments[cIdx];
  const row = doc.rows[readSession(function (doc) { return rowIndexOf(doc, c.rowId); })];
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

function anchorUnwrapped(rowId, field, cmtId) {
  return function (doc) {
    var row = doc.rows[rowIndexOf(doc, rowId)];
    if (!row) return [];
    var container = inertBody(row[field] || "");
    var anchor = container.querySelector('.cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
    if (!anchor) return [];
    while (anchor.firstChild) anchor.parentNode.insertBefore(anchor.firstChild, anchor);
    anchor.parentNode.removeChild(anchor);
    return [{ rowId: rowId, field: field, html: container.innerHTML }];
  };
}

export function syncAnchorResolvedClasses() {
  const doc = currentDocument();
  if (!doc) return;
  var resolvedIds = idMap();
  doc.comments.forEach(function (c) { if (c.resolved) resolvedIds[c.id] = true; });
  document.querySelectorAll("#rows .cmt-anchor").forEach(function (el) {
    var id = el.getAttribute("data-cmt");
    el.classList.toggle("resolved", !!resolvedIds[id]);
  });
}

var COUNTED_KINDS = { adopt: true, server: true, recovery: true, reload: true };

export function commentsChanged(change) {
  if (COUNTED_KINDS[change.kind] || change.changes.whole || change.changes.docFields.indexOf("comments") !== -1) updateCommentsCount();
}

function updateCommentsCount() {
  const doc = currentDocument();
  if (!doc) return;
  const open = doc.comments.filter(function (c) { return !c.resolved; }).length;
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
  composerVersion++;
  pendingComment = ctx;
  editorSelection().dropLink();
  closeFieldPopovers(document.getElementById("comment-modal"));
  document.getElementById("comment-modal-quote").innerHTML =
    '“<span class="comment-quote-words">' + escapeHtml(ctx.quotedText) + '</span>”';
  var nameInput = document.getElementById("comment-name");
  nameInput.value = getSavedAuthorName();
  var bodyEl = document.getElementById("comment-body-editable");
  bodyEl.innerHTML = "";
  resetDraftHistory(bodyEl);
  document.getElementById("comment-modal").hidden = false;
  var resolveComposer = captureCommentComposer();
  commentTimer(function () { var body = resolveComposer(); if (body) body.focus(); }, 0);
}

export function closeCommentComposer(cancelled) {
  composerVersion++;
  document.getElementById("comment-modal").hidden = true;
  if (cancelled && pendingComment) {
    runDocumentEdit(unwrapCommentAnchorCommand(anchorUnwrapped(pendingComment.rowId, pendingComment.field, pendingComment.id)));
  }
  pendingComment = null;
  editorSelection().dropLink();
  closeFieldPopovers(document.getElementById("comment-modal"));
  document.getElementById("comment-body-editable").innerHTML = "";
  resetDraftHistory(document.getElementById("comment-body-editable"));
}

export function postComment() {
  if (!pendingComment) return;
  var nameInput = document.getElementById("comment-name");
  var author = cleanAuthorName(nameInput.value) || "Anonymous";
  saveAuthorName(author);
  var bodyEl = document.getElementById("comment-body-editable");
  var bodyHtml = sanitizeHtml(bodyEl.innerHTML);
  var hasMedia = /<img|video-embed-card/.test(bodyHtml);
  if (!bodyEl.textContent.trim() && !hasMedia) {
    showToast("Write a comment before posting.", "warn");
    return;
  }
  runDocumentEdit(addCommentCommand({
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
  }));
  document.getElementById("comment-modal").hidden = true;
  composerVersion++;
  pendingComment = null;
  bodyEl.innerHTML = "";
  resetDraftHistory(bodyEl);
  sendNow();
}

function sendNow() {
  if (reviewMode()) resumeAutoSave();
  autoSavePolicy().dueNow();
}

function findCommentIndex(id) {
  const doc = currentDocument();
  if (!doc) return -1;
  for (let i = 0; i < doc.comments.length; i++) if (doc.comments[i].id === id) return i;
  return -1;
}

export function openCommentsPanel() {
  if (!currentDocument()) return;
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
  runDocumentEdit(toggleResolveCommand(id, sessionStamps));
}

function deleteComment(id) {
  const doc = currentDocument();
  if (!doc) return;
  var idx = findCommentIndex(id);
  if (idx === -1) return;
  const c = doc.comments[idx];
  delete expandedReplyIds[id];
  delete replyDrafts[id];
  if (commentMenuFor === id) commentMenuFor = null;
  runDocumentEdit(deleteCommentCommand(id, anchorUnwrapped(c.rowId, c.field, c.anchorId)));
}

export function armDeleteComment(btn, id) {
  if (deleteConfirmation().armedId("comment") === id) {
    deleteConfirmation().disarm("comment");
    deleteComment(id);
    return;
  }
  deleteConfirmation().arm("comment", id, function () {
    renderComments();
  }, undefined, { start: commentTimer, stop: function (timer) { clearTimeout(timer); } });
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
  var author = cleanAuthorName(nameInput.value) || "Anonymous";
  saveAuthorName(author);
  var bodyHtml = sanitizeHtml(bodyEl.innerHTML);
  if (!bodyEl.textContent.trim()) {
    showToast("Write a reply before posting.", "warn");
    return;
  }
  delete expandedReplyIds[id];
  delete replyDrafts[id];
  runDocumentEdit(addReplyCommand(id, {
    id: makeId("rp"),
    author: author,
    body: bodyHtml,
    createdAt: nowIso()
  }, sessionStamps.clock));
  sendNow();
}

export function jumpToAnchor(cmtId) {
  const doc = currentDocument();
  if (!doc) return;
  var cIdx = findCommentIndex(cmtId);
  if (cIdx !== -1) revealRow(doc.comments[cIdx].rowId);
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
  const doc = currentDocument();
  if (!doc) return;
  var idx = findCommentIndex(cmtId);
  const target = idx === -1 ? null : doc.comments[idx];
  if (target && (!commentMatchesFilterMode(target, commentFilter.mode) ||
      !commentMatchesAssigneeFilter(target, commentFilter.assignee))) {
    commentFilter.mode = "all";
    commentFilter.assignee = "";
    preferences().setCommentFilter(commentFilter);
    captureReplyDrafts();
    renderComments();
  }
  openCommentsPanel();
  var panel = document.getElementById("comments-panel");
  commentTimer(function () {
    if (document.getElementById("comments-panel") !== panel) return;
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
  var armed = deleteConfirmation().armedId("comment") === c.id;
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
  if (deleteConfirmation().armedId("comment") === id) { deleteConfirmation().disarm("comment"); }
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
  const doc = currentDocument();
  if (!doc) return;
  var ci = findCommentIndex(commentId);
  if (ci === -1) return;
  const c = doc.comments[ci];
  if (c.field === "title") {
    pushSnapshot("Before using your version of the title");
    runDocumentEdit(restoreConflictCommand(commentId, { kind: "title", title: c.emptyValue ? "" : (c.titleValue || "") }, sessionStamps));
    showToast("Restored your version of the title", "ok");
    return;
  }
  var ri = readSession(function (doc) { return rowIndexOf(doc, c.rowId); });
  if (ri === -1) { showToast("That scene no longer exists.", "warn"); return; }

  pushSnapshot("Before using your version of " + (c.conflictField || "a field"));
  var value = c.field === "visualImage"
    ? { kind: "image", imageRef: c.emptyValue ? null : (normalizeImageRef(c.imageValue) || null) }
    : { kind: "text", html: c.emptyValue ? "" : sanitizeHtml(c.body) };
  runDocumentEdit(restoreConflictCommand(commentId, value, sessionStamps));
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
  const doc = currentDocument();
  if (!doc) return;
  var listEl = document.getElementById("comments-list");
  if (!listEl) return;
  renderCommentFilterBar();
  let items = doc.comments.filter(function (c) {
    return commentMatchesFilterMode(c, commentFilter.mode) && commentMatchesAssigneeFilter(c, commentFilter.assignee);
  });
  items = items.slice().sort(commentSortMode() === "recent" ? commentRecentOrder : commentPositionCompare);
  if (!items.length) {
    listEl.innerHTML = '<div class="comments-empty">' + (doc.comments.length ? "No comments match this filter." : "No comments yet.") + '</div>' +
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
  setCommentSort(preferences().commentsSort());

  commentFilter = preferences().commentFilter();

  document.addEventListener("mousedown", onCommentMenuMouseDown, true);
  document.addEventListener("keydown", onCommentMenuKeydown, true);

  initTaggingHelp();
}
