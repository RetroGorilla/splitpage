  /* ================= row actions ================= */

  function addRow(afterId) {
    lastSplitUndo = null;
    var row = { id: makeId(), visualText: "", visualImage: null, audioText: "",
                status: "todo", updatedAt: nowIso(), updatedBy: getEditorName() };
    if (afterId) {
      var idx = findRowIndex(afterId);
      state.rows.splice(idx + 1, 0, row);
    } else {
      state.rows.push(row);
    }
    markDirty();
    render();
  }

  /* Ctrl/Cmd+Enter while writing: open the next scene and land in the same
     column you were already in, so a run of scenes can be typed without
     reaching for the mouse. render() rebuilds every row, so the new cell has
     to be looked up afterwards rather than held across the call. */
  function addRowAndFocus(afterId, field) {
    addRow(afterId);
    var idx = findRowIndex(afterId);
    var created = state.rows[idx + 1];
    if (!created) return;
    var cell = document.querySelector('#rows .row[data-id="' + safeId(created.id, "r") +
      '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]');
    if (!cell) return;
    cell.focus();
    var range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    cell.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* Splits ONE field's content at the caret into a new row directly below —
     the shared core behind both the writer's plain Enter (splitWriterRow)
     and the split view's Alt+Enter (splitCellField). Everything from the
     caret to the end of the field moves to the new row's same field; the
     row's OTHER field — the column that was not being written in — is left
     completely alone, still whole, still on the original row. Returns
     {idx, created, field}, or null if the caret was not actually in a field
     of a live row (the caller does nothing in that case). */
  function splitRowFieldCore(cellEl) {
    var idx = findRowIndex(cellEl.getAttribute("data-id"));
    var field = cellEl.getAttribute("data-field");
    if (idx === -1 || !field) return null;
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!cellEl.contains(range.startContainer)) return null;
    /* captured before any mutation below — the field's whole content as it
       stood the instant the split was requested, for undoSplitCellField */
    var originalHtml = sanitizeHtml(cellEl.innerHTML);
    var rowId = state.rows[idx].id;
    if (!range.collapsed) range.deleteContents();

    var tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(cellEl, cellEl.childNodes.length);
    var holder = document.createElement("div");
    holder.appendChild(tail.extractContents());

    state.rows[idx][field] = sanitizeHtml(cellEl.innerHTML);
    stampRow(state.rows[idx]);

    var created = { id: makeId(), visualText: "", visualImage: null, audioText: "",
                     status: "todo", updatedAt: nowIso(), updatedBy: getEditorName() };
    created[field] = sanitizeHtml(holder.innerHTML);
    state.rows.splice(idx + 1, 0, created);
    /* half the field's text just moved to a new row — any comment anchored
       in that half has to move with it */
    repointCommentsForRows([state.rows[idx], created]);
    return { idx: idx, created: created, field: field, rowId: rowId, originalHtml: originalHtml };
  }

  /* One-level undo for splitCellField (Alt+Enter). The DOM rebuild in
     render() tears down the contenteditable the browser's own undo history
     lives on, so native Ctrl+Z has nothing left to act on after a split —
     this is the app-level replacement, scoped tightly enough that it never
     clobbers work done after the split it remembers:
       - any other row-structural edit (add/delete/move/another split)
         clears it, so a stale entry can never resurrect a row a later
         action already accounted for;
       - undoSplitCellField itself refuses unless both halves still hold
         exactly what the split put there, so text typed into either cell
         afterwards is never silently discarded. */
  var lastSplitUndo = null;

  function splitCellField(cellEl) {
    var res = splitRowFieldCore(cellEl);
    if (!res) return;
    lastSplitUndo = {
      rowId: res.rowId,
      field: res.field,
      originalHtml: res.originalHtml,
      createdId: res.created.id,
      remainderHtml: state.rows[res.idx][res.field],
      createdHtml: res.created[res.field]
    };
    markDirty();
    render();
    focusRowField(res.created.id, res.field, 0);
  }

  /* Ctrl/Cmd+Z right after Alt+Enter: puts the field back together on the
     original row and removes the row the split created. Returns true when it
     actually undid something, so the caller knows to swallow the keystroke
     rather than let a native undo fight it. */
  function undoSplitCellField() {
    var undo = lastSplitUndo;
    if (!undo) return false;
    lastSplitUndo = null;
    var rowIdx = findRowIndex(undo.rowId);
    var createdIdx = findRowIndex(undo.createdId);
    if (rowIdx === -1 || createdIdx === -1) return false;
    /* either half touched since the split (typed into, tagged, formatted) —
       undoing now would throw that edit away, so decline instead */
    if (state.rows[rowIdx][undo.field] !== undo.remainderHtml) return false;
    if (state.rows[createdIdx][undo.field] !== undo.createdHtml) return false;
    var removed = state.rows.splice(createdIdx, 1)[0];
    state.rows[rowIdx][undo.field] = undo.originalHtml;
    stampRow(state.rows[rowIdx]);
    repointCommentsForRows([state.rows[rowIdx], removed]);
    markDirty();
    render();
    focusRowField(undo.rowId, undo.field, 0);
    return true;
  }

  /* Land the caret at a plain-text offset inside a specific field of a
     specific row — addRowAndFocus's caret placement, generalised to any
     offset rather than always the start. */
  function focusRowField(rowId, field, offset) {
    var cell = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") +
      '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]');
    if (!cell) return;
    cell.focus();
    placeCaretAtTextOffset(cell, offset || 0);
    cell.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---- drag to reorder ----

     Only the row number is a grip. Rows are full of contenteditable text, and
     making the whole row draggable would break selecting that text with the
     mouse — so draggable is switched on only while the grip is held, and off
     again the moment the drag ends. */
  var dragRowId = null;

  function clearDropMarkers() {
    document.querySelectorAll("#rows .row").forEach(function (r) {
      r.classList.remove("drop-before", "drop-after", "is-dragging");
      r.removeAttribute("draggable");
    });
    /* a file drag that ends outside the window never fires drop, so the
       highlight has to be cleared here too or it sticks */
    document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
      c.classList.remove("drag-over");
    });
  }

  function moveRowTo(id, targetId, after) {
    lastSplitUndo = null;
    var from = findRowIndex(id);
    var to = findRowIndex(targetId);
    if (from === -1 || to === -1 || from === to) return;
    var row = state.rows.splice(from, 1)[0];
    /* recompute after the splice: removing the dragged row shifts everything
       below it up by one, so the index captured before is off by one there */
    var dest = findRowIndex(targetId);
    state.rows.splice(after ? dest + 1 : dest, 0, row);
    markDirty();
    render();
    queueAutoSave();
  }

  function deleteRow(id) {
    var idx = findRowIndex(id);
    if (idx === -1) return;
    lastSplitUndo = null;
    state.rows.splice(idx, 1);
    markDirty();
    render();
  }

  function moveRow(id, dir) {
    var idx = findRowIndex(id);
    var j = idx + dir;
    lastSplitUndo = null;
    if (idx === -1 || j < 0 || j >= state.rows.length) return;
    var tmp = state.rows[idx];
    state.rows[idx] = state.rows[j];
    state.rows[j] = tmp;
    markDirty();
    render();
  }

  function armDelete(btn, id) {
    if (deleteArmId === id) {
      clearTimeout(deleteArmTimer);
      deleteArmId = null;
      deleteRow(id);
      return;
    }
    document.querySelectorAll(".gutter-btn.danger.armed").forEach(function (b) { b.classList.remove("armed"); b.textContent = "×"; });
    deleteArmId = id;
    btn.classList.add("armed");
    btn.textContent = "✓";
    clearTimeout(deleteArmTimer);
    deleteArmTimer = setTimeout(function () {
      deleteArmId = null;
      btn.classList.remove("armed");
      btn.textContent = "×";
    }, 2800);
  }

  /* ================= images ================= */

  /* Formats that commonly carry a real alpha channel — a screenshot/cutout/
     logo attached in one of these keeps its transparency by staying PNG;
     anything else (photos: JPEG, HEIC-via-browser-decode, etc.) still goes
     through the smaller lossy JPEG path, since those never have alpha to
     begin with. */
  var ALPHA_CAPABLE_TYPE = /^image\/(png|gif|webp)$/;

  function compressImageFile(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      if (!file || file.type.indexOf("image/") !== 0) { reject(new Error("not an image")); return; }
      var keepAlpha = ALPHA_CAPABLE_TYPE.test(file.type);
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("read failed")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("decode failed")); };
        img.onload = function () {
          /* A canvas format without alpha support (JPEG) composites every
             transparent pixel onto solid black before encoding, per the
             canvas spec — permanently destroying a PNG/GIF/WebP's
             transparency with no error or warning. Runs inside a try/catch
             too: this callback fires asynchronously, after the Promise
             executor has already returned, so a synchronous throw in here
             (e.g. a SecurityError from a tainted canvas — a cross-origin
             reference inside an SVG, say) would otherwise never resolve OR
             reject the promise, leaving the upload hanging forever with no
             toast and nothing but a console error to show for it. */
          try {
            var w = img.width, h = img.height;
            var scale = Math.min(1, maxDim / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement("canvas");
            canvas.width = cw; canvas.height = ch;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, cw, ch);
            resolve(keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function handleImageFile(rowId, file) {
    compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
      var idx = findRowIndex(rowId);
      if (idx === -1) return;
      state.rows[idx].visualImage = dataUrl;
      stampRow(state.rows[idx]);
      markDirty();
      render();
    }).catch(function () { showToast("Could not use that image.", "error"); });
  }

  function removeImage(rowId) {
    var idx = findRowIndex(rowId);
    if (idx === -1) return;
    state.rows[idx].visualImage = null;
    stampRow(state.rows[idx]);
    markDirty();
    render();
  }
