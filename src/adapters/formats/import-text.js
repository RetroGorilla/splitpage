import { MD_EXPORT_TAIL_RE, columnIndicesFromHeader, isStackedSectionHeading, markdownExportScript, parseMarkdownTable } from "./markdown-table.ts";

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

var VISUAL_LABEL_RE = /^\s*(visual|video|scene|shot|b-?roll|image|screen)\s*:\s*(.*)$/i;
var AUDIO_LABEL_RE = /^\s*(audio|vo|voiceover|voice-over|narration|dialogue|script)\s*:\s*(.*)$/i;

export function detectTwoColumnFormat(text) {
  if (parseStackedMarkdownExport(text)) return "stacked";
  var norm = markdownExportScript(String(text || "")).replace(/\r\n/g, "\n");
  var lines = norm.split("\n");
  var nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
  if (nonBlank.length < 2) return null;

  var pipeLines = nonBlank.filter(function (l) { return l.indexOf("|") !== -1; });
  if (pipeLines.length >= 2 && pipeLines.length / nonBlank.length > 0.6) return "table";

  var tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
  if (tabLines.length / nonBlank.length > 0.6) return "tab";

  var hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
  var hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
  var firstIsLabel = VISUAL_LABEL_RE.test(nonBlank[0]) || AUDIO_LABEL_RE.test(nonBlank[0]);
  if (hasVisualLabel && hasAudioLabel && firstIsLabel) return "labels";

  return null;
}

var MD_SCENE_HEADING_RE = /^###\s+Scene\s+\d+(\s+·\s+\d+(:\d\d)+)?\s*$/;
var MD_SCENE_META_RE = /^_\d+ scenes? · (est\. )?\S+ running time( · .*)?_$/;
var MD_SCENE_FACTS_RE = /^\*\*[^*]+\*\* · Read \d+(:\d\d)+(, set by hand)?$/;
var MD_MARKER_RE = /<sup>\d+<\/sup>/g;
var MD_VISUAL_LEAD_RE = /^\*Visual —\*\s?/;
var MD_SCENE_MEDIA_RE = /^(!\[visual [^\]]*\]\(images\/[^)]*\)|▶ .*)$/;

function parseStackedMarkdownExport(text) {
  var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  var i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i === lines.length || !/^#\s+\S/.test(lines[i])) return null;
  for (i++; i < lines.length && !MD_SCENE_HEADING_RE.test(lines[i].trim()); i++) {
    if (isStackedSectionHeading(lines, i)) { i++; continue; }
    if (lines[i].trim() && !MD_SCENE_META_RE.test(lines[i].trim())) return null;
  }
  if (i === lines.length) return null;

  var scenes = [], timed = [];
  for (; i < lines.length; i++) {
    if (MD_EXPORT_TAIL_RE.test(lines[i])) break;
    if (MD_SCENE_HEADING_RE.test(lines[i].trim())) {
      scenes.push([]);
      timed.push(lines[i].indexOf("·") !== -1);
    } else if (!(lines[i - 2] === "---" && isStackedSectionHeading(lines, i))) scenes[scenes.length - 1].push(lines[i]);
  }
  return scenes.map(function (sc, n) {
    function cellText(s) {
      s = s.replace(MD_MARKER_RE, "");
      return timed[n] ? s.replace(/ {2}\n/g, "\n") : s;
    }
    var end = sc.length;
    while (end > 0 && !sc[end - 1].trim()) end--;
    if (end > 0 && sc[end - 1].trim() === "---") end--;
    sc = sc.slice(0, end);
    var k = 0;
    while (k < sc.length && !sc[k].trim()) k++;
    if (k < sc.length && MD_SCENE_FACTS_RE.test(sc[k].trim())) k++;
    while (k < sc.length && (!sc[k].trim() || MD_SCENE_MEDIA_RE.test(sc[k].trim()))) k++;
    var visual = [];
    if (k < sc.length && MD_VISUAL_LEAD_RE.test(sc[k])) {
      visual.push(sc[k].replace(MD_VISUAL_LEAD_RE, ""));
      for (k++; k < sc.length && sc[k].trim(); k++) visual.push(sc[k]);
    }
    var audio = sc.slice(k).join("\n").trim();
    return {
      visualText: cellText(visual.join("\n")).trim(),
      audioText: audio === "_(blank scene)_" ? "" : cellText(audio)
    };
  });
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
  text = markdownExportScript(text);
  var detected = detectTwoColumnFormat(text);
  var rows;
  if (detected === "stacked") return parseStackedMarkdownExport(text);
  if (detected === "table") rows = parseMarkdownTable(text);
  else if (detected === "tab") rows = parseTabDelimited(text);
  else if (detected === "labels") rows = parseLabeledLines(text);
  else rows = parseAlternatingLines(text);
  return rows.filter(function (r) { return r.visualText || r.audioText; });
}

export function parseImportRows(text, mode) {
  if (mode === "twocolumn") return parseTwoColumnText(text);
  return splitImportText(text, mode).map(function (c) { return { visualText: "", audioText: c }; });
}

