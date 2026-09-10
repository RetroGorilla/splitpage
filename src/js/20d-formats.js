  /* ================= document file formats =================

     Two formats, one document. Both are plain text, neither carries a copy
     of the app, and both go through migrateRows() on the way in like
     everything else from outside this page (invariant #2).

       .splitpage   the state object itself, pretty-printed. No envelope and
                    no translation: what the server stores, what #state-data
                    holds at boot, and what this file contains are the same
                    object (invariant #31).

       .md          a Markdown table a human (or Obsidian, or GitHub) can
                    read, followed by that same JSON in a fenced block. The
                    table is what you edit elsewhere; the block is what the
                    table cannot say — tags, comment anchors, images, ids,
                    statuses, people, reading speed (invariant #32).

     The old .html "save the whole app with the script inside it" format is
     still READ here (openProjectFile, 18-local-files.js) and can still be
     written by Export ▸ Standalone HTML, but Save never produces it. */

  /* ---- the native format ---- */

  function buildSplitpageFile(s) {
    return JSON.stringify(migrateRows(cloneState(s || state)), null, 2);
  }

  /* Throws on anything that isn't one of ours; the caller decides what to
     say about it. Deliberately does NOT migrate — every entry point wants
     to do that itself, at the one moment it is actually adopting the
     document, so there is never a half-trusted object in flight. */
  function parseSplitpageFile(text) {
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
      throw new Error("not-a-splitpage-file");
    }
    return parsed;
  }

  /* ---- the Markdown project ---- */

  var MD_DATA_INFO = "splitpage";
  var MD_DATA_NOTE = "<!-- splitpage: everything below is Splitpage's own record of this " +
    "script. Edit the text above freely; leave this block alone. -->";

  /* CommonMark closes a tilde fence on the first line of at least as many
     tildes as opened it, so a fence is only safe if it is longer than any
     run of tildes the content contains. Four is the floor (JSON of
     sanitised HTML has no tildes at all in the ordinary case); a script
     with "~~~~~" typed into it gets a longer one rather than a data block
     that ends in the middle of somebody's dialogue. */
  function splitpageDataFence(json) {
    var longest = 3, re = /~{3,}/g, m;
    while ((m = re.exec(json)) !== null) {
      if (m[0].length > longest) longest = m[0].length;
    }
    return new Array(Math.max(4, longest + 1) + 1).join("~");
  }

  function buildMarkdownProject(s) {
    s = s || state;
    var json = buildSplitpageFile(s);
    var fence = splitpageDataFence(json);
    return toMarkdownTableDoc(s) + "\n" + MD_DATA_NOTE + "\n" +
      fence + MD_DATA_INFO + "\n" + json + "\n" + fence + "\n";
  }

  /* The LAST opening fence wins: a script that quotes this very block as an
     example earlier in its prose must not be able to shadow the real one.
     An opener can never occur inside the block itself — JSON.stringify
     escapes every newline, so every line of the JSON begins with the
     pretty-printer's indent, never with a tilde. */
  function findMarkdownDataBlock(text) {
    var lines = String(text || "").replace(/\r\n|\r/g, "\n").split("\n");
    var openAt = -1, fenceLen = 0, i;
    for (i = 0; i < lines.length; i++) {
      var m = /^(~{3,})\s*splitpage\s*$/.exec(lines[i]);
      if (m) { openAt = i; fenceLen = m[1].length; }
    }
    if (openAt === -1) return null;
    var closeRe = new RegExp("^~{" + fenceLen + ",}\\s*$");
    var closeAt = -1;
    for (i = openAt + 1; i < lines.length; i++) {
      if (closeRe.test(lines[i])) { closeAt = i; break; }
    }
    return {
      json: lines.slice(openAt + 1, closeAt === -1 ? lines.length : closeAt).join("\n"),
      before: lines.slice(0, openAt).join("\n")
    };
  }

  /* Returns null for Markdown that is not one of ours — a script someone
     wrote in a text editor, an export from something else — so the caller
     falls through to the ordinary lossy import, unchanged. A block that is
     present but unreadable reads the same way: the table is still there and
     still worth importing, and refusing the file outright would help nobody. */
  function parseMarkdownProject(text) {
    var block = findMarkdownDataBlock(text);
    if (!block) return null;
    var parsed;
    try { parsed = parseSplitpageFile(block.json); } catch (e) { return null; }

    /* Only the scene table. The breakdown and the comments appendix are
       pipe tables too, and parseMarkdownTable reads every pipe line it is
       given — they sit under "## " headings, and the scene table is
       everything before the first one. */
    var sceneSection = block.before.split(/^##\s/m)[0];
    var heading = /^#\s+(.+)$/m.exec(block.before);
    return {
      state: migrateRows(parsed),
      /* keepEmpty: a scene with nothing typed in it yet is still a row of
         the table, and dropping it here would misread every later row as
         shifted and pop the "scenes were added or removed" question on
         every open of a document with one blank scene in it. */
      table: parseMarkdownTable(sceneSection, { keepEmpty: true }),
      title: heading ? heading[1].trim() : null
    };
  }

  /* ---- reconciling hand edits made outside Splitpage ---- */

  var MD_IMAGE_PREFIX_RE = /^!\[[^\]]*\]\((data:image\/[^)\s]+)\)\s*(?:<br\s*\/?>)?\s*/i;

  /* A cell that was edited elsewhere is plain Markdown again: it has lost
     its tag spans and its comment anchors, because neither survives
     htmlToMarkdown(). Rebuild the rich text, then re-wrap every name the
     breakdown still tracks — a tag survives a wording tweak that way, which
     is the whole point of keeping the registry as real storage (§3.4).
     Comment anchors on the cell are gone for good; the comments themselves
     keep their quotedText and show as not-in-script in the panel. */
  function markdownCellToHtml(s, md) {
    /* contenteditable sprays non-breaking spaces into anything typed at the
       end of a line, and they travel out into the Markdown as-is. A tag name
       in the registry has ordinary spaces in it, so leaving them would mean
       "gaffer tape" quietly failing to re-attach to text that looks
       identical. Nothing downstream wants a nbsp in rebuilt prose either. */
    var html = sanitizeHtml(legacyMdToHtml(String(md == null ? "" : md).replace(/ /g, " ")));
    var names = (s.productionTags || []).slice().sort(function (a, b) {
      return String(b.name || "").length - String(a.name || "").length;
    });
    names.forEach(function (t) {
      var name = String(t.name || "").trim();
      if (!name) return;
      var res = tagFieldOccurrences(html, name, t.cat, name, false);
      if (res.hits) html = res.html;
    });
    return sanitizeHtml(html);
  }

  /* The Visual cell can carry an inline image ahead of its text — today's
     foreign import throws that away, but in one of our own files it is the
     picture the scene was storyboarded with. */
  function applyMarkdownVisualCell(s, row, md) {
    var text = String(md == null ? "" : md);
    var m = MD_IMAGE_PREFIX_RE.exec(text);
    row.visualImage = m ? (safeImageSrc(m[1]) || null) : null;
    if (m) text = text.slice(m[0].length);
    row.visualText = markdownCellToHtml(s, text);
  }

  function markdownCellChanged(cellText, was) {
    return String(cellText == null ? "" : cellText).trim() !== was;
  }

  /* Same row count on both sides: the block is authoritative except where
     the table disagrees, cell by cell. An untouched cell keeps the block's
     HTML exactly — tags, anchors, links, formatting — because rebuilding it
     from the table would be a lossy no-op. */
  function reconcileMarkdownRows(s, table) {
    var changed = 0;
    s.rows.forEach(function (row, i) {
      var cells = table[i];
      if (!cells) return;
      var was = mdSceneCellSource(row, i);
      if (markdownCellChanged(cells.visualText, was.visual)) {
        applyMarkdownVisualCell(s, row, cells.visualText);
        changed++;
      }
      if (markdownCellChanged(cells.audioText, was.audio)) {
        row.audioText = markdownCellToHtml(s, cells.audioText);
        changed++;
      }
    });
    return changed;
  }

  /* "Use the table's text": the table decides how many scenes there are and
     what they say; everything the table cannot say is kept by position —
     ids (so comments stay attached), statuses, images, timestamps. */
  function rowsFromMarkdownTable(s, table) {
    return table.map(function (cells, i) {
      var old = s.rows[i] || null;
      var row = old || { id: makeId(), status: "todo", visualImage: null, updatedAt: "", updatedBy: null };
      var was = old ? mdSceneCellSource(old, i) : { visual: "", audio: "" };
      if (!old || markdownCellChanged(cells.visualText, was.visual)) {
        applyMarkdownVisualCell(s, row, cells.visualText);
      }
      if (!old || markdownCellChanged(cells.audioText, was.audio)) {
        row.audioText = markdownCellToHtml(s, cells.audioText);
      }
      return row;
    });
  }

  /* ---- "the scenes don't line up" question ---- */

  var pendingMdRowChoice = null;

  function askMarkdownRowChoice(blockRows, tableRows) {
    return new Promise(function (resolve) {
      var modal = document.getElementById("md-rows-modal");
      if (!modal) { resolve("keep"); return; }
      document.getElementById("md-rows-detail").textContent =
        "This file's own record has " + blockRows + " scene" + (blockRows === 1 ? "" : "s") +
        ", but the table in it now has " + tableRows + ". Scenes were added or removed " +
        "somewhere other than Splitpage, so the two can no longer be lined up scene by scene.";
      pendingMdRowChoice = resolve;
      modal.hidden = false;
    });
  }

  /* Never resolved twice: whichever of the two buttons (or Esc, which means
     "keep", the choice that changes nothing) gets here first takes the
     resolver with it. */
  function finishMarkdownRowChoice(choice) {
    var modal = document.getElementById("md-rows-modal");
    if (modal) modal.hidden = true;
    var resolve = pendingMdRowChoice;
    pendingMdRowChoice = null;
    if (resolve) resolve(choice === "table" ? "table" : "keep");
  }

  /* Turn a parsed project into the state to adopt. Async only because the
     row-count question is a real modal — no silent choice. */
  async function applyMarkdownProject(proj) {
    var s = proj.state;
    if (proj.title && proj.title !== s.title) s.title = plainText(proj.title).slice(0, 300);

    if (proj.table.length === s.rows.length) {
      reconcileMarkdownRows(s, proj.table);
    } else {
      var choice = await askMarkdownRowChoice(s.rows.length, proj.table.length);
      if (choice === "table") s.rows = rowsFromMarkdownTable(s, proj.table);
    }
    /* Everything that enters `state` goes through the one door, including
       what we just rebuilt out of a text file (invariant #2). */
    return migrateRows(s);
  }

  /* ---- test hook ----
     Neither file picker can run headless, so the regression suite
     (17-formats.txt) drives the serializers and the open path directly.
     Nothing in the app reads this; it is the same trick 03-exports.txt
     plays on URL.createObjectURL, one level up. */
  window.__splitpageFormats = {
    buildSplitpage: buildSplitpageFile,
    parseSplitpage: parseSplitpageFile,
    buildMarkdown: buildMarkdownProject,
    parseMarkdown: parseMarkdownProject,
    buildStandaloneHtml: function () { return buildPublishHtml(JSON.stringify(cloneState(state))); },
    openFile: function (file) { return openProjectFile(file, null, { skipSnapshot: true }); },
    migrate: migrateRows,
    clone: cloneState,
    state: function () { return state; },
    docFile: function () { return { name: docFileHandle.handle ? docFileHandle.handle.name : null, kind: docFileHandle.kind }; }
  };
