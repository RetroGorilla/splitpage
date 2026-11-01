import type { IdSource } from "../../core/document/ports.ts";
import type { CommentStatePorts } from "./ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { OperationContext } from "../../application/session/operation.ts";
import type { SessionChange } from "../../application/session/change-set.ts";
import type { CommentFilter } from "../../application/preferences/preferences.ts";
import type { ConflictValue } from "../../application/commands/comments.ts";
import type { RewritePlanner } from "../../application/commands/document-edit.ts";

type CommentRenderReply = NonNullable<DocumentView["comments"][number]["replies"]>[number] & {
  readonly author: string; readonly body: string; readonly createdAt?: string | null | undefined;
};
type CommentRenderRecord = {
  readonly id: string; readonly createdAt?: string | null | undefined; readonly resolvedAt?: string | null | undefined;
  readonly resolved?: unknown; readonly kind?: unknown; readonly imageValue?: unknown; readonly emptyValue?: unknown;
  readonly rowId: string; readonly field: string; readonly anchorId: string;
  readonly author: string; readonly body: string; readonly quotedText: string;
  readonly resolvedBy?: string; readonly assignee?: string; readonly conflictField?: string; readonly titleValue?: string;
  readonly replies: readonly CommentRenderReply[];
};
type CommentsReadDocument = {
  readonly comments: readonly CommentRenderRecord[];
  readonly rows: DocumentView["rows"];
  readonly people: readonly { readonly name?: string | null | undefined }[];
};
type CommentsRuntimePorts = { readonly [K in Exclude<keyof CommentStatePorts, "document">]: CommentStatePorts[K] } & {
  readonly document: CommentStatePorts["document"];
};
type PendingCommentContext = { id: string; rowId: string; field: string; quotedText: string };
type ReplyDraft = { body?: string; name?: string };
type CommentMenuEvent = KeyboardEvent & { readonly target: HTMLElement };

import { plainText, safeId as safeIdFrom } from "../../core/document/text-policy.ts";
import { editableCellHtml } from "../common/editable-cell.js";
import { formatTimestampAbsolute } from "../../../shared/clock.js";

import { pad2 } from "../../core/production/timing.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import {
  addCommentCommand,
  addReplyCommand,
  deleteCommentCommand,
  restoreConflictCommand,
  setCommentAssigneeCommand,
  toggleResolveCommand,
  unwrapCommentAnchorCommand
} from "../../application/commands/comments.ts";
import { normalizeImageRef } from "../../../shared/blob-policy.js";
import { cssAttr } from "../common/dom.ts";
import {
  commentMatchesFilterMode,
  commentMatchesAssigneeFilter as matchesAssignee,
  commentRecentOrder,
  compareCommentPositions
} from "../../core/document/comments.ts";
import { idMap } from "../../core/document/id-map.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { EDITOR_NAME_MAX } from "../../core/document/fields.ts";
import { codePointPrefix, escapeHtml } from "../../core/document/text-policy.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import { getSavedAuthorName, saveAuthorName } from "../../application/comment-author.ts";

let ports: CommentStatePorts | null = null;
const commentDisposers: (() => void)[] = [];

function listen(target: EventTarget, type: string, handler: (event: CommentMenuEvent) => void, options?: boolean | AddEventListenerOptions) {
  target.addEventListener(type, handler as EventListener, options);
  commentDisposers.push(function () { target.removeEventListener(type, handler as EventListener, options); });
}

function safeId(id: unknown, prefix: string) {
  return safeIdFrom(id, prefix, (ports as CommentsRuntimePorts).ids as IdSource);
}

let commentFilter: CommentFilter | undefined;

let taggingHelpReturn: { el: HTMLElement; range: Range | null } | null = null;

export function showTaggingHelp() {
  const card = document.getElementById("tagging-help");
  if (!card) return;
  const active = document.activeElement as HTMLElement | null;
  if (card.hidden && active && active !== document.body && !card.contains(active)) {
    let range = null;
    try {
      const sel = window.getSelection() as Selection;
      if (sel.rangeCount && active.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange();
    } catch (e) {}
    taggingHelpReturn = { el: active, range: range };
  }
  card.hidden = false;
  (ports as CommentsRuntimePorts).preferences.taggingHelpShown();
  card.focus({ preventScroll: true });
  updateTaggingHelpCover();
}

function hideTaggingHelp() {
  const card = document.getElementById("tagging-help");
  if (!card || card.hidden) return;
  const hadFocus = card.contains(document.activeElement);
  card.hidden = true;
  card.classList.remove("is-covering");
  (ports as CommentsRuntimePorts).preferences.taggingHelpDismissed();
  const back = taggingHelpReturn;
  taggingHelpReturn = null;
  if (!hadFocus || !back || !document.contains(back.el)) return;
  try { back.el.focus({ preventScroll: true }); } catch (e) { return; }
  if (back.range) {
    try {
      const sel = window.getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(back.range);
    } catch (e) { }
  }
}

let taggingHelpCoverFrame = 0;

function caretRectForCover() {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !active.isContentEditable) return null;
  const sel = window.getSelection() as Selection;
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!active.contains(range.endContainer)) return null;
  const r = range.getClientRects();
  if (r.length && (r[r.length - 1] as DOMRect).height) return r[r.length - 1];
  let node: Node | undefined = range.endContainer; let at = range.endOffset;
  if (node.nodeType === 1 && at > 0) {
    node = node.childNodes[at - 1];
    while (node && node.nodeType === 1 && node.lastChild) node = node.lastChild;
    at = node && node.nodeType === 3 ? (node as Text).data.length : 0;
  }
  if (node && node.nodeType === 3 && at > 0) {
    const ch = document.createRange();
    ch.setStart(node, at - 1);
    ch.setEnd(node, at);
    const cr = ch.getClientRects();
    if (cr.length) {
      const last = cr[cr.length - 1] as DOMRect;
      return { left: last.right, right: last.right + 1, top: last.top, bottom: last.bottom };
    }
  }
  const el = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentNode) as Element | null;
  const box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  return box ? { left: box.left, right: box.left + 2, top: box.top, bottom: Math.min(box.bottom, box.top + 24) } : null;
}

function fitTaggingHelp(card: HTMLElement) {
  const bar = document.querySelector<HTMLElement>(".topbar");
  const bottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 52;
  card.style.setProperty("--header-bottom", bottom + "px");
}

function updateTaggingHelpCover() {
  const card = document.getElementById("tagging-help");
  if (!card) return;
  if (card.hidden) { card.classList.remove("is-covering"); return; }
  fitTaggingHelp(card);
  const caret = caretRectForCover();
  let covering = false;
  if (caret) {
    const box = card.getBoundingClientRect();
    const pad = 8;
    covering = caret.right > box.left - pad && caret.left < box.right + pad &&
               caret.bottom > box.top - pad && caret.top < box.bottom + pad;
  }
  card.classList.toggle("is-covering", covering);
}

function scheduleTaggingHelpCover() {
  if (taggingHelpCoverFrame) return;
  const card = document.getElementById("tagging-help");
  if (!card || (card.hidden && !card.classList.contains("is-covering"))) return;
  taggingHelpCoverFrame = requestAnimationFrame(function () {
    taggingHelpCoverFrame = 0;
    updateTaggingHelpCover();
  });
}

function initTaggingHelp() {
  const card = document.getElementById("tagging-help");
  if (!card) return;
  listen(document.getElementById("tagging-help-dismiss") as HTMLElement, "click", hideTaggingHelp);
  listen(card, "keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    hideTaggingHelp();
  });
  listen(document, "selectionchange", scheduleTaggingHelpCover);
  listen(document, "input", scheduleTaggingHelpCover, true);
  listen(window, "scroll", scheduleTaggingHelpCover, true);
  listen(window, "resize", scheduleTaggingHelpCover);
  const bar = document.querySelector<HTMLElement>(".topbar");
  if (bar && typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleTaggingHelpCover);
    observer.observe(bar);
    commentDisposers.push(function () { observer.disconnect(); });
  }
}

let pendingComment: PendingCommentContext | null = null;
let composerVersion = 0;
let bindingsVersion = 0;
const commentTimers = new Set<ReturnType<typeof setTimeout>>();

function ownsDocument(operation: OperationContext) {
  return (ports as CommentsRuntimePorts).ownership.stillOwns(operation);
}

function commentTimer(fn: () => void, delay: number) {
  const version = bindingsVersion;
  const operation = (ports as CommentsRuntimePorts).ownership.capture();
  const timer = setTimeout(function () {
    if (version !== bindingsVersion) return;
    commentTimers.delete(timer);
    if (ownsDocument(operation)) fn();
  }, delay);
  commentTimers.add(timer);
  return timer;
}

export function captureCommentComposer() {
  const operation = (ports as CommentsRuntimePorts).ownership.capture();
  const version = composerVersion;
  const modal = (document.getElementById("comment-modal") as HTMLElement);
  const body = (document.getElementById("comment-body-editable") as HTMLElement);
  return function () {
    if (!ports || version !== composerVersion || !ownsDocument(operation)) return null;
    const liveModal = (document.getElementById("comment-modal") as HTMLElement);
    const liveBody = (document.getElementById("comment-body-editable") as HTMLElement);
    return liveModal === modal && liveBody === body && liveModal && !liveModal.hidden ? liveBody : null;
  };
}

export function resetCommentBindings() {
  bindingsVersion++;
  composerVersion++;
  commentTimers.forEach(function (timer) { clearTimeout(timer); });
  commentTimers.clear();
  (ports as CommentsRuntimePorts).deletion.disarm("comment");
  closeCommentMenu(false);
  pendingComment = null;
  expandedReplyIds = idMap<boolean>();
  replyDrafts = idMap<ReplyDraft>();
  (document.getElementById("comment-modal") as HTMLElement).hidden = true;
  (ports as CommentsRuntimePorts).sidePanels.close("comments-panel");
  closeFieldPopovers((document.getElementById("comment-modal") as HTMLElement));
  const body = (document.getElementById("comment-body-editable") as HTMLElement);
  body.innerHTML = "";
  (ports as CommentsRuntimePorts).clearDraftUndo(body);
}

let expandedReplyIds = idMap<boolean>();
let replyDrafts = idMap<ReplyDraft>();

export const AUTHOR_NAME_FIELDS = "#settings-name, #comment-name, .reply-name-input, #identity-input";
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;
function wholeEmojiCut(value: string, at: number) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return at;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value).containing(at);
  return seg && seg.index < at && EMOJI_PART.test(seg.segment) ? seg.index : at;
}
export function limitAuthorNameField(field: HTMLElement) {
  const value = (field as HTMLInputElement).value;
  const excess = Array.from(value).length - EDITOR_NAME_MAX;
  if (excess <= 0) return;
  const caret = (field as HTMLInputElement).selectionStart;
  const head = typeof caret === "number" && caret === (field as HTMLInputElement).selectionEnd ? Array.from(value.slice(0, caret)) : [];
  if (head.length < excess) {
    (field as HTMLInputElement).value = value.slice(0, wholeEmojiCut(value, codePointPrefix(value, EDITOR_NAME_MAX).length));
    return;
  }
  const cut = wholeEmojiCut(value, head.slice(0, head.length - excess).join("").length);
  (field as HTMLInputElement).value = value.slice(0, cut) + value.slice(caret as number);
  (field as HTMLInputElement).setSelectionRange(cut, cut);
}
export function setCommentSortMode(mode: string) {
  const chosen = (ports as CommentsRuntimePorts).sort.choose(mode);
  (ports as CommentsRuntimePorts).preferences.setCommentsSort(chosen);
  captureReplyDrafts();
  renderComments();
}

const COMMENT_FILTER_MODES: Record<string, boolean> = { open: true, resolved: true, all: true };

export function setCommentFilterMode(mode: string | null) {
  (commentFilter as CommentFilter).mode = COMMENT_FILTER_MODES[mode as string] ? mode as string : "open";
  (ports as CommentsRuntimePorts).preferences.setCommentFilter(commentFilter as CommentFilter);
  captureReplyDrafts();
  renderComments();
}
export function setCommentAssigneeFilter(value: string | null) {
  (commentFilter as CommentFilter).assignee = value || "";
  (ports as CommentsRuntimePorts).preferences.setCommentFilter(commentFilter as CommentFilter);
  captureReplyDrafts();
  renderComments();
}
function commentMatchesAssigneeFilter(c: CommentRenderRecord, assignee: string) {
  return matchesAssignee(c, assignee, function () { return getSavedAuthorName((ports as CommentsRuntimePorts).preferences); });
}

function commentAssigneeCandidates() {
  const seen = idMap<boolean>(); const out: string[] = [];
  function add(name: string | null | undefined) {
    const clean = plainText(name || "").trim();
    if (!clean || clean === "Anonymous") return;
    const norm = normalizeTagName(clean);
    if (seen[norm]) return;
    seen[norm] = true;
    out.push(clean);
  }
  (((ports as CommentsRuntimePorts).document.current() as CommentsReadDocument | null)?.people || []).forEach(function (p) { add(p.name); });
  (((ports as CommentsRuntimePorts).document.current() as CommentsReadDocument | null)?.comments || []).forEach(function (c) {
    add(c.author);
    (c.replies || []).forEach(function (r) { add(r.author); });
  });
  out.sort(function (a, b) { return a.localeCompare(b); });
  return out;
}

export function setCommentAssignee(id: string | null, name: string | null) {
  const idx = findCommentIndex(id);
  if (idx === -1) return;
  (ports as CommentsRuntimePorts).edits.edit(setCommentAssigneeCommand(id as string, name, (ports as CommentsRuntimePorts).edits.stamps.clock));
}

function commentAssigneeOptionsHtml(current: string | undefined) {
  const candidates = commentAssigneeCandidates();
  let found = false;
  let html = '<option value=""' + (current ? "" : " selected") + '>' +
    (current ? "Unassigned" : "Assign…") + '</option>';
  candidates.forEach(function (name) {
    const sel = normalizeTagName(name) === normalizeTagName(current || "");
    if (sel) found = true;
    html += '<option value="' + escapeHtml(name) + '"' + (sel ? " selected" : "") + '>' + escapeHtml(name) + '</option>';
  });
  if (current && !found) {
    html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
  }
  return html;
}

function renderCommentFilterBar() {
  const doc = (ports as CommentsRuntimePorts).document.current() as CommentsReadDocument | null;
  if (!doc) return;
  const seg = document.getElementById("comments-filter-seg");
  if (seg) {
    const modeCounts = { open: 0, resolved: 0, all: 0 };
    doc.comments.forEach(function (c) {
      if (!commentMatchesAssigneeFilter(c, (commentFilter as CommentFilter).assignee)) return;
      modeCounts.all++;
      modeCounts[c.resolved ? "resolved" : "open"]++;
    });
    (["open", "resolved", "all"] as const).forEach(function (mode) {
      const btn = seg.querySelector('[data-filter="' + mode + '"]');
      if (!btn) return;
      const on = (commentFilter as CommentFilter).mode === mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
      const countEl = btn.querySelector(".filter-count");
      if (countEl) countEl.textContent = String(modeCounts[mode]);
    });
  }

  const select = (document.getElementById("comments-assignee-filter") as HTMLSelectElement | null);
  if (!select) return;
  const mode = (commentFilter as CommentFilter).mode;
  function countFor(matcher: (comment: CommentRenderRecord) => boolean) {
    let n = 0;
    (doc as CommentsReadDocument).comments.forEach(function (c) { if (commentMatchesFilterMode(c, mode) && matcher(c)) n++; });
    return n;
  }
  const meNorm = normalizeTagName(getSavedAuthorName((ports as CommentsRuntimePorts).preferences));
  const candidates = commentAssigneeCandidates();
  const current = (commentFilter as CommentFilter).assignee;
  const currentIsSpecial = current === "" || current === "me" || current === "__unassigned__";
  let currentFound = false;
  let html = '<option value="">Everyone (' + countFor(function () { return true; }) + ')</option>' +
    '<option value="me">Assigned to me (' + (meNorm ? countFor(function (c) { return normalizeTagName(c.assignee || "") === meNorm; }) : 0) + ')</option>' +
    '<option value="__unassigned__">Unassigned (' + countFor(function (c) { return !c.assignee; }) + ')</option>' +
    candidates.map(function (name) {
      if (!currentIsSpecial && normalizeTagName(name) === normalizeTagName(current)) currentFound = true;
      const norm = normalizeTagName(name);
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

function formatRelativeTime(iso: string | null | undefined) {
  try {
    const d = new Date(iso as string);
    if (isNaN(d.getTime())) return "";
    const sec = Math.round((Date.parse((ports as CommentsRuntimePorts).clock.nowIso()) - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return min + (min === 1 ? " minute ago" : " minutes ago");
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
    const day = Math.round(hr / 24);
    if (day < 30) return day + (day === 1 ? " day ago" : " days ago");
    const mon = Math.round(day / 30);
    if (mon < 12) return mon + (mon === 1 ? " month ago" : " months ago");
    const yr = Math.round(mon / 12);
    return yr + (yr === 1 ? " year ago" : " years ago");
  } catch (e) { return ""; }
}

function commentLocationHtml(rowId: string, field: string) {
  if (field === "title") return "Document title";
  const idx = (ports as CommentsRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, rowId); });
  const fieldLabel = field === "audioText" ? "Audio" : "Visual";
  if (idx === -1) return "Deleted scene · " + fieldLabel;
  return 'Scene <span class="comment-loc-num">' + pad2(idx + 1) + '</span> · ' + fieldLabel;
}

function commentThreadNumbers() {
  const spans: HTMLElement[] = Array.prototype.slice.call(document.querySelectorAll("#rows .cmt-anchor:not(.resolved)"));
  spans.sort(function (a, b) {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  const nums: Record<string, number> = Object.create(null);
  spans.forEach(function (el, i) {
    const id = el.getAttribute("data-cmt");
    if (id && !nums[id]) nums[id] = i + 1;
  });
  return nums;
}

function commentAvatarHtml(name: string) {
  const first = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar comment-avatar" style="--size:28px;--presence:' + (ports as CommentsRuntimePorts).personColors.personColor(name) +
    '" aria-hidden="true">' + escapeHtml(first.toUpperCase()) + '</span>';
}

function commentTimeHtml(iso: string | null | undefined, cls: string) {
  return '<time class="' + cls + '" datetime="' + escapeHtml(iso || "") + '" title="' +
    escapeHtml(formatTimestampAbsolute(iso, (ports as CommentsRuntimePorts).preferences.clock())) + '">' + escapeHtml(formatRelativeTime(iso)) + '</time>';
}

function commentPositionCompare(a: CommentRenderRecord, b: CommentRenderRecord) {
  return compareCommentPositions(a, b, function (id) { return (ports as CommentsRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, id); }); });
}

function anchorTextFromState(cmtId: string) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return null;
  const cIdx = findCommentIndex(cmtId);
  if (cIdx === -1) return null;
  const c = doc.comments[cIdx] as CommentRenderRecord;
  const row = doc.rows[(ports as CommentsRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, c.rowId); })];
  if (!row) return null;
  const body = (ports as CommentsRuntimePorts).text.inertBody(row[c.field] || "");
  const span = body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(cmtId) + '"]');
  return span ? span.textContent : null;
}

function anchorLiveText(cmtId: string) {
  const el = document.querySelector<HTMLElement>('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  if (el) return el.textContent;
  return anchorTextFromState(cmtId);
}

function anchorUnwrapped(rowId: string, field: string, cmtId: string): RewritePlanner {
  return function (doc) {
    const row = doc.rows[rowIndexOf(doc, rowId)];
    if (!row) return [];
    const container = (ports as CommentsRuntimePorts).text.inertBody(row[field] || "");
    const anchor = container.querySelector('.cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
    if (!anchor) return [];
    while (anchor.firstChild) (anchor.parentNode as ParentNode).insertBefore(anchor.firstChild, anchor);
    (anchor.parentNode as ParentNode).removeChild(anchor);
    return [{ rowId: rowId, field: field, html: container.innerHTML }];
  };
}

const COUNTED_KINDS: Record<string, boolean> = { adopt: true, disk: true, recovery: true, reload: true };

export function commentsChanged(change: SessionChange) {
  if (COUNTED_KINDS[change.kind] || change.changes.whole || change.changes.docFields.indexOf("comments") !== -1) updateCommentsCount();
}

function updateCommentsCount() {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return;
  const open = doc.comments.filter(function (c) { return !c.resolved; }).length;
  const badge = (document.getElementById("comments-badge") as HTMLElement);
  if (open > 0) { badge.hidden = false; badge.textContent = open > 99 ? "99+" : String(open); }
  else badge.hidden = true;
}

function closeFieldPopovers(root: ParentNode | null) {
  (root || document).querySelectorAll<HTMLElement>(".link-popover, .video-popover").forEach(function (el) {
    el.hidden = true;
    const input = el.querySelector("input");
    if (input) input.value = "";
  });
}

export function openCommentComposer(ctx: Readonly<Record<string, unknown>>) {
  composerVersion++;
  pendingComment = ctx as PendingCommentContext;
  (ports as CommentsRuntimePorts).selection.dropLink();
  closeFieldPopovers((document.getElementById("comment-modal") as HTMLElement));
  (document.getElementById("comment-modal-quote") as HTMLElement).innerHTML =
    '“<span class="comment-quote-words">' + escapeHtml(ctx.quotedText) + '</span>”';
  const nameInput = (document.getElementById("comment-name") as HTMLInputElement);
  nameInput.value = getSavedAuthorName((ports as CommentsRuntimePorts).preferences);
  const bodyEl = (document.getElementById("comment-body-editable") as HTMLElement);
  bodyEl.innerHTML = "";
  (ports as CommentsRuntimePorts).clearDraftUndo(bodyEl);
  (document.getElementById("comment-modal") as HTMLElement).hidden = false;
  const resolveComposer = captureCommentComposer();
  commentTimer(function () { const body = resolveComposer(); if (body) body.focus(); }, 0);
}

export function closeCommentComposer(cancelled?: boolean) {
  composerVersion++;
  (document.getElementById("comment-modal") as HTMLElement).hidden = true;
  if (cancelled && pendingComment) {
    (ports as CommentsRuntimePorts).edits.edit(unwrapCommentAnchorCommand(anchorUnwrapped(pendingComment.rowId, pendingComment.field, pendingComment.id)));
  }
  pendingComment = null;
  (ports as CommentsRuntimePorts).selection.dropLink();
  closeFieldPopovers((document.getElementById("comment-modal") as HTMLElement));
  (document.getElementById("comment-body-editable") as HTMLElement).innerHTML = "";
  (ports as CommentsRuntimePorts).clearDraftUndo((document.getElementById("comment-body-editable") as HTMLElement));
}

export function postComment() {
  if (!pendingComment) return;
  const nameInput = (document.getElementById("comment-name") as HTMLInputElement);
  const author = cleanAuthorName(nameInput.value) || "Anonymous";
  saveAuthorName((ports as CommentsRuntimePorts).preferences, author);
  const bodyEl = (document.getElementById("comment-body-editable") as HTMLElement);
  const bodyHtml = (ports as CommentsRuntimePorts).text.sanitizeHtml(bodyEl.innerHTML);
  const hasMedia = /<img|video-embed-card/.test(bodyHtml);
  if (!bodyEl.textContent.trim() && !hasMedia) {
    (ports as CommentsRuntimePorts).notices.show("Write a comment before posting.", "warn");
    return;
  }
  (ports as CommentsRuntimePorts).edits.edit(addCommentCommand({
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
    createdAt: (ports as CommentsRuntimePorts).clock.nowIso(),
    updatedAt: (ports as CommentsRuntimePorts).clock.nowIso(),
    kind: "anchor",
    replies: []
  }));
  (document.getElementById("comment-modal") as HTMLElement).hidden = true;
  composerVersion++;
  pendingComment = null;
  bodyEl.innerHTML = "";
  (ports as CommentsRuntimePorts).clearDraftUndo(bodyEl);
  sendNow();
}

function sendNow() {
  (ports as CommentsRuntimePorts).saves.dueNow();
}

function findCommentIndex(id: string | null) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return -1;
  for (let i = 0; i < doc.comments.length; i++) if ((doc.comments[i] as CommentRenderRecord).id === id) return i;
  return -1;
}

export function openCommentsPanel() {
  if (!(ports as CommentsRuntimePorts).document.current()) return;
  (ports as CommentsRuntimePorts).sidePanels.open("comments-panel");
  captureReplyDrafts();
  renderComments();
}

export function toggleResolve(id: string | null) {
  (ports as CommentsRuntimePorts).edits.edit(toggleResolveCommand(id as string, (ports as CommentsRuntimePorts).edits.stamps));
}

function deleteComment(id: string | null) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return;
  const idx = findCommentIndex(id);
  if (idx === -1) return;
  const c = doc.comments[idx] as CommentRenderRecord;
  Reflect.deleteProperty(expandedReplyIds, id as string);
  Reflect.deleteProperty(replyDrafts, id as string);
  if (commentMenuFor === id) commentMenuFor = null;
  (ports as CommentsRuntimePorts).edits.edit(deleteCommentCommand(id as string, anchorUnwrapped(c.rowId, c.field, c.anchorId)));
}

export function armDeleteComment(btn: Element, id: string | null) {
  if ((ports as CommentsRuntimePorts).deletion.armedId("comment") === id) {
    (ports as CommentsRuntimePorts).deletion.disarm("comment");
    deleteComment(id);
    return;
  }
  (ports as CommentsRuntimePorts).deletion.arm("comment", id as string, function () {
    renderComments();
  }, undefined, { start: commentTimer, stop: function (timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); } });
  captureReplyDrafts();
  renderComments();
}

export function toggleReplyComposer(id: string | null) {
  captureReplyDrafts();
  expandedReplyIds[id as string] = !expandedReplyIds[id as string];
  if (!expandedReplyIds[id as string]) Reflect.deleteProperty(replyDrafts, id as string);
  renderComments();
  if (expandedReplyIds[id as string]) {
    const input = document.querySelector<HTMLElement>('.reply-composer[data-for="' + safeId(id, "c") + '"] .cell-editable');
    if (input) input.focus();
  }
}

export function postReply(id: string | null) {
  const idx = findCommentIndex(id);
  if (idx === -1) return;
  const card = document.querySelector<HTMLElement>('.reply-composer[data-for="' + safeId(id, "c") + '"]');
  if (!card) return;
  const nameInput = card.querySelector<HTMLInputElement>(".reply-name-input") as HTMLInputElement;
  const bodyEl = card.querySelector<HTMLElement>(".cell-editable") as HTMLElement;
  const author = cleanAuthorName(nameInput.value) || "Anonymous";
  saveAuthorName((ports as CommentsRuntimePorts).preferences, author);
  const bodyHtml = (ports as CommentsRuntimePorts).text.sanitizeHtml(bodyEl.innerHTML);
  if (!bodyEl.textContent.trim()) {
    (ports as CommentsRuntimePorts).notices.show("Write a reply before posting.", "warn");
    return;
  }
  Reflect.deleteProperty(expandedReplyIds, id as string);
  Reflect.deleteProperty(replyDrafts, id as string);
  (ports as CommentsRuntimePorts).edits.edit(addReplyCommand(id as string, {
    id: (ports as CommentsRuntimePorts).ids.id("rp"),
    author: author,
    body: bodyHtml,
    createdAt: (ports as CommentsRuntimePorts).clock.nowIso()
  }, (ports as CommentsRuntimePorts).edits.stamps.clock));
  sendNow();
}

export function jumpToAnchor(cmtId: string | null) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return;
  const cIdx = findCommentIndex(cmtId);
  if (cIdx !== -1) (ports as CommentsRuntimePorts).shots.reveal((doc.comments[cIdx] as CommentRenderRecord).rowId);
  const el = document.querySelector<HTMLElement>('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  if (!el) {
    (ports as CommentsRuntimePorts).notices.show("That text is no longer in the script.", "warn");
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

export function jumpToComment(cmtId: string | null) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return;
  const idx = findCommentIndex(cmtId);
  const target = idx === -1 ? null : doc.comments[idx] as CommentRenderRecord | undefined;
  if (target && (!commentMatchesFilterMode(target, (commentFilter as CommentFilter).mode) ||
      !commentMatchesAssigneeFilter(target, (commentFilter as CommentFilter).assignee))) {
    (commentFilter as CommentFilter).mode = "all";
    (commentFilter as CommentFilter).assignee = "";
    (ports as CommentsRuntimePorts).preferences.setCommentFilter(commentFilter as CommentFilter);
    captureReplyDrafts();
    renderComments();
  }
  openCommentsPanel();
  const panel = document.getElementById("comments-panel");
  commentTimer(function () {
    if (document.getElementById("comments-panel") !== panel) return;
    const card = document.querySelector<HTMLElement>('.comment-card[data-id="' + safeId(cmtId, "c") + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }, 30);
}

function replyComposerHtml(commentId: string) {
  const draft = replyDrafts[commentId] || {};
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
            escapeHtml(draft.name !== undefined ? draft.name : getSavedAuthorName((ports as CommentsRuntimePorts).preferences)) + '" autocomplete="off">' +
        '</label>' +
        '<span class="reply-composer-actions">' +
          '<button type="button" class="reply-cancel" data-action="reply-cancel" data-id="' + commentId + '">Cancel</button>' +
          '<button type="button" class="reply-post" data-action="reply-post" data-id="' + commentId + '">Post reply</button>' +
        '</span>' +
      '</div>' +
    '</div>'
  );
}

function commentReplyHtml(c: CommentRenderRecord) {
  return '<div class="comment-reply">' +
    (expandedReplyIds[c.id] ? replyComposerHtml(c.id) :
      '<button type="button" class="comment-reply-open" data-action="toggle-reply" data-id="' + c.id + '">Write a reply…</button>') +
  '</div>';
}

function commentEntryHtml(author: string, createdAt: string | null | undefined, bodyHtml: string, reply: boolean) {
  const p = reply ? "reply" : "comment";
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

let commentMenuFor: string | null = null;

function commentMoreHtml(c: CommentRenderRecord) {
  const open = commentMenuFor === c.id;
  const armed = (ports as CommentsRuntimePorts).deletion.armedId("comment") === c.id;
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
  return commentMenuFor ? document.querySelector<HTMLElement>('#comments-list .comment-card[data-id="' + safeId(commentMenuFor, "c") + '"] .comment-menu') : null;
}

function focusCommentMenuItem() {
  const menu = commentMenuEl();
  const item = menu && menu.querySelector<HTMLElement>(".comment-menu-item");
  if (item) item.focus();
}

function placeCommentMenu() {
  const menu = commentMenuEl();
  if (!menu) return;
  menu.classList.remove("opens-up");
  const list = (document.getElementById("comments-list") as HTMLElement);
  const box = list.getBoundingClientRect();
  const r = menu.getBoundingClientRect();
  if (r.bottom > box.bottom - 8 && r.top - r.height - 40 > box.top + 8) menu.classList.add("opens-up");
}

function closeCommentMenu(refocus: boolean) {
  const id = commentMenuFor;
  if (!id) return;
  const menu = commentMenuEl();
  commentMenuFor = null;
  if ((ports as CommentsRuntimePorts).deletion.armedId("comment") === id) { (ports as CommentsRuntimePorts).deletion.disarm("comment"); }
  if (!menu) return;
  const btn = (menu.parentNode as ParentNode).querySelector<HTMLElement>(".comment-more");
  (menu.parentNode as ParentNode).removeChild(menu);
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }
}

export function toggleCommentMenu(id: string | null) {
  if (commentMenuFor === id) { closeCommentMenu(true); return; }
  closeCommentMenu(false);
  commentMenuFor = id;
  captureReplyDrafts();
  renderComments();
  focusCommentMenuItem();
}

function onCommentMenuMouseDown(e: CommentMenuEvent) {
  if (!commentMenuFor) return;
  if (e.target.closest && e.target.closest('.comment-menu, [data-action="comment-menu"]')) return;
  closeCommentMenu(false);
}

function onCommentMenuKeydown(e: CommentMenuEvent) {
  const t = e.target;
  if (!t || !t.closest) return;
  const btn = t.closest('#comments-list [data-action="comment-menu"]');
  if (btn) {
    const id = btn.getAttribute("data-id");
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
  const menu = t.closest("#comments-list .comment-menu");
  if (!menu) return;
  const items: HTMLElement[] = Array.prototype.slice.call(menu.querySelectorAll(".comment-menu-item"));
  const i = items.indexOf(t);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) (items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length] as HTMLElement).focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) (items[e.key === "Home" ? 0 : items.length - 1] as HTMLElement).focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeCommentMenu(true);
  } else if (e.key === "Tab") {
    closeCommentMenu(false);
  }
}

function commentResolvedNoteHtml(c: CommentRenderRecord) {
  if (!c.resolved || !c.resolvedBy) return "";
  return '<div class="comment-resolved-note"><svg aria-hidden="true"><use href="#i-check-circle"/></svg>Resolved by ' + escapeHtml(c.resolvedBy) +
    (c.resolvedAt ? ' · ' + escapeHtml(formatRelativeTime(c.resolvedAt)) : '') + '</div>';
}

function commentCardHtml(c: CommentRenderRecord, num: number) {
  if (c.kind === "conflict") return conflictCardHtml(c);
  const liveText = anchorLiveText(c.id);
  const orphaned = liveText === null || liveText.length === 0;
  const changed = !orphaned && liveText !== c.quotedText;
  const entries = commentEntryHtml(c.author, c.createdAt, c.body, false) +
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
        '<button type="button" class="btn-outline comment-resolve" data-action="toggle-resolve" data-id="' + c.id + '">' +
          (c.resolved
            ? '<svg aria-hidden="true"><use href="#i-return"/></svg>Unresolve'
            : '<svg class="comment-resolve-tick" aria-hidden="true"><use href="#i-check-circle"/></svg>Resolve') +
        '</button>' +
        '<span class="ev-field comment-assign">' +
          '<svg class="comment-assign-icon" aria-hidden="true"><use href="#i-person"/></svg>' +
          '<select class="comment-assignee-select" id="comment-assignee-' + c.id + '" data-id="' + c.id + '" aria-label="Assign this thread to">' +
            commentAssigneeOptionsHtml(c.assignee) +
          '</select>' +
          '<svg class="ev-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg>' +
        '</span>' +
        commentMoreHtml(c) +
      '</div>' +
    '</div>'
  );
}

function conflictBodyHtml(c: CommentRenderRecord) {
  if (c.field === "visualImage") {
    const ref = normalizeImageRef(c.imageValue);
    return ref ? (ports as CommentsRuntimePorts).pictures.imgHtml(ref, "comment-img") : "";
  }
  return c.body;
}

const CONFLICT_ICON_SVG =
  '<svg class="conflict-flag-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>' +
  '</svg>';

function conflictCardHtml(c: CommentRenderRecord) {
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
      '<div class="comment-actions comment-foot">' +
        '<button type="button" class="btn-outline" data-action="restore-conflict" data-id="' + c.id + '">Use my version</button>' +
        '<button type="button" class="btn-outline" data-action="toggle-resolve" data-id="' + c.id + '">' +
          (c.resolved ? "Unresolve" : "Keep theirs") + '</button>' +
        commentMoreHtml(c) +
      '</div>' +
    '</div>'
  );
}

export function restoreConflictValue(commentId: string | null) {
  const doc = (ports as CommentsRuntimePorts).document.current();
  if (!doc) return;
  const ci = findCommentIndex(commentId);
  if (ci === -1) return;
  const c = doc.comments[ci] as CommentRenderRecord;
  if (c.field === "title") {
    (ports as CommentsRuntimePorts).history.keep("Before using your version of the title");
    (ports as CommentsRuntimePorts).edits.edit(restoreConflictCommand(commentId as string, { kind: "title", title: c.emptyValue ? "" : (c.titleValue || "") }, (ports as CommentsRuntimePorts).edits.stamps));
    (ports as CommentsRuntimePorts).notices.show("Restored your version of the title", "ok");
    return;
  }
  const ri = (ports as CommentsRuntimePorts).document.read(function (doc) { return rowIndexOf(doc, c.rowId); });
  if (ri === -1) { (ports as CommentsRuntimePorts).notices.show("That scene no longer exists.", "warn"); return; }

  (ports as CommentsRuntimePorts).history.keep("Before using your version of " + (c.conflictField || "a field"));
  const value: ConflictValue = c.field === "visualImage"
    ? { kind: "image", imageRef: c.emptyValue ? null : (normalizeImageRef(c.imageValue) || null) }
    : { kind: "text", html: c.emptyValue ? "" : (ports as CommentsRuntimePorts).text.sanitizeHtml(c.body) };
  (ports as CommentsRuntimePorts).edits.edit(restoreConflictCommand(commentId as string, value, (ports as CommentsRuntimePorts).edits.stamps));
  (ports as CommentsRuntimePorts).notices.show("Restored your version of " + (c.conflictField || "the field"), "ok");
}

export function captureReplyDrafts() {
  document.querySelectorAll(".reply-composer").forEach(function (el) {
    const id = el.getAttribute("data-for");
    const body = el.querySelector<HTMLElement>(".cell-editable");
    const name = el.querySelector<HTMLInputElement>(".reply-name-input");
    if (!id) return;
    replyDrafts[id] = { body: body ? body.innerHTML : "", name: name ? name.value : "" };
  });
}

const COMMENTS_HINT_HTML = '<p class="comments-hint">To start a thread, select words in the script and choose Comment.</p>';

export function renderComments() {
  const doc = (ports as CommentsRuntimePorts).document.current() as CommentsReadDocument | null;
  if (!doc) return;
  const listEl = (document.getElementById("comments-list") as HTMLElement);
  if (!listEl) return;
  renderCommentFilterBar();
  let items = doc.comments.filter(function (c) {
    return commentMatchesFilterMode(c, (commentFilter as CommentFilter).mode) && commentMatchesAssigneeFilter(c, (commentFilter as CommentFilter).assignee);
  });
  items = items.slice().sort((ports as CommentsRuntimePorts).sort.current() === "recent" ? commentRecentOrder : commentPositionCompare);
  if (!items.length) {
    listEl.innerHTML = '<div class="comments-empty">' + (doc.comments.length ? "No comments match this filter." : "No comments yet.") + '</div>' +
      COMMENTS_HINT_HTML;
    return;
  }
  const a = document.activeElement;
  const focusInMenu = !!(a && a.closest && a.closest("#comments-list .comment-menu"));
  const nums = commentThreadNumbers();
  listEl.innerHTML = items.map(function (c) {
    return commentCardHtml(c, c.resolved ? 0 : nums[c.id] || 0);
  }).join("") + COMMENTS_HINT_HTML;
  if (commentMenuFor) {
    placeCommentMenu();
    if (focusInMenu) focusCommentMenuItem();
  }
}

export function startComments(nextPorts: CommentStatePorts) {
  ports = nextPorts;
  (ports as CommentsRuntimePorts).sort.choose((ports as CommentsRuntimePorts).preferences.commentsSort());

  commentFilter = (ports as CommentsRuntimePorts).preferences.commentFilter();

  listen(document, "mousedown", onCommentMenuMouseDown, true);
  listen(document, "keydown", onCommentMenuKeydown, true);

  initTaggingHelp();
  let active = true;
  return { dispose: function () {
    if (!active) return;
    active = false;
    commentDisposers.splice(0).reverse().forEach(function (off) { off(); });
    if (taggingHelpCoverFrame) cancelAnimationFrame(taggingHelpCoverFrame);
    taggingHelpCoverFrame = 0;
    taggingHelpReturn = null;
    resetCommentBindings();
    commentFilter = undefined;
    ports = null;
  } };
}
