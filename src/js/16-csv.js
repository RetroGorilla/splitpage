  /* ================= csv ================= */

  function csvEscape(v) {
    var s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    var lines = [["Scene", "Status", "Est. time", "Visual", "Audio"].join(",")];
    state.rows.forEach(function (row, i) {
      var st = rowStatus(row.status) || ROW_STATUSES[0];
      lines.push([
        csvEscape(pad2(i + 1)),
        csvEscape(st.label),
        csvEscape(formatDuration(rowSeconds(row))),
        csvEscape(htmlToPlainText(row.visualText)),
        csvEscape(htmlToPlainText(row.audioText))
      ].join(","));
    });
    lines.push(["", "", csvEscape(formatDuration(totalSeconds())), "", ""].join(","));

    var comments = commentEntries();
    if (comments.length) {
      lines.push("");
      lines.push(csvEscape("Comments"));
      lines.push(["Location", "Status", "Author", "Date", "Quoted text", "Comment"].join(","));
      comments.forEach(function (c) {
        lines.push([
          csvEscape(c.location),
          csvEscape(c.resolved ? "Resolved" : "Open"),
          csvEscape(c.author),
          csvEscape(c.when),
          csvEscape(c.quoted),
          csvEscape(c.body)
        ].join(","));
        c.replies.forEach(function (rp) {
          lines.push([
            csvEscape(""), csvEscape(""),
            csvEscape("↳ " + rp.author), csvEscape(rp.when),
            csvEscape(""), csvEscape(rp.body)
          ].join(","));
        });
      });
    }
    /* BOM so Excel reads the UTF-8 correctly */
    return "﻿" + lines.join("\r\n");
  }

  function parseCsv(text) {
    var rows = [], row = [], field = "", inQuotes = false;
    var src = String(text || "").replace(/^﻿/, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ",") { row.push(field); field = ""; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
      field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }

  /* true when column 0 is a short scene/shot index rather than real content */
  function looksLikeIndexColumn(table, from) {
    var checked = 0;
    for (var i = from; i < table.length && checked < 8; i++) {
      var cell = (table[i][0] || "").trim();
      if (!cell) continue;
      checked++;
      if (!/^[0-9]{1,4}[a-z]?$/i.test(cell)) return false;
    }
    return checked > 0;
  }

  function csvToRows(text) {
    var table = parseCsv(text);
    if (!table.length) return [];
    /* find the visual/audio columns from a header row if there is one */
    var vi = 0, ai = 1, start = 0;
    var head = table[0].map(function (c) { return c.trim().toLowerCase(); });
    var hv = head.findIndex(function (c) { return /^(visual|video|picture|image|shot|action)s?$/.test(c); });
    var ha = head.findIndex(function (c) { return /^(audio|voice|vo|narration|dialogue|script|line)s?\b/.test(c); });
    var looksLikeHeader = hv !== -1 || ha !== -1 ||
      head.some(function (c) { return /^(scene|shot|no\.?|#|number|index)$/.test(c); });

    if (hv !== -1 && ha !== -1) {
      vi = hv; ai = ha; start = 1;
    } else if (table[0].length >= 3 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
      /* our own export shape: Scene, Visual, Audio */
      vi = 1; ai = 2;
    } else if (table[0].length === 2 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
      /* A plain two-column sheet whose first column is just a scene/shot
         index (e.g. "Scene,Description") has no separate audio column at
         all — falling to the vi=0/ai=1 default below put the bare scene
         NUMBER into Visual and the real content into Audio, backwards on
         both counts. The one real content column reads as Visual (a
         shot/scene description), with Audio left blank. */
      vi = 1; ai = -1;
    } else {
      vi = 0; ai = 1;
    }
    if (looksLikeHeader && start === 0) start = 1;

    var out = [];
    for (var i = start; i < table.length; i++) {
      var r = table[i];
      var v = (r[vi] || "").trim(), a = (r[ai] || "").trim();
      if (!v && !a) continue;
      out.push({
        id: makeId(),
        visualText: escapeHtml(v).replace(/\n/g, "<br>"),
        visualImage: null,
        audioText: escapeHtml(a).replace(/\n/g, "<br>")
      });
    }
    return out;
  }
