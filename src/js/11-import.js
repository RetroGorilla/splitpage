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
  var VISUAL_WORD_RE = /visual|video|scene|shot|b-?roll|image|screen/i;
  var AUDIO_WORD_RE = /audio|\bvo\b|voiceover|narration|dialogue/i;

  function detectTwoColumnFormat(text) {
    var norm = String(text || "").replace(/\r\n/g, "\n");
    var lines = norm.split("\n");
    var nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
    if (nonBlank.length < 2) return null;

    var pipeLines = nonBlank.filter(function (l) { return /^\s*\|/.test(l); });
    if (pipeLines.length >= 2) return "table";

    var tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
    if (tabLines.length / nonBlank.length > 0.6) return "tab";

    var hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
    var hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
    if (hasVisualLabel && hasAudioLabel) return "labels";

    return null;
  }

  function columnIndicesFromHeader(header) {
    var visualIdx = header.findIndex(function (c) { return VISUAL_WORD_RE.test(c); });
    var audioIdx = header.findIndex(function (c) { return AUDIO_WORD_RE.test(c); });
    return { visualIdx: visualIdx, audioIdx: audioIdx };
  }

  function parseMarkdownTable(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var rows = [];
    lines.forEach(function (line) {
      if (line.indexOf("|") === -1) return;
      var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ""; })) return;
      rows.push(cells);
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
    return rows.map(function (r) {
      return {
        id: makeId(),
        visualText: legacyMdToHtml(r.visualText || ""),
        visualImage: null,
        audioText: legacyMdToHtml(r.audioText || "")
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

