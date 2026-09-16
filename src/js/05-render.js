  /* ================= rendering ================= */

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function fieldBlock(rowId, field, value, placeholder) {
    return (
      '<div class="field-wrap">' +
        '<div class="mini-toolbar" role="toolbar" aria-label="Text formatting">' +
          '<button type="button" data-cmd="bold" title="Bold (Ctrl+B)">B</button>' +
          '<button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
          '<button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
          '<button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" data-cmd="highlight" title="Highlight"><span class="hl-dot"></span>HL</button>' +
          '<button type="button" data-cmd="link" title="Add link">Link</button>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" data-cmd="comment" title="Comment on selected text">💬 Comment</button>' +
          '<button type="button" data-cmd="tag" title="Label as a prop, location, cast member or effect">🏷 Tag</button>' +
        '</div>' +
        '<div class="cell-editable" contenteditable="true" data-id="' + rowId + '" data-field="' + field + '" data-placeholder="' + placeholder + '">' + (value || "") + '</div>' +
        '<div class="link-popover" hidden>' +
          '<input type="url" placeholder="https://example.com" data-role="link-input">' +
          '<button type="button" data-action="link-confirm">Add</button>' +
          '<button type="button" data-action="link-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  function rowHtml(row, index) {
    var imageBlock;
    if (row.visualImage) {
      imageBlock =
        '<div class="image-thumb-wrap">' +
          '<img src="' + escapeHtml(row.visualImage) + '" alt="">' +
          '<div class="image-thumb-actions">' +
            '<button type="button" data-action="image-replace" data-id="' + row.id + '">Replace</button>' +
            '<button type="button" data-action="image-remove" data-id="' + row.id + '">Remove</button>' +
          '</div>' +
        '</div>';
    } else {
      imageBlock =
        '<button type="button" class="image-clip" data-action="image-add" data-id="' + row.id +
          '" title="Attach a reference image — or drag one anywhere onto this scene’s visual column">' +
          '<span class="clip-icon" aria-hidden="true">📎</span>Image</button>';
    }

    var st = rowStatus(row.status) || ROW_STATUSES[0];
    var secs = rowSeconds(row);

    return (
      '<div class="row' + (row.status === "shot" ? ' is-shot' : '') + '" data-id="' + row.id + '">' +
        '<div class="gutter">' +
          '<div class="row-head" data-action="drag-grip" data-id="' + row.id +
            '" title="Drag to reorder — or use the arrows below">' +
            '<span class="drag-grip" aria-hidden="true"></span>' +
            '<span class="row-num">' + pad2(index + 1) + '</span>' +
          '</div>' +
          (secs >= 0.5 ? '<div class="row-dur" title="Estimated read time">' + formatDuration(secs) + '</div>' : '') +
          '<button class="status-btn" type="button" data-action="cycle-status" data-id="' + row.id +
            '" title="' + escapeHtml(st.label) + ' — click to change" aria-label="Scene status: ' + escapeHtml(st.label) + '">' +
            '<span class="status-dot ' + st.cls + '" style="--st:' + st.color + '"></span>' +
          '</button>' +
          '<button class="gutter-btn" type="button" data-action="move-up" data-id="' + row.id + '" title="Move up" aria-label="Move row up">↑</button>' +
          '<button class="gutter-btn" type="button" data-action="move-down" data-id="' + row.id + '" title="Move down" aria-label="Move row down">↓</button>' +
          '<button class="gutter-btn" type="button" data-action="insert-below" data-id="' + row.id + '" title="Insert row below" aria-label="Insert row below">+</button>' +
          '<button class="gutter-btn danger" type="button" data-action="delete-row" data-id="' + row.id + '" title="Delete row" aria-label="Delete row">×</button>' +
          (row.updatedBy
            ? '<div class="row-meta" title="Last edited by ' + escapeHtml(row.updatedBy) + '">' +
                escapeHtml(String(row.updatedBy).split(/\s+/)[0]) + '<br>' + formatTimestamp(row.updatedAt) + '</div>'
            : '') +
        '</div>' +
        '<div class="cell visual-cell">' +
          '<div class="visual-media' + (row.visualImage ? '' : ' is-empty') + '" data-id="' +
            row.id + '">' + imageBlock + '</div>' +
          fieldBlock(row.id, "visualText", row.visualText, "Describe what is on screen…") +
        '</div>' +
        '<div class="cell audio-cell">' +
          fieldBlock(row.id, "audioText", row.audioText, "Write what gets said…") +
        '</div>' +
      '</div>'
    );
  }

  /* Anything that points at DOM this render is about to destroy must be reset,
     or a later click acts on a stale target: an armed delete would fire without
     ever showing its confirm, and a saved Range would apply to the wrong cell. */
  function resetTransientUiState() {
    clearTimeout(deleteArmTimer);
    deleteArmId = null;
    clearTimeout(deleteCommentArmTimer);
    deleteCommentArmId = null;
    clearTimeout(tagDeleteArmTimer);
    tagDeleteArmId = null;
    tagAddingPersonFor = null;
    savedRange = null;
    savedRangeCell = null;
  }

  function render() {
    if (!state) return;
    resetTransientUiState();
    var rowsEl = document.getElementById("rows");
    /* render() isn't only reachable from user clicks (which naturally blur
       a field first) — a 409-conflict merge or resumeServerDoc() can call
       it from an async network completion while the user is mid-typing in
       a totally different row. innerHTML replacement below unconditionally
       moves focus to <body>, silently discarding the caret and whatever
       was open (a link/video popover, an IME composition). The title input
       already gets this protection; give the same to whichever cell was
       focused, so typing has somewhere to keep landing after a render it
       had nothing to do with. Exact caret position isn't preserved (the
       old DOM node is gone regardless) — landing at the end of the cell's
       new content is the safest default. */
    var focusedCell = document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains("cell-editable") ? document.activeElement : null;
    var refocus = focusedCell
      ? { id: focusedCell.getAttribute("data-id"), field: focusedCell.getAttribute("data-field") }
      : null;

    if (!state.rows.length) {
      rowsEl.innerHTML =
        '<div class="empty-state">' +
          '<div>No rows yet. Each row pairs what is on screen with what gets said.</div>' +
          '<button class="btn btn-accent" type="button" data-action="add-row">+ Add your first row</button>' +
        '</div>';
    } else {
      var html = "";
      for (var i = 0; i < state.rows.length; i++) html += rowHtml(state.rows[i], i);
      rowsEl.innerHTML = html;
      rowsEl.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
    }

    if (refocus) {
      var cellEl = rowsEl.querySelector(
        '.cell-editable[data-id="' + cssAttr(refocus.id) + '"][data-field="' + cssAttr(refocus.field) + '"]');
      if (cellEl) {
        cellEl.focus();
        try {
          var range = document.createRange();
          range.selectNodeContents(cellEl);
          range.collapse(false);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
      }
    }

    var titleInput = document.getElementById("doc-title");
    if (document.activeElement !== titleInput) titleInput.value = state.title || "";
    syncAnchorResolvedClasses();
    updateScriptStats();
    updateCommentsCount();
    updateTagBadges();
    renderProduction();
    captureReplyDrafts();
    renderComments();
    /* A full render means the document changed underneath the UI — a
       merge landing from the server, a version restored. The writer is not
       on the typing path (typing only ever reaches paintRowStatus and the
       debounced counters), so rebuilding it here cannot cost anyone a
       caret, and leaving it stale would show narration that no longer
       matches what is being edited. */
    if (writerOpen) renderWriter();
    /* The ranges this holds point at DOM that has just been thrown away.
       Debounced rather than immediate: render() is already the expensive
       frame, and nothing is wrong in the meantime beyond a missing
       underline. */
    scheduleUntaggedScan();
  }

  /* ================= field sync ================= */

  function syncFieldFromDom(cellEl) {
    var id = cellEl.getAttribute("data-id");
    var field = cellEl.getAttribute("data-field");
    var idx = findRowIndex(id);
    if (idx !== -1) {
      /* Strips the zero-width caret spot ensureTrailingCaretSpot() may have
         appended after a trailing tag/b-roll span — it exists only to give
         the DOM a place to put the caret and must never reach stored text. */
      var html = cellEl.innerHTML.indexOf("​") === -1 ? cellEl.innerHTML : cellEl.innerHTML.replace(/​/g, "");
      if (state.rows[idx][field] !== html) {
        state.rows[idx][field] = html;
        stampRow(state.rows[idx]);
        markDirty();
      }
    }
  }

  /* ================= rich text commands ================= */

  function isSelectionInsideTag(root, tagName) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return false;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== root) {
      if (node.tagName === tagName) return true;
      node = node.parentNode;
    }
    return false;
  }

  /* execCommand("hiliteColor"/"backColor") produces a styled <span
     style="background-color:...">, never a <mark>, in every modern
     browser — removeHighlight() below already knows to look for both, but
     the toggle DECISION point (handleToolbarCmd) and the toolbar's active-
     state indicator only ever checked for MARK, so clicking Highlight a
     second time re-applied it instead of removing it (the field only
     turned into a real <mark> — and so became toggle-able — once it had
     been blurred and sanitizeHtml() ran). */
  function isSelectionHighlighted(root) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return false;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== root) {
      if (node.tagName === "MARK" || (node.tagName === "SPAN" && node.style && node.style.backgroundColor)) return true;
      node = node.parentNode;
    }
    return false;
  }

  function unwrapElement(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function applyHighlight() {
    var ok = false;
    try { ok = document.execCommand("hiliteColor", false, HIGHLIGHT_COLOR); } catch (e) {}
    if (!ok) { try { document.execCommand("backColor", false, HIGHLIGHT_COLOR); } catch (e) {} }
  }

  function removeHighlight(cellEl) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== cellEl) {
      if (node.tagName === "MARK" || (node.tagName === "SPAN" && node.style && node.style.backgroundColor)) {
        unwrapElement(node);
        return;
      }
      node = node.parentNode;
    }
  }

  function updateToolbarState(cellEl) {
    var wrap = cellEl.closest(".field-wrap");
    if (!wrap) return;
    var toolbar = wrap.querySelector(".mini-toolbar");
    if (!toolbar) return;
    ["bold", "italic", "underline", "strikeThrough"].forEach(function (cmd) {
      var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
      if (!btn) return;
      var on = false;
      try { on = document.queryCommandState(cmd); } catch (e) {}
      btn.classList.toggle("is-active", on);
    });
    var hiBtn = toolbar.querySelector('[data-cmd="highlight"]');
    if (hiBtn) hiBtn.classList.toggle("is-active", isSelectionHighlighted(cellEl));
  }

  function handleToolbarCmd(btn) {
    var wrap = btn.closest(".field-wrap");
    var cellEl = wrap.querySelector(".cell-editable");
    var cmd = btn.getAttribute("data-cmd");
    cellEl.focus();
    if (cmd === "highlight") {
      if (isSelectionHighlighted(cellEl)) removeHighlight(cellEl);
      else applyHighlight();
      syncFieldFromDom(cellEl);
      updateToolbarState(cellEl);
      return;
    }
    if (cmd === "link") {
      var sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed || !rangeInside(sel.getRangeAt(0), cellEl)) {
        showToast("Select some text inside one cell, then add a link.", "warn");
        return;
      }
      savedRange = sel.getRangeAt(0).cloneRange();
      savedRangeCell = cellEl;
      var popover = wrap.querySelector(".link-popover");
      popover.hidden = false;
      var input = popover.querySelector("input");
      input.value = "";
      input.focus();
      return;
    }
    if (cmd === "comment") {
      var csel = window.getSelection();
      if (!csel.rangeCount || csel.isCollapsed || !rangeInside(csel.getRangeAt(0), cellEl)) {
        showToast("Select some text inside one cell, then add a comment.", "warn");
        return;
      }
      var quotedText = csel.toString();
      var cRange = csel.getRangeAt(0);
      var cmtId = makeId("c");
      var anchorSpanEl;
      try {
        anchorSpanEl = wrapRangeInComment(cRange, cmtId);
      } catch (e) {
        showToast("Could not anchor a comment to that selection.", "error");
        return;
      }
      csel.removeAllRanges();
      var afterC = document.createRange();
      afterC.setStartAfter(anchorSpanEl);
      afterC.collapse(true);
      csel.addRange(afterC);
      syncFieldFromDom(cellEl);
      openCommentComposer({
        id: cmtId,
        rowId: cellEl.getAttribute("data-id"),
        field: cellEl.getAttribute("data-field"),
        quotedText: quotedText
      });
      return;
    }
    if (cmd === "tag") {
      var tsel = window.getSelection();
      if (!tsel.rangeCount || tsel.isCollapsed || !rangeInside(tsel.getRangeAt(0), cellEl)) {
        showToast("Select the words you want to label first.", "warn");
        return;
      }
      var tagQuoted = tsel.toString().trim();
      /* Which occurrence of this phrase, among any others in the cell, the
         user actually selected — captured now, while the real Range still
         exists, since applyTag() runs after the modal has closed and can
         only re-find the phrase as plain text. Counted the same way
         tagFieldOccurrences() itself counts matches (word-boundary rule and
         document order), by re-running it in countOnly mode over just the
         text before the selection start, so the index lines up exactly. */
      var tagRange = tsel.getRangeAt(0);
      var beforeRange = document.createRange();
      beforeRange.selectNodeContents(cellEl);
      beforeRange.setEnd(tagRange.startContainer, tagRange.startOffset);
      var beforeDiv = document.createElement("div");
      beforeDiv.appendChild(beforeRange.cloneContents());
      var tagOccurrenceIndex = tagQuoted
        ? tagFieldOccurrences(beforeDiv.innerHTML, tagQuoted, "x", "x", true).hits
        : 0;
      openTagComposer({
        rowId: cellEl.getAttribute("data-id"),
        field: cellEl.getAttribute("data-field"),
        quotedText: tagQuoted,
        occurrenceIndex: tagOccurrenceIndex
      });
      return;
    }
    if (cmd === "image") {
      document.getElementById("comment-image-input").click();
      return;
    }
    if (cmd === "video") {
      var vpopover = wrap.querySelector(".video-popover");
      if (vpopover) {
        vpopover.hidden = false;
        var vinput = vpopover.querySelector("input");
        vinput.value = "";
        vinput.focus();
      }
      return;
    }
    document.execCommand(cmd);
    syncFieldFromDom(cellEl);
    updateToolbarState(cellEl);
  }

  /* extractContents() on a range that leaves the cell rips content out of two
     rows at once and loses it, so refuse anything not fully contained */
  function rangeInside(range, el) {
    if (!range || !el) return false;
    return el.contains(range.startContainer) && el.contains(range.endContainer) &&
           el.contains(range.commonAncestorContainer);
  }

  function wrapRangeInLink(range, url) {
    var frag = range.extractContents();
    var a = document.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    a.appendChild(frag);
    range.insertNode(a);
    return a;
  }

  function confirmLink(wrap) {
    if (!wrap) return;
    var popover = wrap.querySelector(".link-popover");
    var input = popover.querySelector("input");
    var url = (input.value || "").trim();
    var owner = wrap.querySelector(".cell-editable");
    /* the saved Range must still belong to THIS field and still be in the document */
    if (!url || !savedRange || !savedRangeCell || savedRangeCell !== owner ||
        !document.contains(savedRangeCell)) {
      popover.hidden = true;
      savedRange = null; savedRangeCell = null;
      return;
    }
    if (!/^https?:\/\//i.test(url) && url.indexOf("mailto:") !== 0) url = "https://" + url;
    var cellEl = savedRangeCell;
    cellEl.focus();
    var sel = window.getSelection();
    sel.removeAllRanges();
    try {
      var a = wrapRangeInLink(savedRange, url);
      var afterRange = document.createRange();
      afterRange.setStartAfter(a);
      afterRange.collapse(true);
      sel.addRange(afterRange);
    } catch (e) {
      sel.addRange(savedRange);
      document.execCommand("createLink", false, url);
      var links = cellEl.querySelectorAll("a:not([target])");
      for (var i = 0; i < links.length; i++) {
        links[i].setAttribute("target", "_blank");
        links[i].setAttribute("rel", "noopener");
      }
    }
    popover.hidden = true;
    savedRange = null; savedRangeCell = null;
    syncFieldFromDom(cellEl);
  }

  function cancelLink(wrap) {
    if (!wrap) return;
    wrap.querySelector(".link-popover").hidden = true;
    savedRange = null; savedRangeCell = null;
  }

  function wrapRangeInComment(range, cmtId) {
    var frag = range.extractContents();
    var span = document.createElement("span");
    span.className = "cmt-anchor";
    span.setAttribute("data-cmt", cmtId);
    span.appendChild(frag);
    range.insertNode(span);
    return span;
  }

  function confirmVideo(wrap) {
    if (!wrap) return;
    var popover = wrap.querySelector(".video-popover");
    var input = popover.querySelector("input");
    var url = (input.value || "").trim();
    popover.hidden = true;
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    var cellEl = wrap.querySelector(".cell-editable");
    cellEl.focus();
    cellEl.appendChild(document.createElement("br"));
    cellEl.appendChild(buildVideoCardEl(url));
    cellEl.appendChild(document.createElement("br"));
    syncFieldFromDom(cellEl);
  }

  function cancelVideo(wrap) {
    if (!wrap) return;
    wrap.querySelector(".video-popover").hidden = true;
  }
