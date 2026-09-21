  /* ================= events ================= */

  function onRootClick(e) {
    var addBtn = e.target.closest('[data-action="add-row"]');
    if (addBtn) { addRow(null); return; }

    var tbBtn = e.target.closest(".mini-toolbar button[data-cmd]");
    if (tbBtn) { handleToolbarCmd(tbBtn); return; }

    var linkConfirm = e.target.closest('[data-action="link-confirm"]');
    if (linkConfirm) { confirmLink(linkConfirm.closest(".field-wrap")); return; }

    var linkCancel = e.target.closest('[data-action="link-cancel"]');
    if (linkCancel) { cancelLink(linkCancel.closest(".field-wrap")); return; }

    var videoConfirm = e.target.closest('[data-action="video-confirm"]');
    if (videoConfirm) { confirmVideo(videoConfirm.closest(".field-wrap")); return; }

    var videoCancel = e.target.closest('[data-action="video-cancel"]');
    if (videoCancel) { cancelVideo(videoCancel.closest(".field-wrap")); return; }

    var toggleResolveBtn = e.target.closest('[data-action="toggle-resolve"]');
    if (toggleResolveBtn) { toggleResolve(toggleResolveBtn.getAttribute("data-id")); return; }

    var toggleReplyBtn = e.target.closest('[data-action="toggle-reply"]');
    if (toggleReplyBtn) { toggleReplyComposer(toggleReplyBtn.getAttribute("data-id")); return; }

    var replyCancelBtn = e.target.closest('[data-action="reply-cancel"]');
    if (replyCancelBtn) { toggleReplyComposer(replyCancelBtn.getAttribute("data-id")); return; }

    var replyPostBtn = e.target.closest('[data-action="reply-post"]');
    if (replyPostBtn) { postReply(replyPostBtn.getAttribute("data-id")); return; }

    var deleteCommentBtn = e.target.closest('[data-action="delete-comment"]');
    if (deleteCommentBtn) { armDeleteComment(deleteCommentBtn, deleteCommentBtn.getAttribute("data-id")); return; }

    var restoreConflictBtn = e.target.closest('[data-action="restore-conflict"]');
    if (restoreConflictBtn) { restoreConflictValue(restoreConflictBtn.getAttribute("data-id")); return; }

    var jumpTagBtn = e.target.closest('[data-action="jump-tag"]');
    if (jumpTagBtn) {
      jumpToTag(jumpTagBtn.getAttribute("data-row"), jumpTagBtn.getAttribute("data-key"));
      return;
    }

    /* The comment card itself is the "jump to text" control — see
       .is-jumpable. Excluded: the reply composer (its own contenteditable,
       name input and link popover all need a plain click to focus, not a
       jump) and any <a> in the comment body (should follow the link, not
       jump away from it — everything else on the card already returned
       above, buttons included, so by this point a click on .comment-actions
       itself is just padding, not a hit). And a click that ends a text
       selection — finishing a drag to copy the quote or the body must never
       also fire a jump. */
    var jumpCard = e.target.closest(".comment-card.is-jumpable");
    if (jumpCard && !e.target.closest(".reply-composer") && !e.target.closest("a") &&
        window.getSelection().isCollapsed) {
      jumpToAnchor(jumpCard.getAttribute("data-id"));
      return;
    }

    /* Ctrl/Cmd or Shift on a card is the multi-select gesture, and it wins
       over everything else the card contains — Ctrl+clicking the status pill
       or the Rename button selects the card rather than firing that control,
       which is what makes "modifier-click anywhere on it" a reliable target.
       Checked first for that reason. */
    var selCard = (e.ctrlKey || e.metaKey || e.shiftKey)
      ? e.target.closest("#production-list .tag-entity") : null;
    if (selCard && handleSelectionClick(e, selCard)) { e.preventDefault(); return; }

    /* On touch, while a selection exists, taps on card HEADS toggle
       membership (standard mobile selection-mode behaviour, and far kinder
       than long-pressing every card). Only the head: the open card's detail
       controls — owner, notes, status — keep working mid-selection. */
    if (IS_TOUCH && selectedKeys().length) {
      var touchHead = e.target.closest("#production-list .tag-entity-head");
      if (touchHead) {
        toggleCardSelection(touchHead.closest(".tag-entity").getAttribute("data-key"));
        return;
      }
    }

    var bulkClear = e.target.closest('[data-action="bulk-clear"]');
    if (bulkClear) { clearProductionSelection(); renderProduction(); return; }

    var bulkDel = e.target.closest('[data-action="bulk-delete"]');
    if (bulkDel) {
      if (bulkDeleteArmed) { disarmBulkDelete(); bulkDeleteSelected(); }
      else { armBulkDelete(); renderProduction(); }
      return;
    }

    var bulkPersonNew = e.target.closest('[data-action="bulk-person-new"]');
    if (bulkPersonNew) {
      tagAddingPersonFor = "__bulk__";
      renderProduction();
      var bpi = document.getElementById("bulk-person-input");
      if (bpi) bpi.focus();
      return;
    }

    var bulkPersonSave = e.target.closest('[data-action="bulk-person-save"]');
    if (bulkPersonSave) { bulkAddPerson(); return; }

    var bulkPersonCancel = e.target.closest('[data-action="bulk-person-cancel"]');
    if (bulkPersonCancel) { tagAddingPersonFor = null; renderProduction(); return; }

    /* both of these are checked ahead of tag-expand: the pill lives inside
       the card head, which is itself the expander, so whichever branch runs
       first wins — and clicking the pill must not also open the card */
    var tagStatusCycle = e.target.closest('[data-action="tag-status-cycle"]');
    if (tagStatusCycle) { setTagStatus(tagStatusCycle.getAttribute("data-key"), null); return; }

    var tagStatusSet = e.target.closest('[data-action="tag-status-set"]');
    if (tagStatusSet) {
      setTagStatus(tagStatusSet.getAttribute("data-key"), tagStatusSet.getAttribute("data-status"));
      return;
    }

    var tagExpandBtn = e.target.closest('[data-action="tag-expand"]');
    if (tagExpandBtn) {
      var expandKey = tagExpandBtn.getAttribute("data-key");
      tagExpanded = tagExpanded === expandKey ? null : expandKey;
      tagRenaming = null;
      tagAddingPersonFor = null;
      renderProduction();
      return;
    }

    var personNewBtn = e.target.closest('[data-action="tag-person-new"]');
    if (personNewBtn) {
      tagAddingPersonFor = personNewBtn.getAttribute("data-key");
      renderProduction();
      var newInput = document.querySelector('.tag-person-input[data-key="' +
        cssAttr(tagAddingPersonFor) + '"]');
      if (newInput) newInput.focus();
      return;
    }

    var personSaveBtn = e.target.closest('[data-action="tag-person-save"]');
    if (personSaveBtn) { addPersonForTag(personSaveBtn.getAttribute("data-key")); return; }

    var personCancelBtn = e.target.closest('[data-action="tag-person-cancel"]');
    if (personCancelBtn) { tagAddingPersonFor = null; renderProduction(); return; }

    var personDeleteBtn = e.target.closest('[data-action="person-delete"]');
    if (personDeleteBtn) { armPersonDelete(personDeleteBtn, personDeleteBtn.getAttribute("data-person")); return; }

    var groupBtn = e.target.closest("#production-modes [data-group]");
    if (groupBtn) {
      productionGroupBy = groupBtn.getAttribute("data-group");
      /* Scene and Shoot draw no cards, so a selection would survive with
         nothing on screen showing it and no bar to act on it. Keeping it
         would break the rule that a selection is always visible. */
      if (productionGroupBy !== "cat" && productionGroupBy !== "person") clearProductionSelection();
      renderProduction();
      return;
    }

    var breakdownBtn = e.target.closest('[data-action="export-breakdown"]');
    if (breakdownBtn) { exportAs("breakdown"); return; }

    var packingGearBtn = e.target.closest('[data-action="export-packing-gear"]');
    if (packingGearBtn) { exportPackingList("gear"); return; }

    var tagRenameBtn = e.target.closest('[data-action="tag-rename"]');
    if (tagRenameBtn) { tagRenaming = tagRenameBtn.getAttribute("data-key"); renderProduction(); return; }

    var tagRenameSave = e.target.closest('[data-action="tag-rename-save"]');
    if (tagRenameSave) { saveTagRename(tagRenameSave.getAttribute("data-key")); return; }

    var tagRenameCancel = e.target.closest('[data-action="tag-rename-cancel"]');
    if (tagRenameCancel) { tagRenaming = null; renderProduction(); return; }

    var tagRemoveBtn = e.target.closest('[data-action="tag-remove"]');
    if (tagRemoveBtn) { armRemoveTag(tagRemoveBtn, tagRemoveBtn.getAttribute("data-key")); return; }

    var tagDeleteBtn = e.target.closest('[data-action="tag-delete"]');
    if (tagDeleteBtn) { armDeleteTag(tagDeleteBtn, tagDeleteBtn.getAttribute("data-key")); return; }

    var catBtn = e.target.closest("#tag-cats .tag-cat-btn");
    if (catBtn) { renderTagCategories(catBtn.getAttribute("data-tag-cat")); return; }

    var restoreSnapBtn = e.target.closest('[data-action="restore-snapshot"]');
    if (restoreSnapBtn) { restoreSnapshotFromCard(restoreSnapBtn); return; }

    var statusBtn = e.target.closest('[data-action="cycle-status"]');
    if (statusBtn) { cycleRowStatus(statusBtn.getAttribute("data-id")); return; }

    var jumpRowBtn = e.target.closest('[data-action="jump-row"]');
    if (jumpRowBtn) {
      var target = document.querySelector('#rows .row[data-id="' + cssAttr(jumpRowBtn.getAttribute("data-row")) + '"]');
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.remove("just-merged");
        void target.offsetWidth;
        target.classList.add("just-merged");
      } else {
        showToast("That scene is no longer here.", "warn");
      }
      return;
    }

    var moveUp = e.target.closest('[data-action="move-up"]');
    if (moveUp) { moveRow(moveUp.getAttribute("data-id"), -1); return; }

    var moveDown = e.target.closest('[data-action="move-down"]');
    if (moveDown) { moveRow(moveDown.getAttribute("data-id"), 1); return; }

    var insertBelow = e.target.closest('[data-action="insert-below"]');
    if (insertBelow) { addRow(insertBelow.getAttribute("data-id")); return; }

    var del = e.target.closest('[data-action="delete-row"]');
    if (del) { armDelete(del, del.getAttribute("data-id")); return; }

    var imgAdd = e.target.closest('[data-action="image-add"], [data-action="image-replace"]');
    if (imgAdd) {
      pendingImageRowId = imgAdd.getAttribute("data-id");
      document.getElementById("file-input").click();
      return;
    }

    var imgRemove = e.target.closest('[data-action="image-remove"]');
    if (imgRemove) { removeImage(imgRemove.getAttribute("data-id")); return; }
  }

  function onRootMouseDown(e) {
    hideTagGhost();
    /* arm the row for dragging only while its grip is held — see the note on
       dragRowId for why the row isn't just permanently draggable */
    var grip = e.target.closest('[data-action="drag-grip"]');
    if (grip) {
      var gripRow = grip.closest(".row");
      if (gripRow) gripRow.setAttribute("draggable", "true");
    }
    if (e.target.closest(".mini-toolbar button")) e.preventDefault();
    /* Handle anchors here, not on click: focusing the cell reveals the mini
       toolbar, which shifts the text down, so mouseup lands elsewhere and the
       synthesized click retargets to an ancestor — the first click was lost. */
    var anchor = e.target.closest(".cmt-anchor");
    if (anchor) jumpToComment(anchor.getAttribute("data-cmt"));

    var tagEl = e.target.closest(".tag-anchor");
    if (tagEl) {
      var key = tagKey(tagEl.getAttribute("data-tag-cat"), tagEl.getAttribute("data-tag-name"));
      /* scene grouping has no per-item card to land on, so clicking a tag in
         the script always comes back to a view that does */
      if (productionGroupBy === "scene") productionGroupBy = "cat";
      tagExpanded = key; /* open straight onto its owner + notes */
      openProductionPanel();
      setTimeout(function () {
        var card = document.querySelector('.tag-entity[data-key="' + cssAttr(key) + '"]');
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.remove("flash");
          void card.offsetWidth;
          card.classList.add("flash");
        }
      }, 30);
    }
  }

  /* The comment composer and every reply box reuse .cell-editable, and their
     input events bubble to the same handler as the script's own cells. Only
     the script itself can carry tags, so everything tag-related below is
     gated on the cell actually being a row field — otherwise typing
     "[boom pole]" into a comment silently made a tag inside that comment and
     registered a production item that could never appear in the script. */
  /* The writer's paragraphs are row fields too — same data-id/data-field,
     same row behind them — so they get the same treatment as the cells in
     the split view. That is the whole reason the writer needed no editing
     code of its own beyond splitting and joining scenes. */
  function isScriptCell(cellEl) {
    return !!(cellEl && cellEl.closest("#rows, #writer-doc") && cellEl.getAttribute("data-field"));
  }

  /* The nearest ancestor that actually scrolls — document for a cell in
     #rows, the .writer-scroll pane for a paragraph in #writer-doc. Walked
     rather than hard-coded, so this keeps working wherever a script cell
     ends up living next. */
  function nearestScrollAncestor(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /* Typing near the edge of the viewport, the browser scrolls the caret
     into view on its own — this is only for what it doesn't reliably
     handle: pasting a large block, or backspacing/selecting-and-deleting a
     big chunk at once, either of which can leave the caret sitting off
     screen with no native scroll to follow it. Losing sight of the scene
     you were just in, right as you cut a paragraph down, is exactly the
     moment it's easiest to lose your place in the script.

     Checked on every input event but a no-op almost all of the time — it
     only acts once the caret has actually drifted out of a comfortable
     margin, so normal typing near the middle of the screen never triggers
     it and never fights the browser's own scroll-follow. */
  function keepCaretInView(cellEl) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    /* a collapsed range at the tail of the text (or right after an atomic
       tag) can report a zero-sized rect — the cell's own edge is still
       close enough to answer "is this on screen right now" */
    if (!rect || (!rect.width && !rect.height)) rect = cellEl.getBoundingClientRect();
    var margin = 32;
    if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
    /* Scrolls to the CARET's own position, not the cell's. A cell that just
       grew to several times the viewport's height — a big paste, or a
       typing shortcut inserting a large block — is exactly the case this
       exists for, and scrollIntoView() on the cell centres the ELEMENT, not
       whatever point inside it the caret happens to be at. On a cell far
       taller than the viewport that can land the caret exactly as far out
       of view as it started. */
    var delta = (rect.top + rect.bottom) / 2 - window.innerHeight / 2;
    nearestScrollAncestor(cellEl).scrollBy({ top: delta, behavior: "smooth" });
  }

  function onRootInput(e) {
    var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
    if (!cellEl) return;
    if (!isScriptCell(cellEl)) return;
    maybeAutoTagShortcut(e, cellEl);
    maybeCaptureBroll(e, cellEl);
    syncFieldFromDom(cellEl);
    keepCaretInView(cellEl);
    /* Keeps the production count/panel in sync with edits that change which
       tags exist in the script WITHOUT going through the tag composer or the
       typing shortcuts — most notably backspacing an atomic tag away
       entirely (see the .tag-anchor contenteditable="false" note), which is
       exactly the kind of edit that used to leave the panel showing stale
       data if it happened to already be open. Debounced because reading the
       tags back means parsing every field of every row: fine once, but not
       twice per keystroke on a long script. */
    scheduleProductionRefresh();
    /* Deleting a marker, or typing past one, changes what the b-roll list
       says as surely as the tag scan — and for the same reason it is
       debounced: reading the markers back means parsing every visual field
       in the script. */
    scheduleBrollRefresh();
    scheduleWriterStats();
    /* Any script edit can change this, not just an edit to a visual cell:
       typing "[boom pole]" into the audio column puts a new item in the
       registry, and every plain-text "boom pole" already sitting in the
       visual column becomes an untagged mention of it. */
    untaggedMutedFor = null;
    scheduleUntaggedScan();
    updateTagGhost(cellEl);
  }

  function onRootFocusOut(e) {
    hideTagGhost();
    hideUntaggedPrompt();
    untaggedMutedFor = null;
    var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
    if (!cellEl) return;
    var wrap = cellEl.closest(".field-wrap");
    var related = e.relatedTarget;
    if (wrap && related && wrap.contains(related)) return; /* focus moved within the same field (e.g. the link popover) — defer sanitizing */
    var clean = sanitizeHtml(cellEl.innerHTML);
    if (clean !== cellEl.innerHTML) cellEl.innerHTML = clean;
    syncFieldFromDom(cellEl);
  }

  function onRootPaste(e) {
    var cellEl = e.target.closest && e.target.closest(".cell-editable");
    if (!cellEl) return;
    e.preventDefault();
    var cd = e.clipboardData || window.clipboardData;
    /* Prefer the HTML flavor, but only once it has been through
       sanitizeHtml/walkSanitize — the same gate every other route into a
       cell's markup goes through. That keeps a tag copied from one scene
       (a .tag-anchor span with its data-tag-cat/data-tag-name) intact when
       pasted into another, without reopening the door to raw HTML pasted in
       from outside Splitpage (a foreign <script>, inline style, etc.) that
       plain-text-only paste used to close off entirely. */
    var html = cd.getData("text/html");
    if (html) {
      var clean = sanitizeHtml(html);
      if (clean) { document.execCommand("insertHTML", false, clean); return; }
    }
    var text = cd.getData("text/plain");
    document.execCommand("insertText", false, text);
  }

  function onRootKeydown(e) {
    if (e.target.matches && e.target.matches(".link-popover input")) {
      if (e.key === "Enter") { e.preventDefault(); confirmLink(e.target.closest(".field-wrap")); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelLink(e.target.closest(".field-wrap")); }
      return;
    }
    if (e.target.matches && e.target.matches(".video-popover input")) {
      if (e.key === "Enter") { e.preventDefault(); confirmVideo(e.target.closest(".field-wrap")); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelVideo(e.target.closest(".field-wrap")); }
      return;
    }
    var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
    if (!cellEl) return;
    /* Ctrl/Cmd+Z right after Alt+Enter: render() rebuilt the contenteditable
       the split happened in, so the browser's own undo history has nothing
       left to act on. undoSplitCellField() is the app-level replacement —
       see its comment in 06-rows.js for why it is safe to try unconditionally
       here (it only actually reverts when nothing has touched either half
       since the split, and is a no-op otherwise). Only Ctrl+Z, not
       Ctrl+Shift+Z — that is a redo request, which this never was. */
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      if (undoSplitCellField()) { e.preventDefault(); return; }
    }
    /* The ghost wins Tab outright: you typed a bracket, so you asked for it.
       The untagged-mention prompt only ever gets the key when nothing more
       explicit is in flight. */
    if (e.key === "Tab" && tagGhost && tagGhost.cellEl === cellEl) {
      if (acceptTagGhost()) { e.preventDefault(); return; }
    }
    if (e.key === "Tab" && !tagGhost && untaggedSuggestion && untaggedSuggestion.cellEl === cellEl) {
      if (acceptUntaggedMention()) { e.preventDefault(); return; }
    }
    if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
      hideTagGhost();
    }
    /* Escape puts the prompt away for this cell until you type again or go
       somewhere else — an arrow key is just moving about, and having it
       reappear as you pass each mention is the point. */
    if (e.key === "Escape" && untaggedSuggestion) {
      untaggedMutedFor = cellEl;
      hideUntaggedPrompt();
    }
    var mod = e.ctrlKey || e.metaKey;
    /* Alt+Enter: split the field being written in — the split view's version
       of the writer's plain Enter (splitCellField/splitRowFieldCore). Its
       own gesture rather than folding into Ctrl+Enter just below, which
       already means something else here — a fresh, empty scene — and stays
       exactly that. Only the focused column moves; the row's other column
       is untouched, still whole, still on the original row.

       (In the writer this key never reaches here: its own capture-phase
       handler treats every Enter, Alt included, as a split and stops the
       event before it bubbles this far — see onWriterKeydown.) */
    if (e.key === "Enter" && e.altKey && !mod && isScriptCell(cellEl)) {
      e.preventDefault();
      hideTagGhost();
      syncFieldFromDom(cellEl);
      splitCellField(cellEl);
      return;
    }
    /* Only the script has scenes to add one to. In a comment or reply box
       this cell has no row behind it, and adding one anyway used to splice a
       new scene onto the top of the document and jump focus into it. */
    if (e.key === "Enter" && mod && isScriptCell(cellEl)) {
      e.preventDefault();
      hideTagGhost();
      syncFieldFromDom(cellEl);
      addRowAndFocus(cellEl.getAttribute("data-id"), cellEl.getAttribute("data-field"));
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); insertLineBreak(cellEl); syncFieldFromDom(cellEl); return; }
    if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); document.execCommand("bold"); syncFieldFromDom(cellEl); updateToolbarState(cellEl); }
    else if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); document.execCommand("italic"); syncFieldFromDom(cellEl); updateToolbarState(cellEl); }
    else if (mod && (e.key === "u" || e.key === "U")) { e.preventDefault(); document.execCommand("underline"); syncFieldFromDom(cellEl); updateToolbarState(cellEl); }
  }

  function onRootDragStart(e) {
    var row = e.target.closest(".row");
    if (!row || !row.getAttribute("draggable")) return;
    dragRowId = row.getAttribute("data-id");
    row.classList.add("is-dragging");
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragRowId); /* Firefox refuses to drag without payload */
    } catch (err) {}
  }

  function onRootDragEnd() {
    dragRowId = null;
    clearDropMarkers();
  }

  /* A file coming in from the desktop, as opposed to a row being dragged
     within the page. `types` is a DOMStringList in some browsers, so it is
     walked by index rather than with indexOf. */
  function isFileDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    return false;
  }

  /* The whole visual column of a scene accepts an image file — the small
     paperclip is only the affordance, not the target. Gated on it actually
     being a file drag and on no row being mid-reorder, so dragging a scene
     across another scene's visual column still reorders rather than being
     swallowed here. Returns the .visual-media div, which carries the row id. */
  function imageDropTarget(e) {
    if (dragRowId || !isFileDrag(e)) return null;
    var cell = e.target.closest(".visual-cell");
    return cell ? cell.querySelector(".visual-media") : null;
  }

  function onRootDragOver(e) {
    var drop = imageDropTarget(e);
    if (drop) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
      document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
        c.classList.remove("drag-over");
      });
      drop.closest(".visual-cell").classList.add("drag-over");
      return;
    }
    if (dragRowId) {
      var row = e.target.closest(".row");
      if (!row || row.getAttribute("data-id") === dragRowId) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
      var box = row.getBoundingClientRect();
      var after = (e.clientY - box.top) > box.height / 2;
      document.querySelectorAll("#rows .row").forEach(function (r) {
        if (r !== row) r.classList.remove("drop-before", "drop-after");
      });
      row.classList.toggle("drop-before", !after);
      row.classList.toggle("drop-after", after);
      return;
    }
    /* Foreign content being dragged in from outside the page (another tab,
       another app) onto a script cell. preventDefault here so 'drop' is
       guaranteed to fire and land in onRootDrop's plain-text-only path below
       instead of some engine's own native "accept the drop" default —
       Chromium's own default for a contenteditable region is to accept it
       and insert raw HTML regardless of what this handler does, which is
       exactly the paste bypass onRootPaste already exists to block. */
    if (e.target.closest && e.target.closest(".cell-editable")) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
    }
  }

  function onRootDragLeave(e) {
    /* only clear when the pointer has actually left the column — dragging
       across the text inside it fires dragleave for every child element */
    var cell = e.target.closest && e.target.closest(".visual-cell");
    if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove("drag-over");
  }

  function onRootDrop(e) {
    var drop = imageDropTarget(e);
    if (drop) {
      e.preventDefault();
      var cell = drop.closest(".visual-cell");
      if (cell) cell.classList.remove("drag-over");
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleImageFile(drop.getAttribute("data-id"), file);
      return;
    }
    if (dragRowId) {
      var row = e.target.closest(".row");
      if (!row) return;
      e.preventDefault();
      var after = row.classList.contains("drop-after");
      var targetId = row.getAttribute("data-id");
      var movingId = dragRowId;
      dragRowId = null;
      clearDropMarkers();
      moveRowTo(movingId, targetId, after);
      return;
    }
    /* Any other drop onto a script cell is foreign content — a page or app
       outside Splitpage dragging in its own text/HTML. onRootPaste already
       forces plain text for exactly this reason (Ctrl+V bypassing
       sanitizeHtml would be as bad as this); mirror it here rather than
       letting the browser perform its own native HTML insertion, which
       never passes through sanitizeHtml/walkSanitize at all. */
    var cellEl = e.target.closest && e.target.closest(".cell-editable");
    if (cellEl) {
      e.preventDefault();
      var text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
      if (text) {
        /* Unlike paste, nothing has focused this cell or put a caret in it —
           the user was dragging, never clicked in. insertText writes at the
           current selection, so without one first it has nowhere to land. */
        cellEl.focus();
        try {
          var range = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
          if (range && cellEl.contains(range.startContainer)) {
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        } catch (err) {}
        document.execCommand("insertText", false, text);
      }
    }
  }

  function init() {
    try { document.execCommand("styleWithCSS", false, true); } catch (e) {}

    /* Fire and forget: the menu items reveal themselves if a server answers,
       and everything below works identically either way. Deliberately not
       awaited — a slow or absent server must never delay the editor opening.

       Except in the one tab that is coming back from a crash with a draft to
       restore. A draft of a SERVER document is merged by resumeServerDoc(),
       which detectServer() leads to and which assigns `state` itself
       (13-hosted.js) — so detecting the server here would race the boot load
       below, and a fast answer with a slow load would let the seed document
       overwrite the resumed one. The draft itself is asked for now, since
       that is only IPC and the answer is wanted as early as possible; the
       detect and the restore both wait for the boot body to finish
       (20g-drafts.js). */
    var draftTaken = null;
    if (DESKTOP && draftRestorePending && typeof DESKTOP.takeDraft === "function") {
      draftTaken = Promise.resolve().then(function () {
        return DESKTOP.takeDraft();
      }).catch(function () { return null; });
    } else {
      detectServer();
    }
    /* Same reasoning as detectServer: fire and forget, and silent when there
       is no launcher to have written the file. */
    loadUpdateStatus();
    var updateDismiss = document.getElementById("update-bar-dismiss");
    if (updateDismiss) updateDismiss.addEventListener("click", dismissUpdateNotice);

    /* Not part of loadUpdateStatus()'s fetch chain on purpose: this must show
       on a plain file:// open and wherever update-status.json 404s, neither
       of which ever calls back into that promise. */
    renderDesktopAppNotice();
    var desktopAppDismiss = document.getElementById("desktop-app-bar-dismiss");
    if (desktopAppDismiss) desktopAppDismiss.addEventListener("click", dismissDesktopAppNotice);
    wireTouchSelection();

    /* On touch the ghost suggestion is a tap target (the Tab key it stands
       in for doesn't exist there). pointerdown, not click: it fires before
       the tap can move the caret out from under the suggestion, and
       preventDefault keeps focus in the cell so the insertion lands where
       the caret already is. */
    var ghostEl = document.getElementById("tag-ghost");
    if (ghostEl) ghostEl.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      acceptTagGhost();
    });

    /* the OS silently revokes a wake lock when the app is backgrounded;
       take it back when the prompter is still up on return */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && prompterOpen) acquireWakeLock();
    });

    state = null;
    initialStateReady = loadInitialState().then(function (loaded) {
      var applied = applyStashedWork(loaded);
      state = applied.state;
      baseState = cloneState(applied.report ? loaded : state);
      render();
      updateIdentityChip();
      /* Same reason as syncDocIdentity() below: a fresh load never goes
         through setSaveButtons(), the funnel these two hang off, so the
         File menu's autosave label and the save-state indicator get their
         first values here rather than waiting for the first keystroke. */
      updateAutoSaveMenu();
      updateSaveStatus();

      if (applied.report) {
        reportMerge(applied.report);
      } else if (loaded.lastEditedBy && loaded.lastEditedBy !== getEditorName()) {
        showToast("Opened the latest version — last edited by " + loaded.lastEditedBy, "ok");
      }

      /* Only offer to resume a remembered project into an untouched, never-
         saved copy of the page — rev/lastEditedBy only get set by a real
         Save (see saveDoc()). Double-clicking an already-saved project's own
         .html must always show exactly that file, never get swapped out from
         under you for some *other* file this browser remembers editing. */
      if (!applied.report && !loaded.rev && !loaded.lastEditedBy) {
        /* Desktop restores whole SESSIONS (every window, every tab) in the
           main process at launch (TAB-BOOT-SYNC / DESKTOP-STATE-V2) — this
           page's own launchIntent already says what it's for (blank,
           open-file, restore-draft, open-server), so there is nothing left
           for the renderer's own "resume the last project" guess to do on
           desktop. Only the plain browser build, which has no main process
           to ask, still resumes from its own remembered IndexedDB handle. */
        if (!DESKTOP) tryResumeLastProject();
      }
      /* Desktop's window title mirrors the document (20f-desktop.js) —
         push an initial value now rather than waiting for the first edit,
         since a fresh load never touches markDirty()/clearDirty() (the
         hook inside setSaveButtons()) until one of the resume paths above
         runs, or the reader types something. */
      /* For the same reason, the boot document's identity is adopted here:
         nothing on this path goes through setSaveButtons(), the funnel that
         notices identity changes afterwards. Then the browser's duplicate
         check opens its channel and announces this document (desktop has
         the main process's claim table instead, and must not run both). */
      if (typeof syncDocIdentity === "function") syncDocIdentity();
      if (!DESKTOP) initDocIdentityChannel();
      if (DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
      /* Move the old shared snapshot list into "Older history" once. Not
         awaited: it never rejects, the key is removed only after the copy is
         confirmed, and nothing at boot depends on it finishing. */
      startHistoryMigration();
    }).then(function () {
      /* The crash-draft restore is part of "the boot state is ready", not
         something that happens after it: until it settles, the document on
         screen is not the one the user left behind. Arm before detect, and
         detect before restoring, because a server draft is merged from inside
         resumeServerDoc() and the restore has to be able to wait for it. */
      if (!draftTaken) return;
      return draftTaken.then(function (t) {
        armServerDraftResume(t);
        detectServer();
        return applyTakenDraft(t);
      });
    });

    var rowsEl = document.getElementById("rows");
    rowsEl.addEventListener("click", onRootClick);
    rowsEl.addEventListener("mousedown", onRootMouseDown);
    rowsEl.addEventListener("input", onRootInput);
    rowsEl.addEventListener("focusout", onRootFocusOut);
    rowsEl.addEventListener("paste", onRootPaste);
    rowsEl.addEventListener("keydown", onRootKeydown);
    rowsEl.addEventListener("dragstart", onRootDragStart);
    rowsEl.addEventListener("dragend", onRootDragEnd);
    rowsEl.addEventListener("dragover", onRootDragOver);
    rowsEl.addEventListener("dragleave", onRootDragLeave);
    rowsEl.addEventListener("drop", onRootDrop);
    /* a drag that ends outside the list still has to clean up after itself */
    document.addEventListener("mouseup", function () {
      if (!dragRowId) clearDropMarkers();
    });
    document.querySelector(".add-row-bar").addEventListener("click", onRootClick);
    window.addEventListener("scroll", hideTagGhost, true);
    window.addEventListener("resize", hideTagGhost);
    /* Both are positioned against a client rect, so both go away rather than
       hang in the wrong place. The prompt comes straight back when the caret
       next moves or a key is pressed. */
    window.addEventListener("scroll", hideUntaggedPrompt, true);
    window.addEventListener("resize", hideUntaggedPrompt);

    var suggestEl = document.getElementById("tag-suggest");
    /* mousedown, not click, is where the default has to go: by the time click
       fires the cell has lost the caret this needs */
    suggestEl.addEventListener("mousedown", function (e) { e.preventDefault(); });
    suggestEl.addEventListener("click", function () { acceptUntaggedMention(); });

    document.getElementById("identity-chip").addEventListener("click", promptForName);

    /* Dismissed for good once you know it, but never lost — File ▸ Tagging
       reference calls showTaggingHelp() to put it back. Kept in localStorage
       rather than the document so it follows the reader, not the script:
       sending someone a file shouldn't hide the reference from them. */
    document.getElementById("tagging-help-dismiss").addEventListener("click", function () {
      document.getElementById("tagging-help").hidden = true;
      try { localStorage.setItem(TAGGING_HELP_KEY, "1"); } catch (e) {}
    });
    var helpDismissed = false;
    try { helpDismissed = localStorage.getItem(TAGGING_HELP_KEY) === "1"; } catch (e) {}
    if (!helpDismissed) document.getElementById("tagging-help").hidden = false;

    /* ---- find & replace ---- */
    document.getElementById("find-close").addEventListener("click", closeFindBar);
    document.getElementById("find-next").addEventListener("click", function () { stepFind(1); });
    document.getElementById("find-prev").addEventListener("click", function () { stepFind(-1); });
    document.getElementById("find-replace").addEventListener("click", replaceCurrent);
    document.getElementById("find-replace-all").addEventListener("click", replaceAll);
    document.getElementById("find-case").addEventListener("click", function (e) {
      findMatchCase = !findMatchCase;
      e.currentTarget.classList.toggle("is-active", findMatchCase);
      e.currentTarget.setAttribute("aria-pressed", findMatchCase ? "true" : "false");
      refreshFindMatches(false);
    });
    document.getElementById("find-input").addEventListener("input", function () {
      refreshFindMatches(false);
    });
    document.getElementById("findbar").addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFindBar(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (e.target.id === "replace-input") { replaceCurrent(); return; }
      stepFind(e.shiftKey ? -1 : 1);
    });
    window.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== "f" && e.key !== "F")) return;
      if (!state) return;
      /* the find bar edits the split view's cells, which are behind the
         writer — opening it there hands the keystroke to something the
         writer cannot see */
      if (writerOpen) return;
      /* Every modal dialog (.modal-backdrop — Import, Google Doc, Comment,
         file-conflict, Server, Drive, Tag) sits fixed above the find bar,
         which is a plain static-flow element with no z-index of its own.
         Without this check, Ctrl+F while typing inside any of them still
         focused the (now invisible, covered) find-input — every further
         keystroke meant for that modal's own field silently vanished into
         a search box the user couldn't even see. */
      if (document.querySelector(".modal-backdrop:not([hidden])")) return;
      /* the script lives across dozens of separate contenteditables, so the
         browser's own find is close to useless here — take the shortcut */
      e.preventDefault();
      if (findOpen) { document.getElementById("find-input").select(); }
      else openFindBar();
    });

    /* ---- reading speed ---- */
    document.getElementById("runtime-chip").addEventListener("click", promptForWpm);

    document.getElementById("history-close").addEventListener("click", closeHistoryPanel);
    document.getElementById("history-panel").addEventListener("click", onRootClick);

    document.getElementById("btn-production").addEventListener("click", function () {
      if (!state) { showToast("Still loading...", "warn"); return; }
      var panel = document.getElementById("production-panel");
      if (panel.hidden) openProductionPanel(); else closeProductionPanel();
    });
    document.getElementById("production-close").addEventListener("click", closeProductionPanel);
    wireTagEntityContainer("production-panel");
    /* production-only: bulk selection and its bar, layered on top of the
       shared wiring above rather than folded into it — the gear panel has
       no selection state and nothing here to select. */
    document.getElementById("production-panel").addEventListener("keydown", function (e) {
      if (!e.target.classList) return;
      if (e.target.id === "bulk-person-input") {
        if (e.key === "Enter") { e.preventDefault(); bulkAddPerson(); }
        else if (e.key === "Escape") { e.preventDefault(); tagAddingPersonFor = null; renderProduction(); }
        return;
      }
      /* wireTagEntityContainer's own keydown listener (registered on this
         SAME element) already handles Escape for these two inputs —
         cancelling a per-card rename or add-person popup. Both listeners
         fire for one keydown since neither calls stopPropagation, so
         without this check, Escape here ALSO ran the "clear the bulk
         selection" branch below — silently wiping out an unrelated
         multi-select the user was still building, as a side effect of
         cancelling an unrelated popup. */
      if (e.target.classList.contains("tag-rename-input") || e.target.classList.contains("tag-person-input")) return;
      /* Escape drops the selection — the counterpart to the bar's ×, and the
         reason a plain click is allowed to leave a selection standing */
      if (e.key === "Escape" && selectedKeys().length) {
        e.preventDefault();
        clearProductionSelection();
        renderProduction();
      }
    });
    document.getElementById("production-panel").addEventListener("change", function (e) {
      /* the bulk dropdowns are commands, not fields: "__none__" is the label
         sitting in the closed select ("Assign to…"), never a value to apply */
      if (e.target.id === "bulk-owner") {
        if (e.target.value !== "__none__") bulkSetOwner(e.target.value);
        return;
      }
      if (e.target.id === "bulk-status") {
        if (e.target.value !== "__none__") bulkSetStatus(e.target.value);
      }
    });

    document.getElementById("btn-gear").addEventListener("click", function () {
      if (!state) { showToast("Still loading...", "warn"); return; }
      var panel = document.getElementById("gear-panel");
      if (panel.hidden) openGearPanel(); else closeGearPanel();
    });
    document.getElementById("gear-close").addEventListener("click", closeGearPanel);
    wireTagEntityContainer("gear-panel");
    document.getElementById("gear-modes").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-group]");
      if (!btn) return;
      gearGroupBy = btn.getAttribute("data-group");
      renderGearList();
    });
    document.getElementById("gear-quickadd-save").addEventListener("click", applyGearQuickAdd);

    wireBrollPanel();

    document.getElementById("server-modal").addEventListener("click", function (e) {
      if (e.target.id === "server-modal") { closeServerPicker(); return; }
      var openBtn = e.target.closest('[data-action="server-open"]');
      if (openBtn) {
        var sid = openBtn.getAttribute("data-id");
        /* Desktop routes through main first — it may already have this
           server document open in another tab (or another window), in
           which case that tab is activated instead of a second copy
           opening here. this-tab means main confirmed this sender tab is
           the right place (pristine and ready), same as opening it always
           has. */
        if (DESKTOP) {
          DESKTOP.routeOpen({ kind: "server", serverDocId: sid }).then(function (r) {
            if (r && r.where === "this-tab") openServerDoc(sid); else closeServerPicker();
          });
        } else {
          openServerDoc(sid);
        }
        return;
      }
      var delBtn = e.target.closest('[data-action="server-delete"]');
      if (delBtn) { armServerDelete(delBtn, delBtn.getAttribute("data-id")); return; }
    });
    document.getElementById("server-close").addEventListener("click", closeServerPicker);
    document.getElementById("server-cancel").addEventListener("click", closeServerPicker);
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("server-modal").hidden) closeServerPicker();
    });

    document.getElementById("drive-modal").addEventListener("click", function (e) {
      if (e.target.id === "drive-modal") { closeDriveModal(); return; }
      var t = e.target.closest("[data-action]");
      if (!t) return;
      var act = t.getAttribute("data-action");
      var id = t.getAttribute("data-id");
      if (act === "drive-save-creds") driveSaveCredsFromForm();
      else if (act === "drive-edit-creds") driveShowCredsForm();
      else if (act === "drive-connect") driveConnect(document.getElementById("drive-folder-input").value);
      else if (act === "drive-crumb") driveCrumbTo(Number(t.getAttribute("data-index")));
      else if (act === "drive-open-item") driveOpenItem(id);
      else if (act === "drive-refresh") driveListCurrent();
      else if (act === "drive-newfolder-toggle") toggleDriveNewFolder();
      else if (act === "drive-newfolder-create") driveCreateFolder();
      else if (act === "drive-newfolder-cancel") toggleDriveNewFolder(false);
      else if (act === "drive-upload") document.getElementById("drive-upload-input").click();
      else if (act === "drive-signin") driveSignIn();
      else if (act === "drive-signout") driveSignOut();
      else if (act === "drive-rename") driveStartRename(id);
      else if (act === "drive-rename-save") driveSaveRename(id);
      else if (act === "drive-rename-cancel") driveCancelRename();
      else if (act === "drive-delete") { var it = driveItemById(id); if (it) armDriveDelete(t, it); }
    });
    document.getElementById("drive-close").addEventListener("click", closeDriveModal);
    document.getElementById("drive-done").addEventListener("click", closeDriveModal);
    document.getElementById("drive-folder-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); driveConnect(e.target.value); }
    });
    document.getElementById("drive-newfolder-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); driveCreateFolder(); }
      else if (e.key === "Escape") { e.preventDefault(); toggleDriveNewFolder(false); }
    });
    ["drive-api-key", "drive-client-id"].forEach(function (id) {
      document.getElementById(id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); driveSaveCredsFromForm(); }
      });
    });
    document.getElementById("drive-upload-input").addEventListener("change", function (e) {
      driveUploadFiles(e.target.files);
      e.target.value = "";
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("drive-modal").hidden) closeDriveModal();
    });

    document.getElementById("tag-modal").addEventListener("click", onRootClick);
    document.getElementById("tag-close").addEventListener("click", closeTagComposer);
    document.getElementById("tag-cancel").addEventListener("click", closeTagComposer);
    document.getElementById("tag-apply").addEventListener("click", applyTag);
    document.getElementById("tag-modal").addEventListener("click", function (e) {
      if (e.target.id === "tag-modal") closeTagComposer();
    });
    document.getElementById("tag-name").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyTag(); }
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("tag-modal").hidden) closeTagComposer();
    });

    document.getElementById("resume-continue").addEventListener("click", async function () {
      var handle = pendingResumeHandle;
      if (!handle) { hideResumeBanner(); return; }
      try {
        var perm = await handle.requestPermission({ mode: "readwrite" }); /* the click this needed */
        if (perm !== "granted") { hideResumeBanner(); return; }
        await resumeFromHandle(handle);
      } catch (e) {
        showToast("Could not reopen that file.", "error");
      }
      hideResumeBanner();
    });
    document.getElementById("resume-dismiss").addEventListener("click", hideResumeBanner);

    document.getElementById("save-error-dismiss").addEventListener("click", function () {
      document.getElementById("save-error-banner").hidden = true;
    });
    document.getElementById("save-error-retry").addEventListener("click", function () {
      document.getElementById("save-error-banner").hidden = true;
      saveDoc();
    });
    document.getElementById("save-error-export").addEventListener("click", function () {
      exportAs("md");
    });

    document.getElementById("merge-dismiss").addEventListener("click", function () {
      document.getElementById("merge-banner").hidden = true;
    });
    document.getElementById("merge-undo").addEventListener("click", function (e) { undoMerge(e.currentTarget); });
    document.getElementById("merge-review").addEventListener("click", function () {
      document.getElementById("merge-banner").hidden = true;
      openCommentsPanel();
    });

    document.getElementById("file-conflict-close").addEventListener("click", closeFileConflict);
    document.getElementById("file-conflict-cancel").addEventListener("click", closeFileConflict);
    document.getElementById("file-conflict-reload").addEventListener("click", function () {
      if (fileConflictCtx && fileConflictCtx.kind === "project") reloadProjectFromDisk();
      else reloadFileFromDisk();
    });
    document.getElementById("file-conflict-overwrite").addEventListener("click", function () {
      var ctx = fileConflictCtx;
      closeFileConflict();
      if (ctx && ctx.kind === "project") saveDoc({ force: true });
      else saveBackToFile({ force: true });
    });
    document.getElementById("file-conflict-copy").addEventListener("click", function () {
      var ctx = fileConflictCtx;
      closeFileConflict();
      if (ctx && ctx.kind === "project") { saveDoc({ saveAs: true }); return; }
      var base = openedFile.name.replace(/\.[^.]+$/, "");
      var ext = (/\.([^.]+)$/.exec(openedFile.name) || [, "md"])[1];
      buildFileData(openedFile.kind, base + " (copy)").then(function (built) {
        deliverFile(base + " (copy)." + ext, built.data, { savedMsg: "Saved a separate copy" });
      });
    });

    var commentModalEl = document.getElementById("comment-modal");
    [commentModalEl, document.getElementById("comments-panel")].forEach(function (el) {
      el.addEventListener("click", onRootClick);
      el.addEventListener("mousedown", onRootMouseDown);
      el.addEventListener("input", onRootInput);
      el.addEventListener("focusout", onRootFocusOut);
      el.addEventListener("paste", onRootPaste);
      el.addEventListener("keydown", onRootKeydown);
    });

    document.getElementById("btn-comments").addEventListener("click", function () {
      if (!state) { showToast("Still loading…", "warn"); return; }
      var panel = document.getElementById("comments-panel");
      if (panel.hidden) openCommentsPanel(); else closeCommentsPanel();
    });
    document.getElementById("comments-panel-close").addEventListener("click", closeCommentsPanel);
    initCommentsPanelResize();
    document.getElementById("comments-hide-resolved").addEventListener("change", function () { captureReplyDrafts(); renderComments(); });
    var commentsSortSelect = document.getElementById("comments-sort");
    commentsSortSelect.value = commentSortMode;
    commentsSortSelect.addEventListener("change", function (e) {
      captureReplyDrafts();
      setCommentSortMode(e.target.value);
    });

    document.getElementById("comment-close").addEventListener("click", function () { closeCommentComposer(true); });
    document.getElementById("comment-cancel").addEventListener("click", function () { closeCommentComposer(true); });
    document.getElementById("comment-post").addEventListener("click", postComment);
    commentModalEl.addEventListener("click", function (e) {
      if (e.target.id === "comment-modal") closeCommentComposer(true);
    });
    document.getElementById("comment-image-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      compressImageFile(file, 700, 0.72).then(function (dataUrl) {
        var cellEl = document.getElementById("comment-body-editable");
        var img = document.createElement("img");
        img.className = "comment-img";
        img.src = dataUrl;
        cellEl.appendChild(document.createElement("br"));
        cellEl.appendChild(img);
        cellEl.appendChild(document.createElement("br"));
      }).catch(function () { showToast("Could not use that image.", "error"); });
    });
    window.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      /* Ctrl+clicking cards leaves focus on the body, so the panel's own
         keydown never sees Escape — clearing a selection has to be caught at
         the window. It takes precedence over closing the panel: Escape undoes
         the most recent thing you did, and that was selecting. */
      if (selectedKeys().length && !document.getElementById("production-panel").hidden) {
        e.preventDefault();
        clearProductionSelection();
        renderProduction();
        return;
      }
      if (!document.getElementById("comment-modal").hidden) closeCommentComposer(true);
      else if (!document.getElementById("comments-panel").hidden) closeCommentsPanel();
    });

    document.addEventListener("selectionchange", function () {
      var active = document.activeElement;
      if (active && active.classList && active.classList.contains("cell-editable")) {
        if (active.classList.contains("wr-para")) updateWriterFormatState();
        else updateToolbarState(active);
      }
      /* Follows the caret without re-scanning: the ranges are already in
         hand, this only picks which one to offer and where to put it. */
      updateUntaggedPrompt();
    });

    document.getElementById("file-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (file && pendingImageRowId) handleImageFile(pendingImageRowId, file);
      e.target.value = "";
      pendingImageRowId = null;
    });

    document.getElementById("doc-title").addEventListener("input", function (e) {
      if (!state) return;
      state.title = e.target.value;
      markDirty();
    });

    /* wrapped, not passed straight through — saveDoc's first argument is its
       options object, and handing it a MouseEvent works only by accident */
    document.getElementById("btn-save").addEventListener("click", function () { saveDoc(); });
    document.getElementById("btn-present").addEventListener("click", function () {
      if (!state) { showToast("Still loading…", "warn"); return; }
      openPrompter();
    });

    document.getElementById("btn-file").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleFileMenu();
    });
    document.getElementById("file-menu").addEventListener("click", function (e) {
      var item = e.target.closest("[data-file-action]");
      if (item && !item.disabled) handleFileMenuAction(item.getAttribute("data-file-action"));
    });
    document.getElementById("file-menu-close").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleFileMenu(false);
    });
    /* the backdrop lives inside .menu-wrap, so the outside-click rule below
       never sees it — clicking away is this listener's job */
    document.getElementById("file-menu-backdrop").addEventListener("click", function () {
      toggleFileMenu(false);
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".menu-wrap")) toggleFileMenu(false);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("file-menu").hidden) toggleFileMenu(false);
    });
    document.getElementById("open-file-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) openProjectFile(file, null);
    });

    document.getElementById("md-rows-keep").addEventListener("click", function () {
      finishMarkdownRowChoice("keep");
    });
    document.getElementById("md-rows-table").addEventListener("click", function () {
      finishMarkdownRowChoice("table");
    });
    window.addEventListener("keydown", function (e) {
      /* Esc means "keep Splitpage's record" — the choice that changes
         nothing. Dismissing a question must never silently rebuild the
         script out of a table. */
      if (e.key === "Escape" && !document.getElementById("md-rows-modal").hidden) {
        finishMarkdownRowChoice("keep");
      }
    });

    document.getElementById("import-close").addEventListener("click", closeImportModal);
    document.getElementById("import-cancel").addEventListener("click", closeImportModal);
    document.getElementById("import-confirm").addEventListener("click", confirmImport);
    /* maybeAutoDetectTwoColumn + updateImportPreview together re-scan and
       re-parse the WHOLE textarea (detectTwoColumnFormat runs twice, once
       in each) with no memoization — on a large pasted script, that ran
       in full on every subsequent keystroke, not just the paste itself.
       Debounced so a run of edits (typing, or the flurry of "input"
       events a paste itself can fire) coalesces into one pass after
       things settle, rather than one per keystroke. */
    var importPreviewDebounce = null;
    document.getElementById("import-textarea").addEventListener("input", function (e) {
      var value = e.target.value;
      clearTimeout(importPreviewDebounce);
      importPreviewDebounce = setTimeout(function () {
        maybeAutoDetectTwoColumn(value);
        updateImportPreview();
      }, 150);
    });
    document.querySelectorAll('input[name="import-split"]').forEach(function (r) {
      r.addEventListener("change", function () {
        importModeTouched = true;
        updateImportPreview();
      });
    });
    document.getElementById("import-choose-file").addEventListener("click", function () {
      document.getElementById("import-file-input").click();
    });
    document.getElementById("import-file-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    });
    document.getElementById("import-modal").addEventListener("click", function (e) {
      if (e.target.id === "import-modal") closeImportModal();
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("import-modal").hidden) closeImportModal();
    });

    document.getElementById("gdoc-close").addEventListener("click", closeGdocModal);
    document.getElementById("gdoc-cancel").addEventListener("click", closeGdocModal);
    document.getElementById("gdoc-confirm").addEventListener("click", confirmGdocImport);
    document.getElementById("gdoc-url-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") confirmGdocImport();
    });
    document.getElementById("gdoc-modal").addEventListener("click", function (e) {
      if (e.target.id === "gdoc-modal") closeGdocModal();
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("gdoc-modal").hidden) closeGdocModal();
    });

    document.getElementById("pp-close").addEventListener("click", closePrompter);
    document.getElementById("pp-voice").addEventListener("click", function () {
      if (voiceFollowActive) stopVoiceFollow(); else startVoiceFollow();
    });
    document.getElementById("pp-play").addEventListener("click", function () { setPrompterPlaying(!prompterPlaying); });
    document.getElementById("pp-speed").addEventListener("input", function (e) { prompterSpeed = Number(e.target.value); });
    document.getElementById("pp-size").addEventListener("input", applyPrompterSize);
    document.getElementById("pp-skip-shot").addEventListener("click", function (e) {
      prompterSkipShot = !prompterSkipShot;
      e.currentTarget.classList.toggle("is-active", prompterSkipShot);
      /* rebuilding resets the read position, so never do it mid-follow */
      stopVoiceFollow();
      setPrompterPlaying(false);
      buildPrompterContent();
      applyPrompterSize();
      document.getElementById("prompter-scroll").scrollTop = 0;
      updateVoiceAvailability();
    });
    document.getElementById("pp-mirror").addEventListener("click", function () {
      setPrompterMirror(!prompterMirror);
    });
    document.getElementById("pp-flip").addEventListener("click", function () {
      setPrompterFlip(!prompterFlip);
    });
    document.getElementById("pp-fullscreen").addEventListener("click", function () {
      var el = document.getElementById("prompter");
      if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
      else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
    });

    window.addEventListener("keydown", function (e) {
      if (!prompterOpen) return;
      if (e.key === "Escape") { closePrompter(); }
      else if (e.key === " ") { e.preventDefault(); setPrompterPlaying(!prompterPlaying); }
      else if (e.key === "ArrowUp") { prompterSpeed = Math.min(160, prompterSpeed + 6); document.getElementById("pp-speed").value = prompterSpeed; }
      else if (e.key === "ArrowDown") { prompterSpeed = Math.max(10, prompterSpeed - 6); document.getElementById("pp-speed").value = prompterSpeed; }
      else if (e.key === "m" || e.key === "M") { setPrompterMirror(!prompterMirror); }
      else if (e.key === "f" || e.key === "F") { setPrompterFlip(!prompterFlip); }
    });

    /* ---- the writer ---- */

    document.getElementById("btn-write").addEventListener("click", function () {
      if (!state) { showToast("Still loading…", "warn"); return; }
      openWriter();
    });

    var writerDocEl = document.getElementById("writer-doc");
    /* The paragraphs are row fields, so they run on the same handlers the
       split view's cells do — see isScriptCell(). onRootClick is
       deliberately NOT among them: its actions (open the production panel
       on this tag, jump to that scene) all reach for the split view's DOM,
       which is sitting stale behind this one until the writer closes. */
    writerDocEl.addEventListener("input", onRootInput);
    writerDocEl.addEventListener("focusout", onRootFocusOut);
    writerDocEl.addEventListener("paste", onRootPaste);
    writerDocEl.addEventListener("keydown", onRootKeydown);
    /* capture, so Enter becomes a new scene before onRootKeydown can make
       it a line break */
    writerDocEl.addEventListener("keydown", onWriterKeydown, true);
    writerDocEl.addEventListener("focusin", function (e) {
      if (e.target.classList && e.target.classList.contains("wr-para")) {
        writerLastCell = e.target;
        updateWriterFormatState();
      }
    });
    writerDocEl.addEventListener("click", function (e) {
      var gutter = e.target.closest('[data-action="writer-jump"]');
      if (gutter) jumpFromWriterToRow(gutter.getAttribute("data-row"));
    });

    document.getElementById("wr-save").addEventListener("click", function () { saveDoc(); });

    document.getElementById("wr-size").addEventListener("input", function (e) {
      applyWriterSize(parseInt(e.target.value, 10), true);
    });

    document.getElementById("writer-title").addEventListener("input", function (e) {
      if (!state) return;
      state.title = e.target.value;
      document.getElementById("doc-title").value = e.target.value;
      markDirty();
    });

    document.querySelector(".writer-bar").addEventListener("mousedown", function (e) {
      /* keep the selection the buttons are about to format */
      if (e.target.closest(".wr-fmt")) e.preventDefault();
    });
    document.querySelector(".writer-bar").addEventListener("click", function (e) {
      var fmt = e.target.closest(".wr-fmt");
      if (fmt) { onWriterFormat(fmt); return; }
      if (e.target.closest("#wr-gutter-mode")) { cycleWriterGutter(); return; }
      if (e.target.closest("#wr-export")) { exportNarration("narration-docx"); return; }
      if (e.target.closest("#wr-close")) closeWriter();
    });

    /* The writer covers the whole screen, but Tab does not know that: from
       the last control on its bar, focus walks on into the header and the
       script cells sitting behind the overlay, where you can type into a
       document you cannot see. Pull it back. Modals and the toasts are
       allowed to take focus — they are drawn on top of the writer and are
       meant to. */
    document.addEventListener("focusin", function (e) {
      if (!writerOpen) return;
      var el = e.target;
      if (!el || !el.closest) return;
      if (el.closest("#writer")) return;
      if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
      var back = document.querySelector("#writer-doc .wr-para") || document.getElementById("wr-close");
      if (back) back.focus();
    });

    window.addEventListener("keydown", function (e) {
      if (!writerOpen || e.key !== "Escape") return;
      /* Escape belongs to the tag suggestion first, if one is showing */
      if (tagGhost) { hideTagGhost(); return; }
      closeWriter();
    });

    /* Another tab still running a build from before per-document history can
       write the old shared key at any time. Migrate what it wrote as soon as
       it lands, rather than leaving it until this page next loads. */
    window.addEventListener("storage", function (e) {
      if (e.key === SNAPSHOT_KEY && e.newValue) startHistoryMigration();
    });

    window.addEventListener("beforeunload", function (e) {
      /* never block the reload that carries a stashed merge home */
      if (dirty && !suppressUnloadWarning) { e.preventDefault(); e.returnValue = ""; }
    });

    /* The service worker is for offline http(s) use — splitpage://app is
       already served locally by the main process, with no network round
       trip to cache anything against, and registering one there would just
       be dead weight sitting on a scheme it was never meant for. */
    if (!DESKTOP && "serviceWorker" in navigator && location.protocol !== "file:") {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }

    /* Desktop glue (20f-desktop.js): wires the native File-menu/header
       commands, file-open events and window-title updates into the exact
       same code paths the in-page UI already uses. A no-op — and every
       DESKTOP-gated branch throughout src/js along with it — whenever this
       page is not running inside the Electron shell. */
    if (DESKTOP && typeof initDesktop === "function") initDesktop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
