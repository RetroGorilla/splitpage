import { S } from "./_state.js";
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

/* The empty choice reads "Assign…" while nobody has the thread — the
   select is the card's Assign button (#169), and that is what it says at
   rest — and "Unassigned" once somebody does, where picking it is how the
   thread is taken back. A review session's select is disabled and never
   an invitation, so it always says "Unassigned". */
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

/* The same place, as a thread's card says it (#169): "Scene 03 · Audio",
   the number in the mono as everywhere else a scene is named. The export
   appendix keeps findAnchorLocationLabel()'s "Row 03" — a file's wording
   is not the panel's to change. */
function commentLocationHtml(rowId, field) {
  if (field === "title") return "Document title";
  var idx = findRowIndex(rowId);
  var fieldLabel = field === "audioText" ? "Audio" : "Visual";
  if (idx === -1) return "Deleted scene · " + fieldLabel;
  return 'Scene <span class="comment-loc-num">' + pad2(idx + 1) + '</span> · ' + fieldLabel;
}

/* Each open thread's number (#169): the number its words carry in the
   script, where a CSS counter draws it after each open anchor (app.css
   `#rows .cmt-anchor:not(.resolved)::after`). So it is counted the way the
   counter counts — down the rendered script, open anchors only — and read
   from the DOM, not from state, because the DOM is what the counter sees:
   a thread whose words are gone, or folded away with the shot scenes, has
   no marker there and no number here, and nor has a resolved one.
   renderComments() runs at the end of render(), after #rows is painted,
   so it always numbers the finished script.

   The counter steps at each anchor's END (::after), so a span nested in
   another — two comments over overlapping words — counts before the one
   around it; the sort below puts the spans in that order. A thread whose
   words sit in two spans (the overlap again, or a split scene) has two
   markers in the script and takes the first one's number, so the numbers
   on the cards can skip one; every card still names the marker beside
   its words. */
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

/* A person on a card: the panels' avatar in their colour (personColor,
   13a-presence.js — the one table), holding their first letter. */
function commentAvatarHtml(name) {
  var first = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar comment-avatar" style="--size:28px;--presence:' + personColor(name) +
    '" aria-hidden="true">' + escapeHtml(first.toUpperCase()) + '</span>';
}

/* "2 hours ago", with the date and time on hover — a thread is read as a
   conversation, and how long ago someone said something is what matters
   in one. No role beside it: the board's "Reviewer" / "Host" are not
   stored anywhere, and an author is only ever a typed name. */
function commentTimeHtml(iso, cls) {
  return '<time class="' + cls + '" datetime="' + escapeHtml(iso || "") + '" title="' +
    escapeHtml(formatTimestampAbsolute(iso)) + '">' + escapeHtml(formatRelativeTime(iso)) + '</time>';
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
   currently sorted — a file's own appendix should read the same way twice.

   `body` is plain text, and a picture in it is simply gone. A writer that
   can draw pictures (the PDF, the .docx) passes {pieces:true} and gets,
   beside the same `body`, each comment's and reply's `pieces`: the body in
   order as {text} and {image: <sha>} — see bodyPieces. The text-only
   writers (Markdown, CSV, .txt) ask too, for commentBodyText's "[image]"
   placeholders; `body` itself is the same either way. */
export function commentEntries(opts) {
  var pieces = !!(opts && opts.pieces);
  var list = (S.state.comments || []).slice();
  list.sort(commentPositionCompare);
  return list.map(function (c) {
    var entry = {
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

/* A comment or reply body as the ordered pieces a picture-drawing writer
   lays out: {text} runs between the pictures and {image: <sha>} for each
   stored `<img data-blob>` (#82 P6), in document order — the sha alone,
   since an image whose bytes this page has never seen is stored without
   its size and type, and the writer reads both off the bytes anyway. Text is read the way
   htmlToPlainText reads it — <br> a newline, every text node in order, a
   no-break space a space — and trimmed per piece, since a picture is a
   block of its own and the line breaks around it say nothing more. A body
   with no picture is one {text} piece equal to `body` exactly, or none. */
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

/* An image conflict card's picture is its `imageValue` (the record "Use
   my version" puts back, and what the card draws — conflictBodyHtml), so
   that is what prints, not the body that mirrors it. */
function commentBodyPieces(c) {
  if (c.kind === "conflict" && c.field === "visualImage") {
    var ref = normalizeImageRef(c.imageValue);
    return ref ? [{ image: ref.sha256 }] : [];
  }
  return bodyPieces(c.body);
}

/* A comment's or reply's body (from commentEntries({pieces:true})) for a
   writer that can only write text — Markdown, CSV, .txt: `body` exactly,
   when it holds no picture, and otherwise its pieces in reading order with
   each picture a COMMENT_IMAGE_TEXT line of its own, so a picture-only
   comment or an image conflict card no longer reads "(empty)". The
   pictures themselves are not carried; "" still means an empty body. */
export var COMMENT_IMAGE_TEXT = "[image]";

export function commentBodyText(entry) {
  var pieces = (entry && entry.pieces) || [];
  if (!pieces.some(function (p) { return p.image; })) return entry.body;
  return pieces.map(function (p) { return p.image ? COMMENT_IMAGE_TEXT : p.text; }).join("\n");
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
  /* the words as a thread's card shows them (#169): quoted, underlined */
  document.getElementById("comment-modal-quote").innerHTML =
    '“<span class="comment-quote-words">' + escapeHtml(ctx.quotedText) + '</span>”';
  var nameInput = document.getElementById("comment-name");
  nameInput.value = getSavedAuthorName();
  var bodyEl = document.getElementById("comment-body-editable");
  bodyEl.innerHTML = "";
  /* a new draft: the last one's edits are not this one's to undo */
  resetDraftHistory(bodyEl);
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
  /* Editors only (see commentCardHtml): the click guard already refuses
     this in a review session, and this is the last door behind it. */
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

/* The reply box, in line with the comments above it (#169): the words
   first, then who is writing and the two buttons, Post reply the amber
   one. Closed, it is the outlined "Write a reply…" control in
   commentReplyHtml() below. */
function replyComposerHtml(commentId) {
  var draft = replyDrafts[commentId] || {};
  return (
    '<div class="reply-composer" data-for="' + commentId + '">' +
      /* The same cell builder as a script field (05-render.js) — which is
         what gives a reply box the script's toolbar handling for free. */
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

/* Where a reply is written: the box itself while it is open, and until
   then a control drawn as that box, which opens it. It is the card's
   toggle-reply button, the one a review session keeps (21-events.js
   REVIEW_SAFE_ACTIONS) — replying is the one thing a reviewer does here. */
function commentReplyHtml(c) {
  return '<div class="comment-reply">' +
    (expandedReplyIds[c.id] ? replyComposerHtml(c.id) :
      '<button type="button" class="comment-reply-open" data-action="toggle-reply" data-id="' + c.id + '">Write a reply…</button>') +
  '</div>';
}

/* One said thing in a thread — the opening comment or a reply — as the
   board draws each: the avatar, the bold name and when, then the words.
   The classes a reply has always had (reply-card, reply-author, reply-time,
   reply-body) stay on a reply; the opening comment keeps comment-author,
   comment-time and comment-body. */
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

/* ---- the thread's "⋯" menu (#169) ----

   The same menu as Production's and B-roll's "⋯": Delete inside it, with
   its arm-to-confirm (first click "Delete?", the second deletes, the arm
   times out — armDeleteComment). Which thread's menu is open is state, not
   DOM, the way B-roll keeps its own (08d-broll-panel.js menuFor): arming
   Delete re-renders the list, and so does anything else that lands while
   the menu is up — a reply posted, a merge — and the menu has to be drawn
   open again each time rather than lost. Closing it (a press outside,
   Escape, Tab) only takes it out of the DOM: a re-render on the press
   would replace whatever the press was about to click. */
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

/* Down from the "⋯", or up when the list has no room under it — the
   last card on screen — the way the other panels' menus do. */
function placeCommentMenu() {
  var menu = commentMenuEl();
  if (!menu) return;
  menu.classList.remove("opens-up");
  var list = document.getElementById("comments-list");
  var box = list.getBoundingClientRect();
  var r = menu.getBoundingClientRect();
  if (r.bottom > box.bottom - 8 && r.top - r.height - 40 > box.top + 8) menu.classList.add("opens-up");
}

/* Closed without a re-render, and the arm goes with it: a "Delete?" that
   is no longer on screen must not be waiting for a click. */
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

/* The "⋯" itself (onRootClick, 21-events.js): opens this thread's menu
   with the focus on its first item, or closes it back onto the "⋯". */
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

/* The keyboard, as the other panels' menus have it: ArrowDown/Up on the
   "⋯" opens it, Escape closes it back onto the "⋯", Tab leaves it
   closed. Capture phase, so the Escape that closes a menu does not also
   close the panel (the window's Escape, 21-events.js). */
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

/* "Resolved by Adam · 2 days ago" — blank the instant a comment is
   unresolved (toggleResolve/migrateRows both clear resolvedBy/resolvedAt
   together), so this never shows stale attribution for an open thread.
   A comment resolved before this feature existed has resolved=true but
   no resolvedBy, which just falls back to a bare "Resolved". */
function commentResolvedNoteHtml(c) {
  if (!c.resolved || !c.resolvedBy) return "";
  return '<div class="comment-resolved-note"><svg aria-hidden="true"><use href="#i-check-circle"/></svg>Resolved by ' + escapeHtml(c.resolvedBy) +
    (c.resolvedAt ? ' · ' + escapeHtml(formatRelativeTime(c.resolvedAt)) : '') + '</div>';
}

/* One card per thread (#169, B-PanelComments): what it is about on top —
   the thread's number, where it sits and the words — then the
   conversation, the reply box, and a foot bar with the thread's actions. */
function commentCardHtml(c, num) {
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
  var review = reviewMode();
  var entries = commentEntryHtml(c.author, c.createdAt, c.body, false) +
    c.replies.map(function (r) { return commentEntryHtml(r.author, r.createdAt, r.body, true); }).join("");
  return (
    '<div class="comment-card' + (c.resolved ? ' is-resolved' : '') + (orphaned ? '' : ' is-jumpable') +
      '" data-id="' + c.id + '"' + (orphaned ? '' : ' title="Click to jump to this text in the script"') + '>' +
      '<div class="comment-card-head">' +
        '<div class="comment-card-where">' +
          /* the same amber marker the words carry in the script, filled */
          (num ? '<span class="comment-num" role="img" aria-label="Thread ' + num + '">' + num + '</span>' : '') +
          /* A button with no action of its own: its click falls through to
             the card's jump (onRootClick, 21-events.js), so this is the
             card's "go to these words" said out loud, and a keyboard's way
             to it. Nothing to go to once the words are gone. */
          (orphaned
            ? '<span class="comment-loc">' + commentLocationHtml(c.rowId, c.field) + '</span>'
            : '<button type="button" class="jump-link comment-loc" title="Go to these words in the script"><span>' +
                commentLocationHtml(c.rowId, c.field) + '</span><svg aria-hidden="true"><use href="#i-arrow-right"/></svg></button>') +
        '</div>' +
        (orphaned ?
          '<div class="comment-quote orphaned">“<span class="comment-quote-words">' + escapeHtml(c.quotedText) + '</span>”' +
            '<div class="comment-orphan-note">Text no longer found in the script</div>' +
          '</div>' :
        changed ?
          '<div class="comment-quote changed" title="Originally: “' + escapeHtml(c.quotedText) + '”">' +
            '“<span class="comment-quote-words">' + escapeHtml(liveText) + '</span>”' +
            '<div class="comment-orphan-note">Text changed — was <s>' + escapeHtml(c.quotedText) + '</s></div>' +
          '</div>' :
          '<div class="comment-quote">“<span class="comment-quote-words">' + escapeHtml(c.quotedText) + '</span>”</div>'
        ) +
        commentResolvedNoteHtml(c) +
      '</div>' +
      /* a 2px line joins each comment to the reply that answers it (app.css) */
      '<ol class="comment-thread" aria-label="Comments in this thread">' + entries + '</ol>' +
      commentReplyHtml(c) +
      '<div class="comment-actions comment-foot">' +
        /* A review session adds to a thread and does not delete or
           resolve one. Its only write is POSTing a comment or a reply
           (#71). Resolving is an editor's alone, by the owner's decision:
           nobody's authorship can be proved (an author is a typed name and
           reviewers share one token), so a reviewer resolving anything
           would be resolving someone else's comment. The server refuses a
           reviewer's PATCH (403 reviewers-cannot-resolve), 21-events.js's
           click guard (REVIEW_SAFE_ACTIONS) refuses toggle-resolve, and
           toggleResolve() itself does nothing in a review session. */
        (review ? '' :
          '<button type="button" class="btn-outline comment-resolve" data-action="toggle-resolve" data-id="' + c.id + '">' +
            (c.resolved
              ? '<svg aria-hidden="true"><use href="#i-return"/></svg>Unresolve'
              : '<svg class="comment-resolve-tick" aria-hidden="true"><use href="#i-check-circle"/></svg>Resolve') +
          '</button>') +
        /* Assign is the select itself, drawn as an outlined button with the
           person icon: disabled rather than gone in a review session, so a
           reader still sees who has the thread (#71). */
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

/* An image conflict's picture is its `imageValue` record (#82), drawn as
   an <img data-blob> the hydrator (02c-blobs.js) fills in. The stored body
   names the same picture (<img data-blob>, P6) for anything that reads
   bodies generically, but the record is the source of truth — it is what
   "Use my version" puts back — so the card draws the record. Every other
   body is drawn as stored; its <img data-blob>s are hydrated the same way. */
function conflictBodyHtml(c) {
  if (c.field === "visualImage") {
    var ref = normalizeImageRef(c.imageValue);
    return ref ? blobImgHtml(ref, "comment-img") : "";
  }
  return c.body;
}

/* The conflict card's flag: a warning triangle, drawn here rather than
   added to the sprite (#169 — the "⚠" it replaces was an emoji). */
var CONFLICT_ICON_SVG =
  '<svg class="conflict-flag-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>' +
  '</svg>';

/* A card holding one edit that could not be merged automatically —
   the user's own version, kept verbatim with a one-click way to put it back.
   The thread card's language (#169) — head, the person, the foot bar —
   with the flag in the accent where the number would be: it has no words
   in the script to be numbered by or to jump to. */
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
      /* All three write the document: "Use my version" puts text back
         into a row, and the other two change a stored comment. */
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
  if (c.field === "visualImage") {
    /* the picture is the card's record (#82), not anything in its body */
    delete S.state.rows[ri].visualImage;
    S.state.rows[ri].imageRef = c.emptyValue ? null : (normalizeImageRef(c.imageValue) || null);
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

/* How a thread starts, under the list (#169) — the Comment button is in
   the script's own toolbar, not in this panel, so the panel says where. */
var COMMENTS_HINT_HTML = '<p class="comments-hint">To start a thread, select words in the script and choose Comment.</p>';

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
    listEl.innerHTML = '<div class="comments-empty">' + (S.state.comments.length ? "No comments match this filter." : "No comments yet.") + '</div>' +
      COMMENTS_HINT_HTML;
    return;
  }
  /* An open "⋯" menu is drawn open again (commentMenuFor); if the focus
     was in it — the Delete just armed — it goes back to the same item. */
  var a = document.activeElement;
  var focusInMenu = !!(a && a.closest && a.closest("#comments-list .comment-menu"));
  /* numbered here, after the script is painted — see commentThreadNumbers */
  var nums = commentThreadNumbers();
  listEl.innerHTML = items.map(function (c) {
    return commentCardHtml(c, c.resolved ? 0 : nums[c.id] || 0);
  }).join("") + COMMENTS_HINT_HTML;
  if (commentMenuFor) {
    placeCommentMenu();
    if (focusInMenu) focusCommentMenuItem();
  }
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  S.commentSortMode = readCommentSortMode();

  commentFilter = readCommentFilter();

  /* the thread menus' press-outside and keyboard, on the document like
     the Production panel's (08-production-panels.js) */
  document.addEventListener("mousedown", onCommentMenuMouseDown, true);
  document.addEventListener("keydown", onCommentMenuKeydown, true);
}
