  /* ================= save / export ================= */

  async function saveDoc(opts) {
    opts = opts || {};
    var saveAs = !!opts.saveAs;
    /* A Save As makes a second file. If this document's id has already been
       written somewhere (a file, a server, a draft), both files would carry
       it and share one version history, so the copy gets a new id. An id
       that never left the page just travels with its first save. Decided on
       opts.saveAs, not the local `saveAs` below: a legacy .html converting to
       .md on its first Save is the same document moving house, not a copy. */
    var forkDocId = (opts.saveAs && docIdWrittenOut) ? mintDocId() : null;
    /* Which document this save belongs to. Every await below (the native
       dialog above all — main keeps serving a double-click in Explorer while
       it is up) can end with a different document on screen, and nothing
       that follows may re-id, retarget or mark clean THAT one on this save's
       behalf. Same check as publishToServer's `state.docId === oldId`. */
    var docIdAtSave = state.docId;
    /* A fresh pick retargets Save only if the write lands. Otherwise the next
       plain Save would quietly reuse a file that never got this document —
       and, after a Save As whose fork was thrown away with the failed write,
       put the already-used id into a second file (invariant #36). */
    var prevDocFileHandle = null;
    var retarget = null;
    var wrote = false;
    function retargetTo(handle, k) {
      if (state.docId !== docIdAtSave) return;
      prevDocFileHandle = docFileHandle;
      retarget = { handle: handle, kind: k, lastModified: null, name: handle.name };
      docFileHandle = retarget;
    }
    function undoRetarget() {
      if (retarget && !wrote && docFileHandle === retarget) docFileHandle = prevDocFileHandle;
      retarget = null;
    }
    saveInFlight = true;
    setSaveButtons("Saving…", true);

    /* A hosted document saves to the server, not to disk. "Save As" still
       means "give me a local copy of this", so it deliberately falls through
       to the file path below even when a server document is open — that is
       how you take a script home, or fork one. */
    if (onServerDoc() && !saveAs) {
      try {
        await saveToServer();
      } finally {
        saveInFlight = false;
        setSaveButtons(dirty ? "Save •" : "Save", false);
      }
      return;
    }

    /* A project opened from a legacy .html file is never written back as
       HTML — the page stopped being a document format when .md and
       .splitpage arrived (HANDOFF §3.1). The first Save after opening one
       behaves as Save As, defaulting to <slug>.md, and says why. */
    var converting = !saveAs && docFileHandle.kind === "html";
    if (converting) {
      saveAs = true;
      showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
    }

    /* Freeze exactly what we save. `state` keeps mutating while the write is
       in flight, so re-cloning here means edits typed during the save aren't
       silently included as if they'd already been saved. */
    state.rev = (state.rev || 0) + 1;
    state.lastEditedBy = getEditorName();
    state.lastEditedAt = nowIso();
    var published = cloneState(state);
    /* the bytes carry the fork's id; `state` adopts it only once the write
       has succeeded (adoptSavedCopyDocId), so a cancelled dialog or a failed
       write leaves this document's identity exactly as it was */
    if (forkDocId) published.docId = forkDocId;
    var seqAtSave = editSeq;
    var slug = slugify(published.title);
    /* Save As always asks where to write, ignoring any file we already have.
       Plain Save reuses that file once one exists, and only asks the first
       time it has none. Either way, a fresh pick becomes the file future
       plain Saves write to — once the write to it has succeeded
       (retargetTo/undoRetarget above). */
    var targetHandle = saveAs ? null : docFileHandle.handle;
    /* Which serializer runs is decided by the file, not by a preference —
       and for a fresh pick that cannot be known until the picker has come
       back with the name the user typed. */
    var kind = saveAs ? "md" : (docFileHandle.kind || "md");

    /* Was this the same file we already had open, with a fresh-pick not
       needed? Then the on-disk-conflict check below applies — a brand new
       pick from the Save As dialog has no prior baseline to compare against
       (checkFileConflict skips it when lastModified is unset), and a picked
       file that happens to already exist is a deliberate replace through
       the OS's own picker, not "changed under us". */
    var reusingHandle = !!targetHandle;

    try {
      /* Desktop has no File System Access API at all (it is a Chromium
         feature, not something Electron's renderer gets for free), and a
         native Save dialog is the whole point of running as a real app —
         DESKTOP.saveFileDialog() is checked first so it is never shadowed
         by the browser branch below, which stays exactly as it was for the
         web build. A cancelled native dialog resolves null, same shape as
         the picker's AbortError just below: restore the rev bump, no error
         toast, nothing written. */
      if (!targetHandle && DESKTOP) {
        var pickedDesktop = await DESKTOP.saveFileDialog({
          suggestedName: slug + ".md",
          filters: [
            { name: "Markdown script", extensions: ["md"] },
            { name: "Splitpage script", extensions: ["splitpage"] }
          ]
        });
        if (!pickedDesktop) {
          state.rev = Math.max(0, (state.rev || 1) - 1);
          saveInFlight = false;
          setSaveButtons(dirty ? "Save •" : "Save", false);
          return;
        }
        targetHandle = makeDesktopHandle(pickedDesktop);
        kind = fileKindFromName(pickedDesktop.name) === "splitpage" ? "splitpage" : "md";
        retargetTo(targetHandle, kind);
      } else if (!targetHandle && window.showSaveFilePicker) {
        targetHandle = await window.showSaveFilePicker({
          suggestedName: slug + ".md",
          types: [
            { description: "Markdown script", accept: { "text/markdown": [".md"] } },
            { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
          ]
        });
        kind = fileKindFromName(targetHandle.name) === "splitpage" ? "splitpage" : "md";
        retargetTo(targetHandle, kind);
      }

      /* On-disk conflict check (HANDOFF #1, same guard as the import
         re-save path's saveBackToFile) — only when writing back into the
         file we already had open, and not when opts.force says the user
         just chose "Overwrite it" in that modal. */
      if (reusingHandle && !opts.force) {
        var check = await checkFileConflict(targetHandle, docFileHandle.lastModified);
        if (!check.ok) {
          showFileConflict(targetHandle.name, check.current, { kind: "project" });
          state.rev = Math.max(0, (state.rev || 1) - 1);
          saveInFlight = false;
          setSaveButtons(dirty ? "Save •" : "Save", false);
          return;
        }
      }

      var filename = slug + (kind === "splitpage" ? ".splitpage" : ".md");
      var body;
      try {
        body = kind === "splitpage" ? buildSplitpageFile(published) : buildMarkdownProject(published);
      } catch (e) {
        showToast("Could not prepare the file to save.", "error");
        state.rev = Math.max(0, (state.rev || 1) - 1);
        /* before setSaveButtons, whose identity sync would otherwise adopt
           the never-written file as this document's home for a moment */
        undoRetarget();
        saveInFlight = false;
        setSaveButtons(dirty ? "Save •" : "Save", false);
        return;
      }

      if (targetHandle) {
        var writable = await targetHandle.createWritable();
        await writable.write(body);
        await writable.close();
        wrote = true;
        /* Re-checked here, after the awaits, not assumed (see docIdAtSave).
           If another document took over, the copy is still written — the
           user asked for it — but it stays just a file on disk. */
        var stillOurs = state.docId === docIdAtSave;
        var homeAtWrite = docFileHandle.handle === targetHandle ? docFileHandle : null;
        if (stillOurs) baseState = published;
        if (retarget && docFileHandle === retarget) rememberLastFileHandle(targetHandle);
        adoptSavedCopyDocId(forkDocId, docIdAtSave);
        var docIdAfterSave = state.docId;
        try {
          var afterFile = await targetHandle.getFile();
          if (homeAtWrite && docFileHandle === homeAtWrite) homeAtWrite.lastModified = afterFile.lastModified;
        } catch (e) { /* not fatal — the write already succeeded */ }
        if (stillOurs && state.docId === docIdAfterSave && editSeq === seqAtSave) clearDirty();
        showToast((saveAs ? "Saved a new copy: " : "Saved to ") + targetHandle.name, "ok");
      } else {
        /* no File System Access API (e.g. Firefox) — a plain download is the
           best this browser can do; the user re-opens the newest copy next
           time. Same bytes, same extension as the in-place write above. */
        var ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
        if (ok) {
          wrote = true;
          var downloadedOurs = state.docId === docIdAtSave;
          if (downloadedOurs) baseState = published;
          adoptSavedCopyDocId(forkDocId, docIdAtSave);
          if (downloadedOurs && editSeq === seqAtSave) clearDirty();
        } else {
          state.rev = Math.max(0, (state.rev || 1) - 1);
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        state.rev = Math.max(0, (state.rev || 1) - 1);
      } else {
        showToast("Could not save — " + (err && err.message ? err.message : "please try again") + ".", "error");
        state.rev = Math.max(0, (state.rev || 1) - 1);
      }
    } finally {
      /* any failure after a fresh pick: a createWritable/write/close that
         rejects (a OneDrive lock, Controlled Folder Access, a failed IPC
         write). Undone before setSaveButtons syncs identity. */
      undoRetarget();
      saveInFlight = false;
      setSaveButtons(dirty ? "Save •" : "Save", false);
    }
  }

  /* The one place a Save As fork becomes this document's identity (DOCID-API).
     Called only after the bytes are safely written, and before clearDirty(),
     so a cancelled dialog or a failed write never leaves history copied under
     an id no file carries. The copy just written IS the document on screen
     from now on — plain Save writes to it — so the view follows it to the
     new id and takes its history along.

     A server document is the exception: Save As there takes a copy home
     while the page stays on the server document (saveDoc's comment above),
     so the page keeps the server's id; only the file carries the fork.

     Marks the id as written out and re-syncs identity, fork or not, because
     every successful save or download means this id is now on disk
     somewhere.

     `docIdAtSave` is the id the saved document had when saveDoc froze it.
     If the page has moved on to a different document during the save's
     awaits, that document is left exactly as it is: re-iding it would give
     it an id its own file does not carry, and copy ITS history under the
     id of someone else's new file. The fork's history still comes from
     docIdAtSave — the file just written carries it, whatever is on screen. */
  function adoptSavedCopyDocId(forkDocId, docIdAtSave) {
    forkDocId = normalizeDocId(forkDocId);
    var sameDocument = !!state && state.docId === docIdAtSave;
    if (forkDocId) {
      if (sameDocument && !onServerDoc()) state.docId = forkDocId;
      copyDocHistorySafe(docIdAtSave, forkDocId);
    }
    if (!sameDocument) return;
    docIdWrittenOut = true;
    syncDocIdentity();
  }

  /* Runs on load: if a stash survived, three-way merge it into whatever
     version we just loaded so no local edit is lost.

     `override` is the same {base, mine} shape read from somewhere other than
     sessionStorage — today, a crash draft taken back from disk (20g-drafts.js).
     Everything that belongs to the sessionStorage stash is then skipped: the
     reload guard was never set, SERVER_RESUME_KEY says nothing about a draft
     (a draft of a server document has its own path through resumeServerDoc),
     there is nothing to clear, and the caller has already aligned the two ids
     itself under rules a stash does not have (the docIdEmbedded rule,
     DRAFT-RENDERER-API). The merge below is deliberately identical for both:
     one three-way merge, one "Before merging" snapshot, one undo point. */
  function applyStashedWork(loaded, override) {
    var stash = override || readStash();
    if (!override) { try { sessionStorage.removeItem(RELOAD_GUARD_KEY); } catch (e) {} }
    if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) return { state: loaded, report: null, snapshot: null };
    /* A stash left by a lapsed hosted session belongs to a document on the
       server, not to the page's own embedded one. Merging it into `loaded`
       here would splice someone's script into a blank default document —
       leave it for resumeServerDoc(), which knows which document it is. */
    if (!override) {
      try {
        if (sessionStorage.getItem(SERVER_RESUME_KEY)) return { state: loaded, report: null, snapshot: null };
      } catch (e) {}

      /* The stash is this same document from before the reload, so it keeps
         its id. Without this copy the equality check just below could never
         hold — `loaded` carries a fresh random id from migrateRows — and an
         unchanged stash would always snapshot, merge, mark the document dirty
         and queue a save for nothing. */
      var stashId = normalizeDocId(stash.mine.docId);
      if (stashId) { loaded.docId = stashId; docIdWrittenOut = true; }

      clearStash();
    }
    /* nothing changed under us after all */
    if (JSON.stringify(stash.mine) === JSON.stringify(loaded)) return { state: loaded, report: null, snapshot: null };

    /* The capture is synchronous and hands back its ticket, so the undo
       point is known at once — no reading the store before and after to
       guess which entry is new. Boot never awaits snap.done (state is still
       null while this runs); undoMerge waits for its own backup instead. The
       explicit state means the pristine-seed skip can never drop it. */
    var snap = pushSnapshot("Before merging your unsaved changes", migrateRows(cloneState(loaded)));
    lastMergeUndo = snap ? { id: snap.id, docId: snap.docId } : null;

    var result = mergeStates(
      stash.base ? migrateRows(cloneState(stash.base)) : null,
      migrateRows(cloneState(stash.mine)),
      loaded,
      !!stash.imagesStripped
    );
    return { state: result.merged, report: result, snapshot: snap };
  }

  /* serialize auto-saves triggered by comment/tag actions so two quick actions
     (e.g. posting a comment right after resolving another) never overlap */
  var saveInFlight = false;
  var saveQueued = false;
  function queueAutoSave() {
    /* No file established yet — writing now would mean popping the native
       Save dialog out of nowhere, or silently downloading a fresh copy, on
       every comment. Wait for an explicit Save; the dirty indicator and the
       unload guard cover the user in the meantime. Once a file handle
       exists (from a manual Save), later actions save into it silently. */
    /* A hosted document always has somewhere to save to, so autosave is live
       from the first edit — there is no file dialog to ambush anyone with.
       A lapsed sign-in stops it, or every queued save would refire the same
       failure until the tab is reloaded. */
    if (!docFileHandle.handle && !onServerDoc()) return;
    /* A legacy .html project's next save opens a picker (see saveDoc) —
       exactly the ambush the gate above exists to prevent. */
    if (docFileHandle.kind === "html") return;
    if (serverSessionExpired) return;
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;
    /* The catch matters more than it looks: without it, one rejected save
       leaves saveInFlight stuck true and every later auto-save is silently
       dropped for the rest of the session. */
    Promise.resolve()
      .then(function () { return saveDoc(); })
      .catch(function () {})
      .then(function () {
        saveInFlight = false;
        if (saveQueued) { saveQueued = false; queueAutoSave(); }
      });
  }

  function slugify(s) {
    return String(s || "splitpage")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "splitpage";
  }

  /* A bare "|" inside a cell ends the column early and shears the rest of the
     row into the wrong headings. Notes are free text now, so this is a real
     possibility rather than a theoretical one; newlines get folded for the
     same reason. */
  function mdCell(value) {
    return String(value == null ? "" : value)
      .replace(/\|/g, "\\|")
      .replace(/\r\n|\r|\n/g, " ");
  }

  /* Shared by both Markdown shapes below: the breakdown and comments always
     follow the script, however the scenes themselves were laid out. */
  function appendMarkdownTail(lines) {
    var breakdown = breakdownRows();
    if (breakdown.length) {
      lines.push("## Production breakdown");
      lines.push("");
      lines.push("| Category | Item | Status | Assigned to | Mentions | Scenes | Notes |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- |");
      breakdown.forEach(function (r) {
        lines.push("| " + [r.categoryLabel, r.name, r.statusLabel, r.owner, r.mentions,
                           r.scenes.join(", "), r.notes].map(mdCell).join(" | ") + " |");
      });
      lines.push("");
    }

    var comments = commentEntries();
    if (comments.length) {
      lines.push("## Comments");
      lines.push("");
      comments.forEach(function (c) {
        lines.push("**" + c.location + "**" + (c.resolved ? " _(resolved)_" : "") +
                   " — " + c.author + (c.when ? " · " + c.when : ""));
        lines.push("");
        if (c.quoted) {
          lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
          lines.push("");
        }
        lines.push((c.body || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
        c.replies.forEach(function (rp) {
          lines.push("");
          lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                     (rp.body || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
        });
        lines.push("");
        lines.push("---");
        lines.push("");
      });
    }
  }

  function toMarkdownDoc() {
    var lines = [];
    lines.push("# " + (state.title || "Untitled Script"));
    lines.push("");
    if (!state.rows.length) {
      lines.push("_No rows yet._");
    }
    state.rows.forEach(function (row, i) {
      lines.push("## Scene " + pad2(i + 1));
      lines.push("");
      lines.push("**Visual**");
      lines.push("");
      if (row.visualImage) {
        lines.push("![visual for scene " + pad2(i + 1) + "](" + row.visualImage + ")");
        lines.push("");
      }
      var vmd = htmlToMarkdown(row.visualText);
      lines.push(vmd ? vmd : "_(no visual notes)_");
      lines.push("");
      lines.push("**Audio**");
      lines.push("");
      var amd = htmlToMarkdown(row.audioText);
      lines.push(amd ? amd : "_(no dialogue)_");
      lines.push("");
      lines.push("---");
      lines.push("");
    });
    appendMarkdownTail(lines);
    return lines.join("\n");
  }

  /* A table-shaped Markdown cell can't hold a literal newline or an
     unescaped pipe without breaking the row, so line breaks become <br> (the
     one bit of raw HTML every Markdown table renderer still honors inside a
     cell) and pipes are backslash-escaped rather than flattened to a space —
     unlike mdCell, which is only ever fed plain single-line breakdown data. */
  function mdRichTableCell(md) {
    return String(md || "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  }

  /* What a scene's two table cells say, as one description used twice: to
     write the table below, and — on the way back in — to decide whether a
     cell was edited outside Splitpage (`reconcileMarkdownRows`,
     20d-formats.js). Two copies of this composition would drift, and the
     drift would read as "every cell was edited" on the next open.

     Newlines are folded to <br> here because that is part of what the cell
     *says*; the pipe-escaping mdRichTableCell adds is a property of the
     table *row* and is undone again by parseMarkdownTable, so it is
     deliberately not part of this comparison basis. */
  function mdSceneCellSource(row, i) {
    var visual = htmlToMarkdown(row.visualText);
    if (row.visualImage) {
      visual = "![visual for scene " + pad2(i + 1) + "](" + row.visualImage + ")" + (visual ? "<br>" + visual : "");
    }
    return {
      visual: String(visual).replace(/\r\n|\r|\n/g, "<br>").trim(),
      audio: String(htmlToMarkdown(row.audioText)).replace(/\r\n|\r|\n/g, "<br>").trim()
    };
  }

  /* The same script as toMarkdownDoc, laid out as a Visual/Audio table
     instead of a stacked Scene-by-scene list — this is also exactly the
     table shape Import ▸ Two columns already knows how to read back in, so
     round-tripping through this export doesn't lose the split, and it is the
     human-readable half of a saved .splitpage-in-Markdown project
     (buildMarkdownProject, 20d-formats.js). */
  function toMarkdownTableDoc(s) {
    s = s || state;
    var lines = [];
    lines.push("# " + (s.title || "Untitled Script"));
    lines.push("");
    if (!s.rows.length) {
      lines.push("_No rows yet._");
    } else {
      lines.push("| # | Visual | Audio | Status |");
      lines.push("| --- | --- | --- | --- |");
      s.rows.forEach(function (row, i) {
        var cell = mdSceneCellSource(row, i);
        lines.push("| " + pad2(i + 1) + " | " + mdRichTableCell(cell.visual) + " | " +
                   mdRichTableCell(cell.audio) + " | " + (row.status || "todo") + " |");
      });
    }
    lines.push("");
    appendMarkdownTail(lines);
    return lines.join("\n");
  }

  /* ================= binary helpers ================= */

  function strBytes(s) { return new TextEncoder().encode(s); }

  /* latin1 bytes — for PDF, where the file is a byte stream, not UTF-8 text */
  function latin1Bytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function concatBytes(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
    return out;
  }

  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
  function u32(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }

  /* ================= zip (store-only writer, full reader) ================= */

  /* We write uncompressed ("stored") entries — a completely valid zip that Word,
     Pages and every unzip tool accept — which avoids needing a deflate encoder. */
  function zipWrite(entries) {
    var now = new Date();
    var dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
    var dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);

    var local = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var nameB = strBytes(e.name);
      var crc = crc32(e.data);
      var lh = concatBytes([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), nameB
      ]);
      local.push(lh, e.data);
      central.push(concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(e.data.length), u32(e.data.length),
        u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB
      ]));
      offset += lh.length + e.data.length;
    });

    var cd = concatBytes(central);
    var eocd = concatBytes([
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cd.length), u32(offset), u16(0)
    ]);
    return concatBytes([concatBytes(local), cd, eocd]);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("no-decompression-stream");
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function zipRead(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);

    /* find the end-of-central-directory record, scanning back over any comment */
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("not-a-zip");

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    var files = {};
    var p = cdOffset;

    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var raw = bytes.subarray(dataStart, dataStart + compSize);
      files[name] = { method: method, raw: raw };
      p += 46 + nameLen + extraLen + commentLen;
    }

    return {
      async get(name) {
        var f = files[name];
        if (!f) return null;
        return f.method === 0 ? f.raw : await inflateRaw(f.raw);
      },
      names: Object.keys(files)
    };
  }

  /* ================= plain text from rich html ================= */

  function htmlToPlainText(html) {
    if (!html) return "";
    var c = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
    return (c.textContent || "").replace(/ /g, " ").trim();
  }

  function xmlEscape(s) {
    return String(s == null ? "" : s)
      /* C0 controls (except tab/LF/CR) are illegal in XML 1.0 */
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  /* Walk rich HTML into a flat list of styled runs:
     [{text, b, i, u, s, mark, href}] with text "\n" marking a line break. */
  function htmlToRuns(html) {
    var container = inertBody(html);
    var runs = [];
    (function walk(node, fmt) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) {
          var t = (child.nodeValue || "").replace(/ /g, " ");
          if (t) runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href });
          return;
        }
        if (child.nodeType !== 1) return;
        var tag = child.tagName;
        if (tag === "BR") { runs.push({ text: "\n" }); return; }
        var next = {
          b: fmt.b || tag === "STRONG" || tag === "B",
          i: fmt.i || tag === "EM" || tag === "I",
          u: fmt.u || tag === "U",
          s: fmt.s || tag === "S" || tag === "STRIKE" || tag === "DEL",
          mark: fmt.mark || tag === "MARK",
          href: tag === "A" ? (child.getAttribute("href") || fmt.href) : fmt.href
        };
        walk(child, next);
      });
    })(container, { b: false, i: false, u: false, s: false, mark: false, href: null });
    return runs;
  }
