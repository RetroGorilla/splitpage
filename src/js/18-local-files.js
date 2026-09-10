  /* ================= local documents: open, save back, export ================= */

  var openedFile = { name: null, handle: null, kind: null, dirty: false, inPlace: false };

  function fileKindFromName(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "docx") return "docx";
    if (ext === "csv") return "csv";
    if (ext === "md" || ext === "markdown") return "md";
    if (ext === "txt") return "txt";
    return null;
  }

  function updateFileChip() {
    updateHeaderFileChip();
    mirrorFileChipToWriter();
  }

  /* The writer's bar carries the same chip, because it covers the header and
     "where is this going when I hit Save" is not a question anyone should
     have to close a view to answer. Copied from the header chip's rendered
     state rather than re-deriving it — two copies of that branching would
     drift apart, and a copy cannot. */
  function mirrorFileChipToWriter() {
    var src = document.getElementById("file-chip");
    var dst = document.getElementById("wr-file-chip");
    if (!src || !dst) return;
    dst.hidden = src.hidden;
    document.getElementById("wr-file-chip-name").textContent =
      document.getElementById("file-chip-name").textContent;
    var srcState = document.getElementById("file-chip-state");
    var dstState = document.getElementById("wr-file-chip-state");
    dstState.textContent = srcState.textContent;
    dstState.classList.toggle("unsaved", srcState.classList.contains("unsaved"));
  }

  function updateHeaderFileChip() {
    var chip = document.getElementById("file-chip");
    var saveBack = document.getElementById("menu-save-back");
    /* A hosted document takes the chip over: where your work is going is the
       one thing you should never have to guess, and "on the server" is a
       materially different answer from "in a file on this machine". */
    if (onServerDoc()) {
      chip.hidden = false;
      document.getElementById("file-chip-name").textContent = "On the server";
      var srvState = document.getElementById("file-chip-state");
      srvState.textContent = serverSessionExpired
        ? "· signed out — reload"
        : (dirty ? "· saving…" : "· v" + serverDoc.rev + ", everyone sees this");
      srvState.classList.toggle("unsaved", serverSessionExpired || !!dirty);
      saveBack.disabled = true;
      saveBack.textContent = "Save to file";
      return;
    }
    if (!openedFile.name) {
      chip.hidden = true;
      saveBack.disabled = true;
      saveBack.textContent = "Save to file";
      return;
    }
    chip.hidden = false;
    document.getElementById("file-chip-name").textContent = openedFile.name;
    var stateEl = document.getElementById("file-chip-state");
    stateEl.textContent = openedFile.dirty ? "· unsaved changes" : "· up to date";
    stateEl.classList.toggle("unsaved", !!openedFile.dirty);
    saveBack.disabled = false;
    saveBack.textContent = openedFile.inPlace ? "Save to " + openedFile.name : "Save a new copy of " + openedFile.name;
  }

  /* Build the bytes for a given format. Returns {data, filename}. */
  async function buildFileData(kind, baseName) {
    if (kind === "docx") return { data: buildDocx(), filename: baseName + ".docx" };
    if (kind === "csv") return { data: buildCsv(), filename: baseName + ".csv" };
    if (kind === "breakdown") return { data: buildBreakdownCsv(), filename: baseName + " - breakdown.csv" };
    if (kind === "pdf") return { data: buildPdf(), filename: baseName + ".pdf" };
    if (kind === "txt") return { data: htmlToPlainScript(), filename: baseName + ".txt" };
    if (kind === "narration-docx") return { data: buildNarrationDocx(), filename: baseName + " - narration.docx" };
    if (kind === "narration-txt") return { data: buildNarrationText(), filename: baseName + " - narration.txt" };
    if (kind.indexOf("packing-") === 0) {
      var packCatId = kind.slice("packing-".length);
      var packCat = tagCategory(packCatId);
      return { data: buildPackingListPdf(packCatId), filename: baseName + " - " + (packCat ? packCat.label : packCatId) + " packing list.pdf" };
    }
    if (kind === "md-table") return { data: toMarkdownTableDoc(), filename: baseName + " - two column.md" };
    return { data: toMarkdownDoc(), filename: baseName + ".md" };
  }

  function htmlToPlainScript() {
    var lines = [state.title || "Untitled Script", ""];
    state.rows.forEach(function (row, i) {
      lines.push("[" + pad2(i + 1) + "] VISUAL: " + htmlToPlainText(row.visualText));
      lines.push("      AUDIO: " + htmlToPlainText(row.audioText));
      lines.push("");
    });

    /* The breakdown belongs in here too — every other export carries it, and
       a .txt that quietly dropped it looked like a script with nothing
       tagged rather than one whose tags had been left out of the file. */
    var breakdown = breakdownRows();
    if (breakdown.length) {
      lines.push("PRODUCTION BREAKDOWN");
      lines.push("====================");
      lines.push("");
      breakdown.forEach(function (r) {
        /* an orphan has no scene list to print — the old wording ran the
           two branches together and read "0 mentions, scene not in script" */
        var where = r.inScript === "no"
          ? "not in script"
          : r.mentions + " mention" + (r.mentions === 1 ? "" : "s") +
            (r.scenes.length ? ", scene" + (r.scenes.length === 1 ? " " : "s ") + r.scenes.join(", ") : "");
        lines.push(r.categoryLabel + ": " + r.name +
          "  [" + r.statusLabel + "]" +
          (r.owner ? "  —  " + r.owner : "") +
          "  (" + where + ")");
        if (r.notes) {
          r.notes.split(/\r\n|\r|\n/).forEach(function (l) { lines.push("    " + l); });
        }
      });
      lines.push("");
    }

    var comments = commentEntries();
    if (comments.length) {
      lines.push("COMMENTS");
      lines.push("========");
      lines.push("");
      comments.forEach(function (c) {
        lines.push(c.location + (c.resolved ? " (resolved)" : "") +
                   "  —  " + c.author + (c.when ? ", " + c.when : ""));
        if (c.quoted) {
          c.quoted.split(/\r\n|\r|\n/).forEach(function (l) { lines.push('  "' + l + '"'); });
        }
        (c.body || "(empty)").split(/\r\n|\r|\n/).forEach(function (l) { lines.push("  " + l); });
        c.replies.forEach(function (rp) {
          lines.push("");
          var prefix = "  > " + rp.author + (rp.when ? ", " + rp.when : "") + ": ";
          (rp.body || "(empty)").split(/\r\n|\r|\n/).forEach(function (l, i) {
            lines.push((i === 0 ? prefix : "    ") + l);
          });
        });
        lines.push("");
        lines.push("------------------------------");
        lines.push("");
      });
    }
    return lines.join("\n");
  }

  function isSplitpageHtmlName(name) {
    return /\.html?$/i.test(name || "");
  }

  /* Re-opening one of this app's OWN saved files — pull the full document
     (rows, comments, tags, title) back out of its embedded #state-data,
     same as a fresh page load does, rather than treating it as plain text
     to import. It also becomes the file Save/Save As writes to from here
     on, exactly as if you'd just done a Save As into it. */
  async function openSplitpageFile(file, handle, opts) {
    opts = opts || {};
    var text;
    try {
      text = await file.text();
    } catch (e) {
      showToast("Could not read " + file.name + ".", "error");
      return false;
    }
    var doc = new DOMParser().parseFromString(text, "text/html");
    var dataEl = doc.getElementById("state-data");
    var parsed;
    try {
      parsed = JSON.parse(dataEl.textContent);
    } catch (e) {
      showToast(file.name + " doesn't look like a Splitpage file.", "error");
      return false;
    }

    if (!opts.skipSnapshot && state && state.rows.length) pushSnapshot("Before opening " + file.name);

    state = migrateRows(parsed);
    baseState = cloneState(state);
    htmlFileHandle = handle || null;
    /* The breakdown panel's open card, rename box and group mode all belong
       to the document that was on screen a moment ago. Carrying them into a
       different project meant a card springing open by itself whenever the
       two happened to share an item name. */
    resetProductionPanelState();
    /* an .html open replaces the project outright — any file previously
       opened for round-trip export (a .docx/.md/.csv) no longer applies */
    openedFile = { name: null, handle: null, kind: null, dirty: false, inPlace: false };

    clearDirty();
    render();
    updateIdentityChip();
    updateFileChip();
    var commentNote = state.comments.length
      ? ", " + state.comments.length + " comment" + (state.comments.length === 1 ? "" : "s") : "";
    showToast((opts.resumed ? "Resumed " : "Opened ") + (state.title || file.name) + " — " +
      state.rows.length + " row" + (state.rows.length === 1 ? "" : "s") + commentNote, "ok");

    if (handle) rememberLastFileHandle(handle);
    return true;
  }

  function openAnyLocalFile(file, handle) {
    if (isSplitpageHtmlName(file.name)) return openSplitpageFile(file, handle);
    return loadFileIntoEditor(file, handle);
  }

  /* ---- resuming the last project on launch ---- */

  var pendingResumeHandle = null;

  async function tryResumeLastProject() {
    var handle = await loadLastFileHandle();
    if (!handle) return;
    var perm;
    try {
      perm = await handle.queryPermission({ mode: "readwrite" });
    } catch (e) {
      return; /* the handle API is gone, or this handle is from a browser/profile that can no longer use it */
    }
    if (perm === "granted") {
      await resumeFromHandle(handle);
    } else if (perm === "prompt") {
      /* re-granting access needs a real click — queryPermission can check
         quietly, but requestPermission can't be called until one happens */
      showResumeBanner(handle);
    }
    /* "denied" — say nothing further; that means access was explicitly revoked */
  }

  async function resumeFromHandle(handle) {
    try {
      var file = await handle.getFile();
      /* The resume banner needs a real click to grant permission, and that
         can happen well after launch — the user may have typed straight
         into the interim blank document, or opened something else first
         via File > Open, while it sat there. skipSnapshot used to be
         hardcoded true on the assumption nothing worth keeping could exist
         yet; once something does (dirty), this needs the same undo safety
         net a normal file-open gets, or replacing state below silently
         discards it with no way back. */
      await openSplitpageFile(file, handle, { skipSnapshot: !dirty, resumed: true });
    } catch (e) {
      /* moved, renamed, deleted, or on a drive that isn't connected right
         now — not worth interrupting startup over; Version history and the
         File menu are still right there if the user goes looking for it */
    }
  }

  function showResumeBanner(handle) {
    pendingResumeHandle = handle;
    var banner = document.getElementById("resume-banner");
    document.getElementById("resume-banner-text").textContent =
      " " + (handle.name || "your last project") + " needs a click to reopen.";
    banner.hidden = false;
  }

  function hideResumeBanner() {
    pendingResumeHandle = null;
    document.getElementById("resume-banner").hidden = true;
  }

  async function loadFileIntoEditor(file, handle) {
    var kind = fileKindFromName(file.name);
    if (!kind) { showToast("That file type isn't supported — try .docx, .md, .txt or .csv.", "warn"); return; }

    var newRows = null, newTitle = null;
    try {
      if (kind === "docx") {
        var parsed = await docxToRows(file);
        newTitle = parsed.title;
        newRows = parsed.rows;
        /* a Word file with no table: fall back to the paragraph auto-detection */
        if (!newRows.length && parsed.looseText) {
          var looseMode = detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph";
          newRows = normalizeImportedRows(parseImportRows(parsed.looseText, looseMode));
        }
      } else if (kind === "csv") {
        newRows = csvToRows(await file.text());
      } else {
        var text = await file.text();
        var mode = detectTwoColumnFormat(text) ? "twocolumn" : "paragraph";
        newRows = normalizeImportedRows(parseImportRows(text, mode));
        var firstHeading = /^#\s+(.+)$/m.exec(text);
        if (firstHeading) newTitle = firstHeading[1].trim();
      }
    } catch (err) {
      var msg = "Could not read that file.";
      if (err && err.message === "no-decompression-stream") msg = "This browser can't unzip .docx files — try Chrome or Edge.";
      else if (err && (err.message === "not-a-zip" || err.message === "no-document-xml")) msg = "That doesn't look like a Word document.";
      showToast(msg, "error");
      return;
    }

    if (!newRows || !newRows.length) { showToast("No script rows found in that file.", "warn"); return; }

    /* opening a document replaces the whole script — keep a way back */
    if (state.rows.length) pushSnapshot("Before opening " + file.name);

    newRows.forEach(stampRow);
    state.rows = newRows;
    if (newTitle) state.title = newTitle;
    else state.title = file.name.replace(/\.[^.]+$/, "");

    openedFile.name = file.name;
    openedFile.handle = handle || null;
    openedFile.kind = kind;
    openedFile.inPlace = !!(handle && handle.createWritable);
    openedFile.dirty = false;
    /* remember what the file looked like so we never blindly overwrite a
       newer version someone edited in Word while we had it open */
    openedFile.lastModified = file.lastModified || null;
    openedFile.size = file.size || null;

    markDirty();
    openedFile.dirty = false;
    render();
    updateFileChip();
    showToast("Opened " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s"), "ok");
  }

  async function openLocalFile() {
    /* Prefer the File System Access API: it is the only path that can write the
       user's own file back in place. It is blocked in cross-origin frames, so
       fall back to a plain file input whenever it is unavailable or refused. */
    if (window.showOpenFilePicker) {
      try {
        var handles = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: "Scripts and documents",
            accept: {
              "text/html": [".html", ".htm"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
              "text/markdown": [".md"],
              "text/plain": [".txt"],
              "text/csv": [".csv"]
            }
          }]
        });
        var handle = handles[0];
        await openAnyLocalFile(await handle.getFile(), handle);
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; /* user cancelled the picker */
        /* SecurityError / NotAllowedError in a sandboxed frame — use the input instead */
      }
    }
    document.getElementById("open-file-input").click();
  }

  function mimeForFilename(filename) {
    var ext = (/\.([a-z0-9]+)$/i.exec(filename || "") || [, ""])[1].toLowerCase();
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "csv") return "text/csv";
    if (ext === "md" || ext === "markdown") return "text/markdown";
    if (ext === "pdf") return "application/pdf";
    if (ext === "html") return "text/html";
    return "text/plain";
  }

  /* Standard browser download: build a Blob, click a hidden <a download>,
     revoke the object URL once the click has had a moment to be handled. */
  async function deliverFile(filename, data, opts) {
    opts = opts || {};
    try {
      var blob = data instanceof Blob ? data : new Blob([data], { type: mimeForFilename(filename) });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      showToast(opts.savedMsg || ("Saved " + filename), "ok");
      return true;
    } catch (err) {
      showToast("Could not save the file. Please try again.", "error");
      return false;
    }
  }

  async function saveBackToFile(opts) {
    if (!openedFile.name) return;
    var baseName = openedFile.name.replace(/\.[^.]+$/, "");
    var built;
    try {
      built = await buildFileData(openedFile.kind, baseName);
    } catch (e) {
      showToast("Could not build the file.", "error");
      return;
    }

    /* true in-place write, when the browser allows it */
    if (openedFile.handle && openedFile.handle.createWritable) {
      /* has the file changed on disk since we opened it? */
      if (!opts || !opts.force) {
        try {
          var current = await openedFile.handle.getFile();
          var changed = (openedFile.lastModified && current.lastModified &&
                         current.lastModified !== openedFile.lastModified);
          if (changed) {
            showFileConflict(current);
            return;
          }
        } catch (e) { /* cannot re-read it — fall through and let the write decide */ }
      }
      try {
        var writable = await openedFile.handle.createWritable();
        await writable.write(built.data);
        await writable.close();
        openedFile.dirty = false;
        try {
          var after = await openedFile.handle.getFile();
          openedFile.lastModified = after.lastModified;
          openedFile.size = after.size;
        } catch (e) { /* not fatal — the write already succeeded */ }
        updateFileChip();
        showToast("Saved to " + openedFile.name, "ok");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
        /* permission revoked or frame not allowed — fall through to a copy */
        openedFile.inPlace = false;
        updateFileChip();
      }
    }

    var ok = await deliverFile(openedFile.name, built.data, {
      savedMsg: "Saved a copy of " + openedFile.name + " to your downloads"
    });
    if (ok) { openedFile.dirty = false; updateFileChip(); }
  }

  /* The file on disk moved under us. Never overwrite silently — the whole
     point of this guard is that the other version might be someone's work. */
  function showFileConflict(currentFile) {
    var when = currentFile && currentFile.lastModified
      ? formatTimestamp(new Date(currentFile.lastModified).toISOString())
      : "recently";
    document.getElementById("file-conflict-detail").textContent =
      openedFile.name + " changed on disk at " + when +
      ", after you opened it here. Saving now would overwrite that version.";
    document.getElementById("file-conflict-modal").hidden = false;
  }

  function closeFileConflict() {
    document.getElementById("file-conflict-modal").hidden = true;
  }

  async function reloadFileFromDisk() {
    closeFileConflict();
    if (!openedFile.handle) return;
    try {
      pushSnapshot("Before reloading " + openedFile.name + " from disk");
      await loadFileIntoEditor(await openedFile.handle.getFile(), openedFile.handle);
    } catch (e) {
      showToast("Could not re-read that file.", "error");
    }
  }

  async function exportAs(kind) {
    var base = openedFile.name ? openedFile.name.replace(/\.[^.]+$/, "") : slugify(state.title);
    var built;
    try {
      built = await buildFileData(kind, base);
    } catch (e) {
      showToast("Could not build the " + kind.toUpperCase() + " file.", "error");
      return;
    }
    await deliverFile(built.filename, built.data, { savedMsg: "Exported " + built.filename });
  }

  /* An empty narration would export as a file containing nothing but the
     title, which reads as a broken export rather than an empty column. */
  async function exportNarration(kind) {
    if (!narrationRows().length) {
      showToast("There is no narration to export yet — the Audio column is empty.", "warn");
      return;
    }
    await exportAs(kind);
  }

  /* An empty packing list would export as a page with nothing on it but a
     title, same reasoning as exportNarration(). */
  async function exportPackingList(catId) {
    var cat = tagCategory(catId);
    var has = productionEntries().some(function (e) { return e.cat.id === catId; });
    if (!has) {
      showToast("Nothing tagged " + (cat ? cat.label : catId) + " yet — nothing to pack.", "warn");
      return;
    }
    await exportAs("packing-" + catId);
  }

  function toggleFileMenu(force) {
    var menu = document.getElementById("file-menu");
    var btn = document.getElementById("btn-file");
    var open = force === undefined ? menu.hidden : force;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function handleFileMenuAction(action) {
    toggleFileMenu(false);
    if (!state && action !== "history" && action !== "tagging-help"
        && action !== "drive-open" && action !== "about") {
      showToast("Still loading…", "warn"); return;
    }
    if (action === "save-as") saveDoc({ saveAs: true });
    else if (action === "open") openLocalFile();
    else if (action === "paste") openImportModal();
    else if (action === "gdoc-import") openGdocModal();
    else if (action === "save-back") saveBackToFile();
    else if (action === "history") openHistoryPanel();
    else if (action === "export-docx") exportAs("docx");
    else if (action === "export-md") exportAs("md");
    else if (action === "export-md-table") exportAs("md-table");
    else if (action === "export-csv") exportAs("csv");
    else if (action === "export-breakdown") exportAs("breakdown");
    else if (action === "export-pdf") exportAs("pdf");
    else if (action === "export-narration-docx") exportNarration("narration-docx");
    else if (action === "export-narration-txt") exportNarration("narration-txt");
    else if (action === "export-packing-gear") exportPackingList("gear");
    else if (action === "export-packing-prop") exportPackingList("prop");
    else if (action === "drive-open") openDriveModal();
    else if (action === "server-open") openServerPicker();
    else if (action === "server-publish") publishToServer();
    else if (action === "find") openFindBar();
    else if (action === "tagging-help") showTaggingHelp();
    else if (action === "about") showAbout();
  }
