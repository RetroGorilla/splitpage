  /* ================= import ================= */

  var importModeTouched = false;

  function truncateForPreview(s, n) {
    s = s || "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function splitImportText(text, mode) {
    var norm = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!norm) return [];
    var chunks;
    if (mode === "line") {
      chunks = norm.split(/\n/);
    } else if (mode === "sentence") {
      var flattened = norm.replace(/\n+/g, " ");
      chunks = flattened.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [flattened];
    } else {
      chunks = norm.split(/\n\s*\n+/);
    }
    return chunks.map(function (c) { return c.trim(); }).filter(Boolean);
  }

  /* --- two-column detection & parsing --- */

  var VISUAL_LABEL_RE = /^\s*(visual|video|scene|shot|b-?roll|image|screen)\s*:\s*(.*)$/i;
  var AUDIO_LABEL_RE = /^\s*(audio|vo|voiceover|voice-over|narration|dialogue|script)\s*:\s*(.*)$/i;
  /* Anchored to the WHOLE cell (only a trailing plural allowed), unlike the
     LABEL_REs above which only need to match a line's prefix before ":".
     These are for judging whether rows[0] of a table/tab paste is really a
     header — a bare .test() for "shot" or "scene" anywhere in the string
     also matches ordinary shot-list content like "Wide shot of the ocean",
     misclassifying the first real data row as a header and discarding it. */
  var VISUAL_HEADER_RE = /^(visual|video|scene|shot|b-?roll|image|screen)s?$/i;
  var AUDIO_HEADER_RE = /^(audio|vo|voiceover|voice-over|narration|dialogue|script)s?$/i;

  function detectTwoColumnFormat(text) {
    var norm = String(text || "").replace(/\r\n/g, "\n");
    var lines = norm.split("\n");
    var nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
    if (nonBlank.length < 2) return null;

    /* Requires a majority of lines to carry a pipe, not just two — two
       incidental pipe characters in an otherwise plain paste (a leading
       "|" bullet, a quoted log snippet) used to be enough to classify the
       WHOLE document as a table, and parseMarkdownTable then discards every
       line that isn't itself pipe-delimited. Matching on "contains a pipe"
       rather than "starts with a pipe" too, since that's what
       parseMarkdownTable itself actually reads (line.indexOf("|") === -1). */
    var pipeLines = nonBlank.filter(function (l) { return l.indexOf("|") !== -1; });
    if (pipeLines.length >= 2 && pipeLines.length / nonBlank.length > 0.6) return "table";

    var tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
    if (tabLines.length / nonBlank.length > 0.6) return "tab";

    var hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
    var hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
    /* parseLabeledLines silently drops every line before the first label
       match (current stays null until then), so detecting "labels" from
       one coincidental visual-word line and one unrelated audio-word line
       anywhere in an otherwise plain document used to make Import quietly
       eat everything before whichever came first. Requiring the very first
       line to already look like a label means there is nothing ahead of it
       for the parser to throw away. */
    var firstIsLabel = VISUAL_LABEL_RE.test(nonBlank[0]) || AUDIO_LABEL_RE.test(nonBlank[0]);
    if (hasVisualLabel && hasAudioLabel && firstIsLabel) return "labels";

    return null;
  }

  function columnIndicesFromHeader(header) {
    var visualIdx = header.findIndex(function (c) { return VISUAL_HEADER_RE.test(c.trim()); });
    var audioIdx = header.findIndex(function (c) { return AUDIO_HEADER_RE.test(c.trim()); });
    /* A row can only tell us where ONE of the two columns is (say, a
       header that only names "Audio"); the other index used to fall back
       to its bare default (0), which can collide with the one that WAS
       found and silently point both fields at the same column. Nudge the
       unresolved side to whichever of the first two columns the found one
       isn't sitting on. */
    if (visualIdx !== -1 && audioIdx === -1) audioIdx = visualIdx === 0 ? 1 : 0;
    else if (audioIdx !== -1 && visualIdx === -1) visualIdx = audioIdx === 0 ? 1 : 0;
    return { visualIdx: visualIdx, audioIdx: audioIdx };
  }

  /* A plain split("|") has no idea that markdown lets a cell contain a
     literal pipe as "\|" — it would cut that cell in two and shift every
     following column's content into the next index, silently truncating
     whatever landed past visualIdx/audioIdx. Splits only on an
     unescaped "|", then un-escapes "\|" back to "|" in each cell. */
  function splitTableRowCells(line) {
    var trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
    var cells = [], current = "";
    for (var i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "\\" && trimmed[i + 1] === "|") { current += "|"; i++; continue; }
      if (trimmed[i] === "|") { cells.push(current.trim()); current = ""; continue; }
      current += trimmed[i];
    }
    cells.push(current.trim());
    return cells;
  }

  /* opts.keepEmpty keeps a data row whose Visual and Audio cells are both
     empty. Off by default, because a foreign table's blank line carries no
     information; on when reading one of our OWN Markdown projects
     (20d-formats.js), where a scene with nothing typed in it yet is still a
     scene and dropping it would shift every row after it out of line with
     the file's own record. */
  function parseMarkdownTable(text, opts) {
    opts = opts || {};
    var lines = text.replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var rows = [];
    lines.forEach(function (line) {
      if (line.indexOf("|") === -1) return;
      var cells = splitTableRowCells(line);
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ""; })) return;
      rows.push(cells);
    });
    if (!rows.length) return [];
    var visualIdx = 0, audioIdx = 1, startIdx = 0, statusIdx = -1;
    var header = rows[0].map(function (c) { return c.toLowerCase(); });
    var idxs = columnIndicesFromHeader(header);
    if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
      startIdx = 1;
      if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
      if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
      statusIdx = header.findIndex(function (c) { return c.trim() === "status"; });
    }
    var out = [];
    for (var i = startIdx; i < rows.length; i++) {
      var v = rows[i][visualIdx] || "", a = rows[i][audioIdx] || "";
      if (!v && !a && !opts.keepEmpty) continue;
      out.push({
        visualText: v,
        audioText: a,
        statusText: statusIdx === -1 ? "" : (rows[i][statusIdx] || "")
      });
    }
    return out;
  }

  function parseTabDelimited(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var rows = [];
    lines.forEach(function (line) {
      if (line.trim() === "") return;
      var idx = line.indexOf("\t");
      if (idx === -1) { rows.push([line.trim(), ""]); return; }
      rows.push([line.slice(0, idx).trim(), line.slice(idx + 1).replace(/\t/g, " ").trim()]);
    });
    if (!rows.length) return [];
    var visualIdx = 0, audioIdx = 1, startIdx = 0;
    var header = rows[0].map(function (c) { return c.toLowerCase(); });
    var idxs = columnIndicesFromHeader(header);
    if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
      startIdx = 1;
      if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
      if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
    }
    var out = [];
    for (var i = startIdx; i < rows.length; i++) {
      var v = rows[i][visualIdx] || "", a = rows[i][audioIdx] || "";
      if (v || a) out.push({ visualText: v, audioText: a });
    }
    return out;
  }

  function parseLabeledLines(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var rows = [];
    var current = null, currentField = null;
    lines.forEach(function (line) {
      var vMatch = line.match(VISUAL_LABEL_RE);
      var aMatch = !vMatch && line.match(AUDIO_LABEL_RE);
      if (vMatch) {
        if (current && (current.visualText || current.audioText)) rows.push(current);
        current = { visualText: vMatch[2] || "", audioText: "" };
        currentField = "visualText";
        return;
      }
      if (aMatch) {
        if (!current) current = { visualText: "", audioText: "" };
        current.audioText = (current.audioText ? current.audioText + " " : "") + (aMatch[2] || "");
        currentField = "audioText";
        return;
      }
      if (line.trim() === "" || !current || !currentField) return;
      current[currentField] = (current[currentField] ? current[currentField] + " " : "") + line.trim();
    });
    if (current && (current.visualText || current.audioText)) rows.push(current);
    return rows;
  }

  function parseAlternatingLines(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var out = [];
    for (var i = 0; i < lines.length; i += 2) {
      out.push({ visualText: lines[i] || "", audioText: lines[i + 1] || "" });
    }
    return out;
  }

  function parseTwoColumnText(text) {
    var detected = detectTwoColumnFormat(text);
    var rows;
    if (detected === "table") rows = parseMarkdownTable(text);
    else if (detected === "tab") rows = parseTabDelimited(text);
    else if (detected === "labels") rows = parseLabeledLines(text);
    else rows = parseAlternatingLines(text);
    return rows.filter(function (r) { return r.visualText || r.audioText; });
  }

  function parseImportRows(text, mode) {
    if (mode === "twocolumn") return parseTwoColumnText(text);
    return splitImportText(text, mode).map(function (c) { return { visualText: "", audioText: c }; });
  }

  /* turn raw {visualText, audioText} pairs into real rows */
  function normalizeImportedRows(rows) {
    /* Every other write path into state.rows runs its content through
       sanitizeHtml() before it lands in the document (see migrateRows(),
       06-rows.js, 07-production-tags.js, 09-find-replace.js, 10-comments.js,
       19-writer.js, 21-events.js). This one didn't — legacyMdToHtml() escapes
       plain text but is not a sanitizer, so a pasted line containing a raw
       '<' (a page whose markup was preserved as text, or a deliberately
       crafted paste) went straight into the document as live HTML. */
    return rows.map(function (r) {
      /* An inline image at the head of the Visual cell is how this app's own
         Markdown writes a storyboard frame (toMarkdownTableDoc). This used
         to be hardcoded to null, so a two-column export re-imported lost
         every picture in it — and left the data: URI sitting in the text as
         several thousand characters of visible gibberish, because
         legacyMdToHtml's link rule rejects a data: href. Only a data: image
         this app would itself accept is taken; an ordinary ![](http…) in a
         foreign document still imports exactly as it did before. */
      var visual = String(r.visualText || "");
      var image = null;
      var m = MD_IMAGE_PREFIX_RE.exec(visual);
      if (m) {
        image = safeImageSrc(m[1]);
        if (image) visual = visual.slice(m[0].length);
      }
      return {
        id: makeId(),
        visualText: sanitizeHtml(legacyMdToHtml(visual)),
        visualImage: image,
        audioText: sanitizeHtml(legacyMdToHtml(r.audioText || ""))
      };
    });
  }

  /* --- modal wiring --- */

  function getImportMode() {
    var checked = document.querySelector('input[name="import-split"]:checked');
    return checked ? checked.value : "paragraph";
  }

  function maybeAutoDetectTwoColumn(text) {
    if (importModeTouched) return;
    if (detectTwoColumnFormat(text)) {
      var radio = document.querySelector('input[name="import-split"][value="twocolumn"]');
      if (radio) radio.checked = true;
    }
  }

  function updateImportPreview() {
    var text = document.getElementById("import-textarea").value;
    var mode = getImportMode();
    var rows = parseImportRows(text, mode);
    var el = document.getElementById("import-preview");
    if (!rows.length) {
      el.textContent = "Paste some text to see a preview.";
      return;
    }
    var n = rows.length;
    var label = n + " row" + (n === 1 ? "" : "s");
    if (mode === "twocolumn") {
      var v = truncateForPreview(rows[0].visualText, 34) || "(empty)";
      var a = truncateForPreview(rows[0].audioText, 34) || "(empty)";
      el.textContent = "This will create " + label + " — first row: Visual “" + v + "” / Audio “" + a + "”";
    } else {
      el.textContent = "This will create " + label + " — first: “" + truncateForPreview(rows[0].audioText, 70) + "”";
    }
  }

  function openImportModal() {
    document.getElementById("import-textarea").value = "";
    document.getElementById("import-replace").checked = false;
    importModeTouched = false;
    var paragraphRadio = document.querySelector('input[name="import-split"][value="paragraph"]');
    if (paragraphRadio) paragraphRadio.checked = true;
    updateImportPreview();
    document.getElementById("import-modal").hidden = false;
    document.getElementById("import-textarea").focus();
  }

  function closeImportModal() {
    document.getElementById("import-modal").hidden = true;
  }

  function handleImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || "");
      document.getElementById("import-textarea").value = text;
      maybeAutoDetectTwoColumn(text);
      updateImportPreview();
    };
    reader.onerror = function () {
      showToast("Could not read that file.", "error");
    };
    reader.readAsText(file);
  }

  function confirmImport() {
    var text = document.getElementById("import-textarea").value;
    var mode = getImportMode();
    var rows = parseImportRows(text, mode);
    if (!rows.length) {
      showToast("Paste or choose some text first.", "warn");
      return;
    }
    var replace = document.getElementById("import-replace").checked;
    var newRows = normalizeImportedRows(rows);
    newRows.forEach(stampRow);
    if (replace && state.rows.length) pushSnapshot("Before replacing rows on import");
    state.rows = replace ? newRows : state.rows.concat(newRows);
    markDirty();
    render();
    closeImportModal();
    showToast("Imported " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") + ".", "ok");
  }

  /* ================= Google Doc import =================

     Splitpage has no server and no Google sign-in of its own, so it can't
     fetch a Doc's contents directly — a plain in-page fetch() to
     docs.google.com is blocked by CORS regardless of sharing settings. The
     one thing that does work with no account plumbing at all is a real
     browser navigation: Google's own /export endpoint sends the doc back as
     a .docx with Content-Disposition: attachment, so opening it (carrying
     whatever Google session cookies the browser already has) downloads it
     like any other link — no fetch, no CORS. From there it's just a Word
     file, and the existing .docx importer takes it from there. */

  function extractGoogleDocId(input) {
    var s = (input || "").trim();
    var m = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(s);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s; /* the bare ID, pasted directly */
    return null;
  }

  function openGdocModal() {
    document.getElementById("gdoc-url-input").value = "";
    document.getElementById("gdoc-modal").hidden = false;
    document.getElementById("gdoc-url-input").focus();
  }

  function closeGdocModal() {
    document.getElementById("gdoc-modal").hidden = true;
  }

  function confirmGdocImport() {
    var id = extractGoogleDocId(document.getElementById("gdoc-url-input").value);
    if (!id) { showToast("That doesn't look like a Google Doc link.", "warn"); return; }
    var url = "https://docs.google.com/document/d/" + id + "/export?format=docx";
    /* No OAuth involved either way (see the comment above this function) —
       just a real navigation to Google's own /export endpoint. Electron's
       renderer has no tab strip for window.open(url, "_blank") to open a
       new one in, and no cookie jar shared with a real browser for a
       private doc's sign-in to land in either, so this hands the URL to
       DESKTOP.openExternal() instead: the system's default browser does the
       download, carrying whatever Google session it already has, exactly
       the same trick this always was. */
    if (DESKTOP) {
      DESKTOP.openExternal(url);
      closeGdocModal();
      showToast("Opening the Doc as a .docx download in your browser — once it's in your Downloads " +
        "folder, use File ▸ Open a document… to bring it in.", "ok", true);
      return;
    }
    /* target=_blank rather than a same-tab anchor: a private/unshared doc
       sends back a Google sign-in page instead of a file, which would
       otherwise navigate this tab away from the script mid-edit. Sever
       .opener by hand rather than passing "noopener" to window.open — that
       feature makes window.open always return null, even on success, which
       is also the only way to detect a blocked popup. */
    var win = window.open(url, "_blank");
    if (!win) { showToast("Your browser blocked the download — allow popups for this page and try again.", "warn"); return; }
    win.opener = null;
    closeGdocModal();
    showToast("Downloading the Doc as .docx in a new tab — once it's in your Downloads folder, use File ▸ Open a document… to bring it in.", "ok", true);
  }
