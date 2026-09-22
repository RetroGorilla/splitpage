import { S } from "./_state.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml, makeId } from "./02-state.js";
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
  safeImageSrc,
  sanitizeHtml
} from "./04-richtext.js";
import { pad2, render } from "./05-render.js";
import { normalizeTagName } from "./07-production-tags.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { htmlToPlainText, queueAutoSave, resumeAutoSave } from "./14-export.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var commentFilter;

/* ================= comments ================= */

export var TAGGING_HELP_KEY = "splitpage-tagging-help-dismissed";

export function showTaggingHelp() {
  document.getElementById("tagging-help").hidden = false;
  try { localStorage.setItem(TAGGING_HELP_KEY, "0"); } catch (e) {}
  document.getElementById("tagging-help").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export var COMMENT_NAME_KEY = "splitpage-comment-author";
var pendingComment = null;
var expandedReplyIds = {};
var replyDrafts = {};
S.deleteCommentArmId = null;
export var deleteCommentArmTimer = null;

export function nowIso() { return new Date().toISOString(); }

export function getSavedAuthorName() {
  try { return localStorage.getItem(COMMENT_NAME_KEY) || ""; } catch (e) { return ""; }
}
export function saveAuthorName(name) {
  try { localStorage.setItem(COMMENT_NAME_KEY, name); } catch (e) {}
}

/* How you like the comments list ordered — about the reader, not the
   document, so it lives in this browser rather than in the file (same
   reasoning as the writer's text size). "position" (script order) is the
   default: it's where new-here readers expect a comment to be, right next
   to the row it's about. "recent" is for coming back after a while and
   wanting to see what actually moved, wherever in the script it was. */
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

/* ---- filter (Open / Resolved / All, and who it's assigned to) ----

   A reader preference like the sort mode above, not part of the document
   — same reasoning, same storage. This replaces the old "Hide resolved"
   checkbox, which (unlike the sort mode) was never itself persisted: it
   reset to unchecked — meaning "show everything" — on every reload.
   COMMENTS_FILTER_LEGACY_KEY costs nothing to check and means a saved
   preference from an interim build, if one ever existed, still carries
   over rather than silently resetting to the new default. */
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
function commentMatchesFilterMode(c, mode) {
  if (mode === "resolved") return !!c.resolved;
  if (mode === "all") return true;
  return !c.resolved; /* "open" */
}
function commentMatchesAssigneeFilter(c, assignee) {
  if (!assignee) return true;
  if (assignee === "__unassigned__") return !c.assignee;
  if (assignee === "me") {
    var me = normalizeTagName(getSavedAuthorName());
    return !!me && normalizeTagName(c.assignee || "") === me;
  }
  return normalizeTagName(c.assignee || "") === normalizeTagName(assignee);
}

/* ---- assignment ----

   Not an identity system — same as comment authors and the production
   crew list, this is just a name someone typed. The picker offers
   everyone already in the production breakdown plus anyone who has ever
   posted a comment or reply, so "assign to the editor" works whether or
   not the editor has a crew-list entry yet. */
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
  /* Assigning a thread changes a comment that is already stored, and a
     review session has no route for that — only for adding a comment or a
     reply, and for resolving (#71). The select is rendered disabled for
     one; this is the guard behind it, and the render puts the select back
     to what is actually stored. */
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
  var html = '<option value=""' + (current ? "" : " selected") + '>Unassigned</option>';
  candidates.forEach(function (name) {
    var sel = normalizeTagName(name) === normalizeTagName(current || "");
    if (sel) found = true;
    html += '<option value="' + escapeHtml(name) + '"' + (sel ? " selected" : "") + '>' + escapeHtml(name) + '</option>';
  });
  /* A current assignee that fell out of the candidate list (the only
     commenter with that name was deleted from state.people, say) still
     has to be shown, not silently swapped for "Unassigned" the moment
     the panel re-renders. */
  if (current && !found) {
    html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
  }
  return html;
}

/* Rebuilds the filter bar's active state, counts, and the assignee
   dropdown's options — called once per renderComments(), before the list
   itself, since the counts always describe the CURRENT document, not the
   currently-visible slice of it. Open/Resolved/All counts are scoped to
   the current assignee filter, and the assignee dropdown's own counts are
   scoped to the current Open/Resolved/All tab — each narrows the other,
   the way a faceted filter normally does. */
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
  /* A stored filter naming someone who has since dropped out of the
     candidate list (their one comment was deleted, say) still has to
     stay selected and keep filtering by that name, not silently widen
     back to "Everyone" out from under whoever set it on another device. */
  if (!currentIsSpecial && current && !currentFound) {
    html += '<option value="' + escapeHtml(current) + '">' + escapeHtml(current) + ' (' +
      countFor(function (c) { return normalizeTagName(c.assignee || "") === normalizeTagName(current); }) + ')</option>';
  }
  select.innerHTML = html;
  select.value = current;
}

/* Comments panel width (drag-to-resize handle) moved to
   03b-side-panels.js — it now covers every side panel, not just this
   one. */

export function formatTimestamp(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var opts = sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return d.toLocaleString(undefined, opts);
  } catch (e) { return ""; }
}

/* "Resolved by Adam · 2 days ago" wants a relative phrase, not a clock
   time — formatTimestamp's "3:04 PM" reads fine for something posted
   today, but is meaningless once the document has sat resolved for a
   while. Rounds to the coarsest unit that isn't zero; negative deltas
   (clock skew between two people's machines) read as "just now" rather
   than a confusing negative count. */
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

/* Unlike formatTimestamp() (which says "3:04 PM" for anything posted
   today), exports need an absolute date — the document may be opened
   long after "today" has stopped meaning anything. */
function formatTimestampAbsolute(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (e) { return ""; }
}

/* Script order: by row, then Visual before Audio, then post time as a
   tiebreak within the same field. Shared by the export appendix (which has
   always used this) and the panel's default sort (which now does too),
   so "where a comment sits in the list" means the same thing in both. */
function commentPositionCompare(a, b) {
  var ai = findRowIndex(a.rowId); if (ai === -1) ai = Infinity;
  var bi = findRowIndex(b.rowId); if (bi === -1) bi = Infinity;
  if (ai !== bi) return ai - bi;
  var af = a.field === "audioText" ? 1 : 0, bf = b.field === "audioText" ? 1 : 0;
  if (af !== bf) return af - bf;
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

/* The most recent thing said about a comment — its own post time, or a
   later reply's, whichever is newer. Replies count on purpose: a thread
   someone just answered is exactly as "active" as a brand new comment,
   and sorting by the comment's own createdAt alone would leave a
   just-replied-to thread buried whereever it started out. */
function commentLastActivity(c) {
  var t = c.createdAt || "";
  (c.replies || []).forEach(function (r) {
    if ((r.createdAt || "") > t) t = r.createdAt;
  });
  return t;
}

/* Every comment and reply, flattened and ordered to match the document —
   for exports to append as a plain-text appendix. None of these formats
   can reproduce inline comment bubbles, so this keeps every export honest
   about what a comment thread actually said rather than silently
   dropping it. Always script order, regardless of how the panel itself is
   currently sorted — a file's own appendix should read the same way twice. */
export function commentEntries() {
  var list = (S.state.comments || []).slice();
  list.sort(commentPositionCompare);
  return list.map(function (c) {
    return {
      location: findAnchorLocationLabel(c.rowId, c.field),
      author: c.author || "Anonymous",
      body: htmlToPlainText(c.body),
      quoted: c.quotedText || "",
      resolved: !!c.resolved,
      resolvedBy: c.resolved ? (c.resolvedBy || "") : "",
      assignee: c.assignee || "",
      when: formatTimestampAbsolute(c.createdAt),
      replies: (c.replies || []).map(function (rp) {
        return {
          author: rp.author || "Anonymous",
          body: htmlToPlainText(rp.body),
          when: formatTimestampAbsolute(rp.createdAt)
        };
      })
    };
  });
}

/* anchorLiveText's fallback for a row the "hide shot scenes" toggle
   (issue #25) has folded into a strip: the anchor is not missing, it just
   is not rendered right now. Re-derives its text from the row's own
   stored HTML — the same source rowHtml() would render from — so a
   hidden comment never reads as orphaned. Returns null exactly when the
   span really is gone, same as the DOM path. */
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

/* The `.cmt-anchor` span is editable on purpose — a comment must never
   lock the writer out of their own sentence — so the words inside it can
   drift away from `c.quotedText` without the anchor itself disappearing.
   This reads the span's current plain text so the card can show *that*
   is stale, rather than silently claiming the quote is still accurate.
   Returns null when the span itself is gone (the orphaned case). */
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

/* ---- composer (new top-level comment) ---- */

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
  document.getElementById("comment-modal-quote").textContent = ctx.quotedText;
  var nameInput = document.getElementById("comment-name");
  nameInput.value = getSavedAuthorName();
  var bodyEl = document.getElementById("comment-body-editable");
  bodyEl.innerHTML = "";
  document.getElementById("comment-modal").hidden = false;
  /* always focus the comment body (not the name field) — the name is optional
     and defaults to "Anonymous", so it must never be where typing lands first */
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
  render();
  sendNow();
}

/* After posting a comment or a reply. In a review session this is where
   the comment leaves for the server (saveToServer's review branch, #71), and
   pressing Post is the reader asking for exactly that — so an autosave that
   an earlier failure paused does not hold it back, the same way pressing
   Save does not wait for one. Everywhere else it is the ordinary autosave. */
function sendNow() {
  if (reviewMode()) resumeAutoSave();
  queueAutoSave();
}

/* ---- panel + cards ---- */

function findCommentIndex(id) {
  for (var i = 0; i < S.state.comments.length; i++) if (S.state.comments[i].id === id) return i;
  return -1;
}

export function openCommentsPanel() {
  if (!S.state) return;
  openSidePanel("comments-panel");
  /* closeCommentsPanel only hides the panel — an open reply composer with
     unsaved typed text is still sitting there in the DOM. Capture it
     before rebuilding comments-list's innerHTML, or reopening the panel
     silently throws away whatever was mid-typing. */
  captureReplyDrafts();
  renderComments();
}
export function closeCommentsPanel() {
  document.getElementById("comments-panel").hidden = true;
  syncPanelClass();
}

export function toggleResolve(id) {
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
  markDirty();
  render();
  queueAutoSave();
}

/* deleteCommentArmId is the single source of truth for which delete
   button is armed — commentCardHtml/conflictCardHtml render "Confirm?"
   off it directly, rather than this function poking classList/textContent
   on a DOM node it happens to have a reference to. That imperative poke
   used to be the only place the armed look ever got applied, so any
   unrelated re-render (a reply posted elsewhere, a resolve toggled on a
   different card, even just reopening the panel) rebuilt the button back
   to plain "Delete" while deleteCommentArmId stayed set — leaving the
   very next click, which looked like the first, actually fire the
   delete with no visible confirm step. */
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
  /* Deliberately does NOT close the panel. The point of jumping is to see
     the comment next to the text it is about — closing the one to look at
     the other defeats that, and on anything wider than 1100px the panel
     already leaves the script uncovered (see the padding-right rule on
     body.panel-open #root), so there is nothing to close it FOR. */
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
      '<input type="text" class="reply-name-input" placeholder="Your name" value="' +
        escapeHtml(draft.name !== undefined ? draft.name : getSavedAuthorName()) + '" autocomplete="off">' +
      '<div class="field-wrap" style="margin-top:6px;">' +
        '<div class="mini-toolbar" role="toolbar" aria-label="Reply formatting">' +
          '<button type="button" data-cmd="bold" title="Bold">B</button>' +
          '<button type="button" data-cmd="italic" title="Italic"><i>I</i></button>' +
          '<button type="button" data-cmd="underline" title="Underline"><u>U</u></button>' +
          '<button type="button" data-cmd="link" title="Add link">Link</button>' +
        '</div>' +
        '<div class="cell-editable" contenteditable="true" data-placeholder="Write a reply…">' + (draft.body || "") + '</div>' +
        '<div class="link-popover" hidden>' +
          '<input type="url" placeholder="https://example.com" data-role="link-input">' +
          '<button type="button" data-action="link-confirm">Add</button>' +
          '<button type="button" data-action="link-cancel">Cancel</button>' +
        '</div>' +
      '</div>' +
      '<div class="comment-actions">' +
        '<button type="button" data-action="reply-post" data-id="' + commentId + '">Post reply</button>' +
        '<button type="button" data-action="reply-cancel" data-id="' + commentId + '">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

/* "Resolved by Adam · 2 days ago" — blank the instant a comment is
   unresolved (toggleResolve/migrateRows both clear resolvedBy/resolvedAt
   together), so this never shows stale attribution for an open thread.
   A comment resolved before this feature existed has resolved=true but
   no resolvedBy, which just falls back to a bare "Resolved". */
function commentResolvedNoteHtml(c) {
  if (!c.resolved || !c.resolvedBy) return "";
  return '<div class="comment-resolved-note">Resolved by ' + escapeHtml(c.resolvedBy) +
    (c.resolvedAt ? ' · ' + escapeHtml(formatRelativeTime(c.resolvedAt)) : '') + '</div>';
}

function commentCardHtml(c) {
  if (c.kind === "conflict") return conflictCardHtml(c);
  /* Orphaned: the span is gone, or emptied out by editing until nothing is
     left to anchor to — either way there is no text left to jump to, so it
     falls back to the existing not-in-script path. Changed: the span still
     exists and still has text, but the writer edited the words inside it,
     so `c.quotedText` (never rewritten — the quote is historical) no
     longer matches what is actually there. Still jumpable (the anchor is
     real), but the card has to say so rather than silently showing a
     stale quote as if it were current. */
  var liveText = anchorLiveText(c.id);
  var orphaned = liveText === null || liveText.length === 0;
  var changed = !orphaned && liveText !== c.quotedText;
  var repliesHtml = "";
  if (c.replies.length) {
    repliesHtml = '<div class="comment-replies">' + c.replies.map(function (r) {
      return (
        '<div class="reply-card">' +
          '<div class="reply-head"><span class="reply-author">' + escapeHtml(r.author) + '</span><span class="reply-time">' + formatTimestamp(r.createdAt) + '</span></div>' +
          '<div class="reply-body">' + r.body + '</div>' +
        '</div>'
      );
    }).join("") + '</div>';
  }
  return (
    '<div class="comment-card' + (c.resolved ? ' is-resolved' : '') + (orphaned ? '' : ' is-jumpable') +
      '" data-id="' + c.id + '"' + (orphaned ? '' : ' title="Click to jump to this text in the script"') + '>' +
      '<div class="comment-card-head">' +
        '<span class="comment-author">' + escapeHtml(c.author) + '</span>' +
        '<span class="comment-time">' + formatTimestamp(c.createdAt) + '</span>' +
      '</div>' +
      commentResolvedNoteHtml(c) +
      '<div class="comment-loc">' + escapeHtml(findAnchorLocationLabel(c.rowId, c.field)) + '</div>' +
      (orphaned ?
        '<div class="comment-quote orphaned">“' + escapeHtml(c.quotedText) + '”' +
          '<div class="comment-orphan-note">Text no longer found in the script</div>' +
        '</div>' :
      changed ?
        '<div class="comment-quote changed" title="Originally: “' + escapeHtml(c.quotedText) + '”">' +
          '“' + escapeHtml(liveText) + '”' +
          '<div class="comment-orphan-note">Text changed — was <s>' + escapeHtml(c.quotedText) + '</s></div>' +
        '</div>' :
        '<div class="comment-quote">“' + escapeHtml(c.quotedText) + '”</div>'
      ) +
      '<div class="comment-body">' + c.body + '</div>' +
      repliesHtml +
      (expandedReplyIds[c.id] ? replyComposerHtml(c.id) : "") +
      '<div class="comment-assign-row">' +
        '<label for="comment-assignee-' + c.id + '">Assign</label>' +
        '<select class="comment-assignee-select" id="comment-assignee-' + c.id + '" data-id="' + c.id + '" aria-label="Assign this thread to"' +
          (reviewMode() ? ' disabled' : '') + '>' +
          commentAssigneeOptionsHtml(c.assignee) +
        '</select>' +
      '</div>' +
      '<div class="comment-actions">' +
        /* A review session adds to a thread and does not delete one: a
           review token's only writes are the comment routes (#71), and
           there is no route for a delete. Resolving HAS one (PATCH
           …/comments/:id), and saveToServer's review branch sends a resolve
           this view holds, but the button is not offered here yet —
           21-events.js's click guard (REVIEW_SAFE_ACTIONS) still refuses
           toggle-resolve from a review session, and the two have to change
           together. */
        (reviewMode() ? '' :
          '<button type="button" data-action="toggle-resolve" data-id="' + c.id + '">' +
            (c.resolved ? "Unresolve" : "Resolve") + '</button>') +
        (expandedReplyIds[c.id] ? "" : '<button type="button" data-action="toggle-reply" data-id="' + c.id + '">Reply</button>') +
        (reviewMode() ? '' :
          '<button type="button" class="danger' + (S.deleteCommentArmId === c.id ? ' armed' : '') +
            '" data-action="delete-comment" data-id="' + c.id + '">' +
            (S.deleteCommentArmId === c.id ? "Confirm?" : "Delete") + '</button>') +
      '</div>' +
    '</div>'
  );
}

/* A card holding one edit that could not be merged automatically —
   the user's own version, kept verbatim with a one-click way to put it back. */
function conflictCardHtml(c) {
  return (
    '<div class="comment-card is-conflict' + (c.resolved ? ' is-resolved' : '') + '" data-id="' + c.id + '">' +
      '<div class="conflict-flag">⚠ Unmerged edit · ' + escapeHtml(c.conflictField || "Field") + '</div>' +
      '<div class="comment-card-head">' +
        '<span class="comment-author">' + escapeHtml(c.author) + '</span>' +
        '<span class="comment-time">' + formatTimestamp(c.createdAt) + '</span>' +
      '</div>' +
      commentResolvedNoteHtml(c) +
      '<div class="comment-loc">' + escapeHtml(findAnchorLocationLabel(c.rowId, c.field)) + '</div>' +
      '<div class="comment-quote">Someone else changed this at the same time. Their version is live; yours is below.</div>' +
      '<div class="comment-body">' + (c.emptyValue ? "<em>(you had cleared this)</em>" : c.body) + '</div>' +
      '<div class="comment-actions">' +
        /* All three write the document: "Use my version" puts text back
           into a row, and the other two change a stored comment. */
        (reviewMode() ? '' :
          '<button type="button" data-action="restore-conflict" data-id="' + c.id + '">Use my version</button>' +
          '<button type="button" data-action="toggle-resolve" data-id="' + c.id + '">' +
            (c.resolved ? "Unresolve" : "Keep theirs") + '</button>' +
          '<button type="button" class="danger' + (S.deleteCommentArmId === c.id ? ' armed' : '') +
            '" data-action="delete-comment" data-id="' + c.id + '">' +
            (S.deleteCommentArmId === c.id ? "Confirm?" : "Delete") + '</button>') +
      '</div>' +
    '</div>'
  );
}

/* put the stashed version back into the row it came from */
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
  if (ri === -1) { showToast("That row no longer exists.", "warn"); return; }

  pushSnapshot("Before using your version of " + (c.conflictField || "a field"));
  var container = inertBody(c.body);
  if (c.field === "visualImage") {
    var img = container.querySelector("img");
    S.state.rows[ri].visualImage = img ? safeImageSrc(img.getAttribute("src")) : null;
  } else {
    /* an empty original must come back empty, not as placeholder text */
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

export function renderComments() {
  if (!S.state) return;
  var listEl = document.getElementById("comments-list");
  if (!listEl) return;
  renderCommentFilterBar();
  var items = S.state.comments.filter(function (c) {
    return commentMatchesFilterMode(c, commentFilter.mode) && commentMatchesAssigneeFilter(c, commentFilter.assignee);
  });
  items = items.slice().sort(S.commentSortMode === "recent"
    ? function (a, b) { return commentLastActivity(b).localeCompare(commentLastActivity(a)); }
    : commentPositionCompare);
  if (!items.length) {
    listEl.innerHTML = '<div class="comments-empty">' + (S.state.comments.length ? "No comments match this filter." : "No comments yet. Select text in a row and click 💬 Comment to leave one.") + '</div>';
    return;
  }
  listEl.innerHTML = items.map(commentCardHtml).join("");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  S.commentSortMode = readCommentSortMode();

  commentFilter = readCommentFilter();
}
