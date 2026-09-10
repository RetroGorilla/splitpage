  /* ================= comments ================= */

  var TAGGING_HELP_KEY = "splitpage-tagging-help-dismissed";

  function showTaggingHelp() {
    document.getElementById("tagging-help").hidden = false;
    try { localStorage.setItem(TAGGING_HELP_KEY, "0"); } catch (e) {}
    document.getElementById("tagging-help").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  var COMMENT_NAME_KEY = "splitpage-comment-author";
  var pendingComment = null;
  var expandedReplyIds = {};
  var replyDrafts = {};
  var deleteCommentArmId = null;
  var deleteCommentArmTimer = null;

  function nowIso() { return new Date().toISOString(); }

  function getSavedAuthorName() {
    try { return localStorage.getItem(COMMENT_NAME_KEY) || ""; } catch (e) { return ""; }
  }
  function saveAuthorName(name) {
    try { localStorage.setItem(COMMENT_NAME_KEY, name); } catch (e) {}
  }

  /* How you like the comments list ordered — about the reader, not the
     document, so it lives in this browser rather than in the file (same
     reasoning as the writer's text size). "position" (script order) is the
     default: it's where new-here readers expect a comment to be, right next
     to the row it's about. "recent" is for coming back after a while and
     wanting to see what actually moved, wherever in the script it was. */
  var COMMENTS_SORT_KEY = "splitpage-comments-sort";
  function readCommentSortMode() {
    try { return localStorage.getItem(COMMENTS_SORT_KEY) === "recent" ? "recent" : "position"; }
    catch (e) { return "position"; }
  }
  var commentSortMode = readCommentSortMode();
  function setCommentSortMode(mode) {
    commentSortMode = mode === "recent" ? "recent" : "position";
    try { localStorage.setItem(COMMENTS_SORT_KEY, commentSortMode); } catch (e) {}
    captureReplyDrafts();
    renderComments();
  }

  function formatTimestamp(iso) {
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
  function commentEntries() {
    var list = (state.comments || []).slice();
    list.sort(commentPositionCompare);
    return list.map(function (c) {
      return {
        location: findAnchorLocationLabel(c.rowId, c.field),
        author: c.author || "Anonymous",
        body: htmlToPlainText(c.body),
        quoted: c.quotedText || "",
        resolved: !!c.resolved,
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

  function anchorExistsInDom(cmtId) {
    return !!document.querySelector('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
  }

  /* The `.cmt-anchor` span is editable on purpose — a comment must never
     lock the writer out of their own sentence — so the words inside it can
     drift away from `c.quotedText` without the anchor itself disappearing.
     This reads the span's current plain text so the card can show *that*
     is stale, rather than silently claiming the quote is still accurate.
     Returns null when the span itself is gone (the orphaned case). */
  function anchorLiveText(cmtId) {
    var el = document.querySelector('#rows .cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
    return el ? el.textContent : null;
  }

  function unwrapAnchorInState(rowId, field, cmtId) {
    var idx = findRowIndex(rowId);
    if (idx === -1) return;
    var html = state.rows[idx][field] || "";
    var container = inertBody(html);
    var anchor = container.querySelector('.cmt-anchor[data-cmt="' + safeId(cmtId, "c") + '"]');
    if (anchor) {
      while (anchor.firstChild) anchor.parentNode.insertBefore(anchor.firstChild, anchor);
      anchor.parentNode.removeChild(anchor);
      state.rows[idx][field] = container.innerHTML;
    }
  }

  function syncAnchorResolvedClasses() {
    var resolvedIds = {};
    state.comments.forEach(function (c) { if (c.resolved) resolvedIds[c.id] = true; });
    document.querySelectorAll("#rows .cmt-anchor").forEach(function (el) {
      var id = el.getAttribute("data-cmt");
      el.classList.toggle("resolved", !!resolvedIds[id]);
    });
  }

  function updateCommentsCount() {
    var open = state.comments.filter(function (c) { return !c.resolved; }).length;
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

  function openCommentComposer(ctx) {
    pendingComment = ctx;
    savedRange = null;
    savedRangeCell = null;
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

  function closeCommentComposer(cancelled) {
    document.getElementById("comment-modal").hidden = true;
    if (cancelled && pendingComment) {
      unwrapAnchorInState(pendingComment.rowId, pendingComment.field, pendingComment.id);
      markDirty();
      render();
    }
    pendingComment = null;
    savedRange = null;
    savedRangeCell = null;
    closeFieldPopovers(document.getElementById("comment-modal"));
    document.getElementById("comment-body-editable").innerHTML = "";
  }

  function postComment() {
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
    state.comments.push({
      id: pendingComment.id,
      rowId: pendingComment.rowId,
      field: pendingComment.field,
      anchorId: pendingComment.id,
      quotedText: pendingComment.quotedText,
      author: author,
      body: bodyHtml,
      resolved: false,
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
    queueAutoSave();
  }

  /* ---- panel + cards ---- */

  function findCommentIndex(id) {
    for (var i = 0; i < state.comments.length; i++) if (state.comments[i].id === id) return i;
    return -1;
  }

  function openCommentsPanel() {
    if (!state) return;
    openSidePanel("comments-panel");
    /* closeCommentsPanel only hides the panel — an open reply composer with
       unsaved typed text is still sitting there in the DOM. Capture it
       before rebuilding comments-list's innerHTML, or reopening the panel
       silently throws away whatever was mid-typing. */
    captureReplyDrafts();
    renderComments();
  }
  function closeCommentsPanel() {
    document.getElementById("comments-panel").hidden = true;
    syncPanelClass();
  }

  function toggleResolve(id) {
    var idx = findCommentIndex(id);
    if (idx === -1) return;
    state.comments[idx].resolved = !state.comments[idx].resolved;
    state.comments[idx].updatedAt = nowIso();
    markDirty();
    render();
    queueAutoSave();
  }

  function deleteComment(id) {
    var idx = findCommentIndex(id);
    if (idx === -1) return;
    var c = state.comments[idx];
    unwrapAnchorInState(c.rowId, c.field, c.anchorId);
    state.comments.splice(idx, 1);
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
  function armDeleteComment(btn, id) {
    if (deleteCommentArmId === id) {
      clearTimeout(deleteCommentArmTimer);
      deleteCommentArmId = null;
      deleteComment(id);
      return;
    }
    deleteCommentArmId = id;
    clearTimeout(deleteCommentArmTimer);
    deleteCommentArmTimer = setTimeout(function () {
      deleteCommentArmId = null;
      renderComments();
    }, 2800);
    captureReplyDrafts();
    renderComments();
  }

  function toggleReplyComposer(id) {
    captureReplyDrafts();
    expandedReplyIds[id] = !expandedReplyIds[id];
    if (!expandedReplyIds[id]) delete replyDrafts[id];
    renderComments();
    if (expandedReplyIds[id]) {
      var input = document.querySelector('.reply-composer[data-for="' + safeId(id, "c") + '"] .cell-editable');
      if (input) input.focus();
    }
  }

  function postReply(id) {
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
    state.comments[idx].replies.push({
      id: makeId("rp"),
      author: author,
      body: bodyHtml,
      createdAt: nowIso()
    });
    state.comments[idx].updatedAt = nowIso();
    delete expandedReplyIds[id];
    delete replyDrafts[id];
    markDirty();
    render();
    queueAutoSave();
  }

  function jumpToAnchor(cmtId) {
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

  function jumpToComment(cmtId) {
    var hideResolvedBox = document.getElementById("comments-hide-resolved");
    if (hideResolvedBox.checked) { hideResolvedBox.checked = false; captureReplyDrafts(); renderComments(); }
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
        '<div class="comment-actions">' +
          '<button type="button" data-action="toggle-resolve" data-id="' + c.id + '">' + (c.resolved ? "Unresolve" : "Resolve") + '</button>' +
          (expandedReplyIds[c.id] ? "" : '<button type="button" data-action="toggle-reply" data-id="' + c.id + '">Reply</button>') +
          '<button type="button" class="danger' + (deleteCommentArmId === c.id ? ' armed' : '') +
            '" data-action="delete-comment" data-id="' + c.id + '">' +
            (deleteCommentArmId === c.id ? "Confirm?" : "Delete") + '</button>' +
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
        '<div class="comment-loc">' + escapeHtml(findAnchorLocationLabel(c.rowId, c.field)) + '</div>' +
        '<div class="comment-quote">Someone else changed this at the same time. Their version is live; yours is below.</div>' +
        '<div class="comment-body">' + (c.emptyValue ? "<em>(you had cleared this)</em>" : c.body) + '</div>' +
        '<div class="comment-actions">' +
          '<button type="button" data-action="restore-conflict" data-id="' + c.id + '">Use my version</button>' +
          '<button type="button" data-action="toggle-resolve" data-id="' + c.id + '">' + (c.resolved ? "Unresolve" : "Keep theirs") + '</button>' +
          '<button type="button" class="danger' + (deleteCommentArmId === c.id ? ' armed' : '') +
            '" data-action="delete-comment" data-id="' + c.id + '">' +
            (deleteCommentArmId === c.id ? "Confirm?" : "Delete") + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  /* put the stashed version back into the row it came from */
  function restoreConflictValue(commentId) {
    var ci = findCommentIndex(commentId);
    if (ci === -1) return;
    var c = state.comments[ci];
    if (c.field === "title") {
      pushSnapshot("Before using your version of the title");
      state.title = c.emptyValue ? "" : (c.titleValue || "");
      state.comments.splice(ci, 1);
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
      state.rows[ri].visualImage = img ? safeImageSrc(img.getAttribute("src")) : null;
    } else {
      /* an empty original must come back empty, not as placeholder text */
      state.rows[ri][c.field] = c.emptyValue ? "" : sanitizeHtml(c.body);
    }
    stampRow(state.rows[ri]);
    state.comments.splice(ci, 1);
    markDirty();
    render();
    queueAutoSave();
    showToast("Restored your version of " + (c.conflictField || "the field"), "ok");
  }

  function captureReplyDrafts() {
    document.querySelectorAll(".reply-composer").forEach(function (el) {
      var id = el.getAttribute("data-for");
      var body = el.querySelector(".cell-editable");
      var name = el.querySelector(".reply-name-input");
      if (!id) return;
      replyDrafts[id] = { body: body ? body.innerHTML : "", name: name ? name.value : "" };
    });
  }

  function renderComments() {
    if (!state) return;
    var listEl = document.getElementById("comments-list");
    if (!listEl) return;
    var hideResolved = document.getElementById("comments-hide-resolved").checked;
    var items = state.comments.filter(function (c) { return !hideResolved || !c.resolved; });
    items = items.slice().sort(commentSortMode === "recent"
      ? function (a, b) { return commentLastActivity(b).localeCompare(commentLastActivity(a)); }
      : commentPositionCompare);
    if (!items.length) {
      listEl.innerHTML = '<div class="comments-empty">' + (state.comments.length ? "No comments to show." : "No comments yet. Select text in a row and click 💬 Comment to leave one.") + '</div>';
      return;
    }
    listEl.innerHTML = items.map(commentCardHtml).join("");
  }
