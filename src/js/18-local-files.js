  /* ================= local documents: open, save back, export ================= */

  var openedFile = { name: null, handle: null, kind: null, dirty: false, inPlace: false };

  function fileKindFromName(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "docx") return "docx";
    if (ext === "csv") return "csv";
    if (ext === "md" || ext === "markdown") return "md";
    if (ext === "txt") return "txt";
    /* The two project formats and the legacy one. "md" is deliberately in
       both worlds: whether a .md file is one of ours or somebody else's is
       decided by whether it carries a data block, not by its name
       (openProjectFile). */
    if (ext === "splitpage") return "splitpage";
    if (ext === "html" || ext === "htm") return "html";
    return null;
  }

  function updateFileChip() {
    updateHeaderFileChip();
    mirrorFileChipToWriter();
    updateReadonlyBanner();
  }

  /* The banner's own markup (page.html) has always been there, fully
     written, but nothing ever referenced #readonly-banner by id anywhere
     in src/js — serverMode.readOnly only disabled the "publish new doc"
     menu item and showed a one-off toast on a blocked save. A reader
     opening a script they cannot edit got no persistent explanation of
     that. Piggybacks on updateFileChip() so it stays in sync with every
     place document/server state actually changes. */
  function updateReadonlyBanner() {
    var banner = document.getElementById("readonly-banner");
    if (!banner) return;
    banner.hidden = !(serverMode.readOnly && onServerDoc());
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

  /* Build the bytes for a given format. Returns {data, filename}.
     opts.allowImageBundle lets a plain Markdown export ship as a small zip
     instead of a lone .md when it needs to carry pictures (see the "md"
     branch below) — on for the actual Export menu, off for saveBackToFile's
     reuse of this same function, which writes back into a file whose name
     and extension are already fixed and must stay a text file in place. */
  async function buildFileData(kind, baseName, opts) {
    opts = opts || {};
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
    /* The old save format, kept as an export only: one file that opens in
       any browser with nothing installed. PAGE_SHELL and buildPublishHtml
       exist for this and for nothing else now (HANDOFF §3.1). */
    /* standaloneHtmlFor (02b-doc-id.js) leaves the document id out: this
       export is a copy handed to someone else, and carrying the id would make
       it a duplicate of this document the moment both are open. */
    if (kind === "html") return { data: standaloneHtmlFor(state), filename: baseName + ".html" };
    if (kind === "md" && opts.allowImageBundle) {
      /* A script with no pictures stays a single plain-text .md, same as
         always. One with pictures ships as a small zip instead — the .md
         referencing images/scene-NN.ext (toMarkdownDoc, 14-export.js)
         alongside the actual files — rather than ballooning the text file
         with base64 the way the old export did. Gated on allowImageBundle:
         saveBackToFile() reuses this same branch to rewrite an already-open
         file in place, and that file's name and extension are fixed — it
         must stay the plain-text .md it already is. */
      var images = markdownExportImages();
      if (images.length) {
        var entries = [{ name: baseName + ".md", data: strBytes(toMarkdownDoc()) }];
        images.forEach(function (img) { entries.push({ name: img.path, data: img.bytes }); });
        return { data: zipWrite(entries), filename: baseName + " (with images).zip" };
      }
    }
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

  /* Re-opening one of this app's OWN project files — pull the full document
     (rows, comments, tags, statuses, title) back out of it rather than
     treating it as plain text to import. Three shapes arrive here:

       .splitpage  the state JSON itself
       .md         a Markdown table plus the same JSON in a data block —
                   and, if the table was edited elsewhere, those edits
                   reconciled back into it (20d-formats.js)
       .html       a legacy save: the whole app with #state-data inside it

     Anything else — and any .md WITHOUT a data block, i.e. somebody else's
     Markdown — falls through to the ordinary lossy import, unchanged.
     Whichever it was becomes the file Save writes to from here on, in its
     own format; a legacy .html converts to .md on that first Save. */
  /* The reading half, on its own so a second caller can ask "what document is
     in this file?" without adopting it (MARKDOWN-PARSE-RESULT). Crash-draft
     restore (20g-drafts.js) needs exactly that: it has to compare what is on
     disk now against the draft's base BEFORE deciding whether to adopt the
     file, merge into it, or leave it alone entirely.

       {state, kind, docIdEmbedded}   a project file, parsed
       {error:'unreadable'}           the bytes could not be read
       {error:'not-splitpage'}        our extension, but not our content
       null                           not one of ours — import it instead

     Every toast stays in openProjectFile() below: a restore reports its own
     failures in its own words, and a file nobody asked to open has no
     business putting an error toast on screen.

     docIdEmbedded is read BEFORE migrateDocument(), which always leaves a
     valid id behind — see parseMarkdownProject (20d-formats.js) for the same
     ordering and for why a draft restore has to know the difference. */
  /* `opts.noAsk` forwards to applyMarkdownProject: a caller that is only
     asking "what document is in this file?" — the merge review's probe
     (18a-local-merge.js) — must not raise the row-count modal at the user,
     who has not asked for anything yet. It takes the same answer Esc does. */
  async function parseProjectFileState(file, opts) {
    var kind = fileKindFromName(file.name);
    if (kind !== "splitpage" && kind !== "md" && kind !== "html") return null;

    var text;
    try {
      text = await file.text();
    } catch (e) {
      return { error: "unreadable" };
    }

    if (kind === "splitpage") {
      var native;
      try {
        native = parseSplitpageFile(text);
      } catch (e) {
        return { error: "not-splitpage" };
      }
      /* migrateDocument, not bare migrateRows: a file saved before document
         ids existed would otherwise get a new random id on every open, and
         its version history would start over each time. Its id is derived
         from its own content instead (02b-doc-id.js). */
      var nativeEmbedded = docIdEmbeddedIn(native);
      return { state: migrateDocument(native, { kind: "file" }), kind: "splitpage", docIdEmbedded: nativeEmbedded };
    }

    if (kind === "html") {
      var doc = new DOMParser().parseFromString(text, "text/html");
      var dataEl = doc.getElementById("state-data");
      var legacy;
      try {
        legacy = JSON.parse(dataEl.textContent);
      } catch (e) {
        return { error: "not-splitpage" };
      }
      /* same reason as the .splitpage branch above — a legacy page carries
         no id, so it gets the same content-derived one every time it opens */
      var legacyEmbedded = docIdEmbeddedIn(legacy);
      return { state: migrateDocument(legacy, { kind: "file" }), kind: "html", docIdEmbedded: legacyEmbedded };
    }

    var project = null;
    try {
      project = parseMarkdownProject(text);
    } catch (e) {
      project = null;
    }
    if (!project) return null;
    /* awaits the row-count question when the table and the record disagree */
    var reconciled = await applyMarkdownProject(project, opts);
    return { state: reconciled, kind: "md", docIdEmbedded: !!project.docIdEmbedded };
  }

  async function openProjectFile(file, handle, opts) {
    opts = opts || {};
    var parsed = await parseProjectFileState(file);
    /* Not one of ours (including a .md with no data block) — still worth
       importing as text, exactly as before. */
    if (!parsed) return loadFileIntoEditor(file, handle);
    if (parsed.error === "unreadable") {
      showToast("Could not read " + file.name + ".", "error");
      return false;
    }
    if (parsed.error === "not-splitpage") {
      showToast(file.name + " doesn't look like a Splitpage file.", "error");
      return false;
    }
    return adoptProjectState(parsed.state, file, handle, parsed.kind, opts);
  }

  /* The one place a parsed project becomes THE document, whichever format
     it arrived in. `newState` has already been through migrateRows() — by
     way of migrateDocument(), so it carries its document id. */
  function adoptProjectState(newState, file, handle, kind, opts) {
    opts = opts || {};
    /* A document arriving in this tab is the New Tab page's whole purpose,
       however it got here — the page's own Open button, the desktop shell
       routing an open into this tab, a drop. (20j-newtab.js) */
    if (typeof closeNewTabPage === "function") closeNewTabPage();
    if (!opts.skipSnapshot && state && state.rows.length) pushSnapshot("Before opening " + file.name);

    state = newState;
    baseState = cloneState(state);
    /* `name` is the file's home as docHomeKey() (02b-doc-id.js) sees it when
       there is no handle to ask — a plain <input type=file> open.
       `diskBase` is the document exactly as this file last said it was: the
       common ancestor "Merge them" needs to do a true three-way merge if the
       file later changes under us (18a-local-merge.js). It rides on the home
       record so it is dropped the moment the document's home changes, and
       moves with it on every successful write (saveDoc, 14-export.js). */
    docFileHandle = { handle: handle || null, kind: kind, lastModified: file.lastModified || null,
                      name: file.name, diskBase: cloneState(state) };
    /* A hosted document and a local file are two homes for one Save button
       (§3.1). Opening a server document already clears the file side; this
       is the other half, which was missing — open a file while a hosted
       document was loaded and Save still went to the server. */
    serverDoc = { id: null, rev: 0 };
    /* The breakdown panel's open card, rename box and group mode all belong
       to the document that was on screen a moment ago. Carrying them into a
       different project meant a card springing open by itself whenever the
       two happened to share an item name. */
    resetProductionPanelState();
    /* opening a project replaces it outright — any file previously opened
       for round-trip export (a .docx/.csv/foreign .md) no longer applies */
    openedFile = { name: null, handle: null, kind: null, dirty: false, inPlace: false };

    /* This id came from a file on disk, so it has already left the page: a
       later Save As must fork a new one rather than put this id in a second
       file. Set before clearDirty(), whose setSaveButtons() funnel is where
       syncDocIdentity() notices the new document. */
    docIdWrittenOut = true;
    clearDirty();
    render();
    updateIdentityChip();
    updateFileChip();
    /* `silent` suppresses THIS toast and nothing else (DRAFT-RENDERER-API).
       A crash-draft restore adopts the file on disk as a step on the way to
       the document it is really about to show, and announcing "Opened X — 12
       rows" mid-restore would describe a version of the document that was
       already gone by the time the toast appeared. The restore says what
       actually happened, once, when it is finished. */
    var commentNote = state.comments.length
      ? ", " + state.comments.length + " comment" + (state.comments.length === 1 ? "" : "s") : "";
    if (!opts.silent) showToast((opts.resumed ? "Resumed " : "Opened ") + (state.title || file.name) + " — " +
      state.rows.length + " row" + (state.rows.length === 1 ? "" : "s") + commentNote, "ok");

    if (handle) rememberLastFileHandle(handle);
    return true;
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
      /* kind-agnostic on purpose: whatever the last project was — .md,
         .splitpage or a legacy .html — is what reopens here. */
      await openProjectFile(file, handle, { skipSnapshot: !dirty, resumed: true });
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

  /* `opts.reload` marks the one caller that is NOT an open: reloadFileFromDisk()
     re-reading the very file this document is already round-tripping, because
     it changed under us. That is the same document with newer bytes, so it
     keeps its id and its record — see the OPEN = A NEW DOCUMENT note below. */
  async function loadFileIntoEditor(file, handle, opts) {
    opts = opts || {};
    var kind = fileKindFromName(file.name);
    /* The two project formats never belong here: openProjectFile reads them
       properly and only ever hands this function a foreign document (that
       includes a .md with no data block, which really is plain text). */
    if (kind === "splitpage" || kind === "html") kind = null;
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
    if (!opts.reload && state.rows.length) pushSnapshot("Before opening " + file.name);

    newRows.forEach(stampRow);
    /* OPEN = A NEW DOCUMENT (issue #7). This used to replace only
       `state.rows` and the title and keep everything else, so an unrelated
       .docx inherited the previous script's production tags, cast list,
       b-roll list and review comments — a breakdown of text that never
       mentioned any of them — and Save still pointed at the previous
       project's file.

       A foreign .docx/.md/.txt/.csv carries no record of its own, so there
       is nothing here that belongs to the document being opened: the only
       honest reading of "open this file" is a new document. Building it
       through migrateRows() from its two required fields is the same
       construction blankDocumentState() (20j-newtab.js) uses, and the only
       way to be sure nothing of the old document survives — it mints a
       fresh docId and fills in every list empty.

       "Draft 2 of the same script" is still a real workflow and is still
       supported; it is the Paste/Import modal (openImportModal,
       11-import.js), which keeps the breakdown, the people, the b-roll and
       the comments and now takes a file as well as pasted text. */
    var openedTitle = newTitle || file.name.replace(/\.[^.]+$/, "");
    if (opts.reload) {
      /* Not an open: the same document, re-read from the same file. Only
         the rows and the title come back — the breakdown, the cast, the
         b-roll and the comments are this document's own and were never in
         the .docx to begin with. */
      state.rows = newRows;
      state.title = openedTitle;
    } else {
      state = migrateRows({ title: openedTitle, rows: newRows });
      baseState = cloneState(state);
      /* The two homes of the Save button (§3.1). Neither belongs to this
         document: the project file and the hosted document both belonged to
         whatever was on screen a moment ago, and saving into either of them
         would overwrite an unrelated script. */
      docFileHandle = { handle: null, kind: null };
      serverDoc = { id: null, rev: 0 };
      /* The breakdown panel's open card, rename box and group mode belong to
         the document that just went away — same reason adoptProjectState()
         resets them. */
      resetProductionPanelState();
      /* This id was minted here and has never left the page, so a first Save
         can take it with it rather than forking a new one (02b-doc-id.js). */
      docIdWrittenOut = false;
    }

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
    if (typeof closeNewTabPage === "function") closeNewTabPage(); /* 20j-newtab.js */
    render();
    updateIdentityChip();
    updateFileChip();
    if (typeof syncDocIdentity === "function") syncDocIdentity();
    if (DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
    showToast(opts.reload
      ? "Reloaded " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s")
      : "Opened " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") +
        " — as a new document", "ok");
  }

  async function openLocalFile() {
    /* Desktop has a real native Open dialog — DESKTOP.openFileDialog() —
       checked before either web fallback below, which are otherwise
       untouched. null means the user cancelled the dialog; that is not an
       error, so there is nothing further to do. */
    if (DESKTOP) {
      var entry = await DESKTOP.openFileDialog();
      if (!entry) return;
      /* main may already have this path open in another tab (or window) —
         routeOpen activates that tab instead of opening a second copy here.
         'this-tab' is main confirming the sender (this pristine, ready tab)
         is where it belongs, same as every open always landed before tabs. */
      var r = await DESKTOP.routeOpen({ kind: "file", fileId: entry.id });
      if (!r || r.where !== "this-tab") return;
      var desktopHandle = makeDesktopHandle(entry);
      var desktopFile = await desktopHandle.getFile();
      await openProjectFile(desktopFile, desktopHandle);
      return;
    }
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
              "application/json": [".splitpage"],
              "text/html": [".html", ".htm"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
              "text/markdown": [".md"],
              "text/plain": [".txt"],
              "text/csv": [".csv"]
            }
          }]
        });
        var handle = handles[0];
        await openProjectFile(await handle.getFile(), handle);
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
    if (ext === "splitpage") return "application/json";
    if (ext === "zip") return "application/zip";
    return "text/plain";
  }

  /* Every export and every "save a copy" goes through here. Desktop has no
     download tray to drop a file into — an <a download> click is inert in
     Electron's renderer sandbox anyway (see the Artifact runtime's own note
     on this) — so it asks the native Save dialog for a destination and
     writes the bytes there directly. A cancelled dialog is not a failure:
     it returns false with no toast, exactly like a cancelled browser
     download does nothing rather than erroring. */
  async function deliverFile(filename, data, opts) {
    opts = opts || {};
    if (DESKTOP) {
      try {
        var ext = (/\.([a-z0-9]+)$/i.exec(filename) || [, ""])[1].toLowerCase();
        var picked = await DESKTOP.saveFileDialog({
          suggestedName: filename,
          filters: [{ name: ext ? ext.toUpperCase() + " file" : "File", extensions: ext ? [ext] : [] }]
        });
        if (!picked) return false;
        var bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (data instanceof Uint8Array) bytes = data;
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else bytes = strBytes(String(data));
        await DESKTOP.writeFile(picked.id, bytes);
        showToast(opts.savedMsg || ("Saved " + filename), "ok");
        return true;
      } catch (err) {
        showToast("Could not save the file. Please try again.", "error");
        return false;
      }
    }
    /* Standard browser download: build a Blob, click a hidden <a download>,
       revoke the object URL once the click has had a moment to be handled. */
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

  /* Shared by both on-disk-conflict guards: the import re-save path
     (saveBackToFile, below) and the project-save path (saveDoc, 14-export.js).
     Compares `handle`'s file right now against the timestamp recorded the
     last time we successfully read or wrote it. A failed re-read (file
     moved, deleted, or on a drive that isn't connected) is reported the same
     way as a detected change — "Never overwrite silently" (HANDOFF #1)
     covers both, and force:true (the "Overwrite it" button) still gets
     past either uncondtionally. Returns {ok:true} or
     {ok:false, current: File|null}. */
  async function checkFileConflict(handle, lastModified) {
    if (!lastModified) return { ok: true }; /* nothing recorded yet to compare against */
    var current;
    try {
      current = await handle.getFile();
    } catch (e) {
      return { ok: false, current: null };
    }
    if (current.lastModified && current.lastModified !== lastModified) {
      return { ok: false, current: current };
    }
    return { ok: true };
  }

  /* Which flow popped the conflict modal, so its buttons (reload /
     overwrite / save-as-a-copy / merge) know whether to act on the import
     re-save path's `openedFile` or the project-save path's `docFileHandle`.
     Set by showFileConflict(), read by 21-events.js's button wiring. */
  var fileConflictCtx = { kind: "import" };
  /* Bumped by every showFileConflict() and by closeFileConflict(), so a
     modal still waiting on its merge probe never opens over a later one, or
     after the user has already answered. */
  var fileConflictShowToken = 0;

  /* Which home record this conflict is about, read off fileConflictCtx the
     same way each of the modal's buttons reads it — "Merge them" needs the
     answer while the modal is going up, before any button is pressed. */
  function fileConflictHome() {
    return fileConflictCtx && fileConflictCtx.kind === "project" ? docFileHandle : openedFile;
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
        var check = await checkFileConflict(openedFile.handle, openedFile.lastModified);
        if (!check.ok) {
          showFileConflict(openedFile.name, check.current, { kind: "import" });
          return;
        }
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
     point of this guard is that the other version might be someone's work.
     `ctx` records which flow this is for ({kind:"import"} or
     {kind:"project"}) so the modal's three buttons (21-events.js) know
     whether to act on `openedFile` or `docFileHandle`. */
  function showFileConflict(fileName, currentFile, ctx) {
    fileConflictCtx = ctx || { kind: "import" };
    if (!currentFile) {
      /* The file couldn't be re-read at all (moved, deleted, or the drive
         it's on isn't connected right now) — not the same as "changed",
         but the same "don't overwrite without asking" principle applies:
         proceeding straight to a write here (what used to happen — the
         read failure was silently swallowed) defeats the one thing this
         guard exists to catch. Reuses the same modal/force-save path. */
      document.getElementById("file-conflict-detail").textContent =
        "Could not check whether " + fileName + " is still there — it may have been moved, " +
        "deleted, or is on a drive that isn't connected right now. Saving now would recreate it.";
      /* nothing readable to merge with */
      resetMergeOffer();
      document.getElementById("file-conflict-modal").hidden = false;
      return;
    }
    var when = currentFile.lastModified
      ? formatTimestamp(new Date(currentFile.lastModified).toISOString())
      : "recently";
    document.getElementById("file-conflict-detail").textContent =
      fileName + " changed on disk at " + when +
      ", after you opened it here. Saving now would overwrite that version.";
    /* "Merge them" is revealed only once that version has been read back as
       a document — a file this app cannot parse has nothing to merge
       (18a-local-merge.js). The modal waits for that answer before it
       opens: the row is right-aligned, so a button appearing a moment
       after the others would shove them sideways under the pointer. The
       read is local and takes milliseconds; should it ever not answer, the
       four choices the modal has always had go up on their own. */
    var token = ++fileConflictShowToken;
    var show = function () {
      if (token !== fileConflictShowToken) return;   /* superseded or closed */
      document.getElementById("file-conflict-modal").hidden = false;
    };
    var probe = offerFileMerge(currentFile, fileConflictHome());
    var timer = setTimeout(show, 1500);
    probe.then(function () { clearTimeout(timer); show(); },
               function () { clearTimeout(timer); show(); });
  }

  function closeFileConflict() {
    fileConflictShowToken++;
    document.getElementById("file-conflict-modal").hidden = true;
    resetMergeOffer();
  }

  async function reloadFileFromDisk() {
    closeFileConflict();
    if (!openedFile.handle) return;
    try {
      pushSnapshot("Before reloading " + openedFile.name + " from disk");
      await loadFileIntoEditor(await openedFile.handle.getFile(), openedFile.handle, { reload: true });
    } catch (e) {
      showToast("Could not re-read that file.", "error");
    }
  }

  /* The project-save counterpart of reloadFileFromDisk() above — reopens
     through openProjectFile() rather than loadFileIntoEditor() so a newer
     on-disk version is read as a project (.md/.splitpage), tags, comments,
     statuses and all, not flattened through the plain-text import path. */
  async function reloadProjectFromDisk() {
    closeFileConflict();
    if (!docFileHandle.handle) return;
    try {
      await openProjectFile(await docFileHandle.handle.getFile(), docFileHandle.handle);
    } catch (e) {
      showToast("Could not re-read that file.", "error");
    }
  }

  async function exportAs(kind) {
    var base = openedFile.name ? openedFile.name.replace(/\.[^.]+$/, "") : slugify(state.title);
    var built;
    try {
      built = await buildFileData(kind, base, { allowImageBundle: true });
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

  /* The menu is a left drawer (see .menu in app.css), so opening it also
     raises a backdrop over the page. Both halves live here so every caller
     that already said toggleFileMenu(false) still closes the whole thing. */
  function toggleFileMenu(force) {
    var menu = document.getElementById("file-menu");
    var btn = document.getElementById("btn-file");
    var backdrop = document.getElementById("file-menu-backdrop");
    var open = force === undefined ? menu.hidden : force;
    menu.hidden = !open;
    if (backdrop) backdrop.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      /* the drawer is tall and scrolls; a reopen should start at the top
         rather than wherever the last visit left it */
      var body = menu.querySelector(".menu-body");
      if (body) body.scrollTop = 0;
    } else if (menu.contains(document.activeElement)) {
      /* closing with the focus still inside would leave it on a hidden
         element, which strands the keyboard on nothing */
      btn.focus();
    }
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
    else if (action === "autosave") toggleAutoSave();
    else if (action === "toggle-hide-shot") toggleHideShotScenes();
    else if (action === "history") openHistoryPanel();
    else if (action === "export-docx") exportAs("docx");
    else if (action === "export-md") exportAs("md");
    else if (action === "export-md-table") exportAs("md-table");
    else if (action === "export-csv") exportAs("csv");
    else if (action === "export-breakdown") exportAs("breakdown");
    else if (action === "export-pdf") exportAs("pdf");
    else if (action === "export-html") exportAs("html");
    else if (action === "export-narration-docx") exportNarration("narration-docx");
    else if (action === "export-narration-txt") exportNarration("narration-txt");
    else if (action === "export-packing-gear") exportPackingList("gear");
    else if (action === "export-packing-prop") exportPackingList("prop");
    else if (action === "drive-open") openDriveModal();
    else if (action === "server-open") openServerPicker();
    else if (action === "server-publish") publishToServer();
    else if (action === "share-link") publishAndCopyShareLink();
    else if (action === "find") openFindBar();
    else if (action === "export-app-data") exportAppData();
    else if (action === "import-app-data") openImportAppData();
    else if (action === "tagging-help") showTaggingHelp();
    else if (action === "about") showAbout();
  }
