type ParsedImportTextRow = ReturnType<typeof parseAlternatingLines>[number];
import { MD_EXPORT_TAIL_RE, columnIndicesFromHeader, isStackedSectionHeading, markdownExportScript, parseMarkdownTable } from "./markdown-table.ts";

function splitImportText(text: string, mode: string) {
  const norm = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!norm) return [];
  let chunks;
  if (mode === "line") {
    chunks = norm.split(/\n/);
  } else if (mode === "sentence") {
    const flattened = norm.replace(/\n+/g, " ");
    chunks = flattened.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [flattened];
  } else {
    chunks = norm.split(/\n\s*\n+/);
  }
  return chunks.map(function (c) { return c.trim(); }).filter(Boolean);
}

const VISUAL_LABEL_RE = /^\s*(visual|video|scene|shot|b-?roll|image|screen)\s*:\s*(.*)$/i;
const AUDIO_LABEL_RE = /^\s*(audio|vo|voiceover|voice-over|narration|dialogue|script)\s*:\s*(.*)$/i;

export function detectTwoColumnFormat(text: string) {
  if (parseStackedMarkdownExport(text)) return "stacked";
  const norm = markdownExportScript(String(text || "")).replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  const nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
  if (nonBlank.length < 2) return null;

  const pipeLines = nonBlank.filter(function (l) { return l.indexOf("|") !== -1; });
  const ownTable = nonBlank.some(line => /^\|\s*#\s*\|\s*(?:Start\s*\|\s*Status\s*\|\s*)?Visual\s*\|\s*Audio\s*\|/i.test(line));
  if (ownTable || pipeLines.length >= 2 && pipeLines.length / nonBlank.length > 0.6) return "table";

  const tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
  if (tabLines.length / nonBlank.length > 0.6) return "tab";

  const hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
  const hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
  const firstIsLabel = VISUAL_LABEL_RE.test((nonBlank[0] as string)) || AUDIO_LABEL_RE.test((nonBlank[0] as string));
  if (hasVisualLabel && hasAudioLabel && firstIsLabel) return "labels";

  return null;
}

const MD_BEAT_HEADING_RE = /^###\s+(?:Scene|Beat)\s+(?:[A-Z]+\.)?\d+(\s+·\s+\d+(:\d\d)+)?\s*$/;
const MD_BEAT_META_RE = /^_\d+ (?:scenes?|beats?) · (est\. )?\S+ running time( · .*)?_$/;
const MD_BEAT_FACTS_RE = /^\*\*[^*]+\*\* · Read \d+(:\d\d)+(, set by hand)?$/;
const MD_MARKER_RE = /<sup>\d+<\/sup>/g;
const MD_VISUAL_LEAD_RE = /^\*Visual —\*\s?/;
const MD_BEAT_MEDIA_RE = /^(!\[visual [^\]]*\]\(images\/[^)]*\)|▶ .*)$/;

function parseStackedMarkdownExport(text: string) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !(lines[i] as string).trim()) i++;
  if (i === lines.length || !/^#\s+\S/.test((lines[i] as string))) return null;
  for (i++; i < lines.length && !MD_BEAT_HEADING_RE.test((lines[i] as string).trim()); i++) {
    if (isStackedSectionHeading(lines, i)) { i++; continue; }
    if ((lines[i] as string).trim() && !MD_BEAT_META_RE.test((lines[i] as string).trim())) return null;
  }
  if (i === lines.length) return null;

  const beats: string[][] = [], timed: boolean[] = [];
  for (; i < lines.length; i++) {
    if (MD_EXPORT_TAIL_RE.test((lines[i] as string))) break;
    if (MD_BEAT_HEADING_RE.test((lines[i] as string).trim())) {
      beats.push([]);
      timed.push((lines[i] as string).indexOf("·") !== -1);
    } else if (!(lines[i - 2] === "---" && isStackedSectionHeading(lines, i))) (beats[beats.length - 1] as string[]).push((lines[i] as string));
  }
  return beats.map(function (sc, n) {
    function cellText(s: string) {
      s = s.replace(MD_MARKER_RE, "");
      return timed[n] ? s.replace(/ {2}\n/g, "\n") : s;
    }
    let end = sc.length;
    while (end > 0 && !(sc[end - 1] as string).trim()) end--;
    if (end > 0 && (sc[end - 1] as string).trim() === "---") end--;
    sc = sc.slice(0, end);
    let k = 0;
    while (k < sc.length && !(sc[k] as string).trim()) k++;
    if (k < sc.length && MD_BEAT_FACTS_RE.test((sc[k] as string).trim())) k++;
    while (k < sc.length && (!(sc[k] as string).trim() || MD_BEAT_MEDIA_RE.test((sc[k] as string).trim()))) k++;
    const visual = [];
    if (k < sc.length && MD_VISUAL_LEAD_RE.test((sc[k] as string))) {
      visual.push((sc[k] as string).replace(MD_VISUAL_LEAD_RE, ""));
      for (k++; k < sc.length && (sc[k] as string).trim(); k++) visual.push((sc[k] as string));
    }
    const audio = sc.slice(k).join("\n").trim();
    return {
      visualText: cellText(visual.join("\n")).trim(),
      audioText: /^(?:_\(blank scene\)_|_\(blank beat\)_)$/.test(audio) ? "" : cellText(audio)
    };
  });
}

function parseTabDelimited(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rows: string[][] = [];
  lines.forEach(function (line) {
    if (line.trim() === "") return;
    const idx = line.indexOf("\t");
    if (idx === -1) { rows.push([line.trim(), ""]); return; }
    rows.push([line.slice(0, idx).trim(), line.slice(idx + 1).replace(/\t/g, " ").trim()]);
  });
  if (!rows.length) return [];
  let visualIdx = 0, audioIdx = 1, startIdx = 0;
  const header = (rows[0] as string[]).map(function (c) { return c.toLowerCase(); });
  const idxs = columnIndicesFromHeader(header);
  if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
    startIdx = 1;
    if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
    if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
  }
  const out = [];
  for (let i = startIdx; i < rows.length; i++) {
    const v = (rows[i] as string[])[visualIdx] || "", a = (rows[i] as string[])[audioIdx] || "";
    if (v || a) out.push({ visualText: v, audioText: a });
  }
  return out;
}

function parseLabeledLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rows: ParsedImportTextRow[] = [];
  let current: ParsedImportTextRow | null = null, currentField: "visualText" | "audioText" | null = null;
  lines.forEach(function (line) {
    const vMatch = line.match(VISUAL_LABEL_RE);
    const aMatch = !vMatch && line.match(AUDIO_LABEL_RE);
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
  if (current && ((current as ParsedImportTextRow).visualText || (current as ParsedImportTextRow).audioText)) rows.push(current);
  return rows;
}

function parseAlternatingLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push({ visualText: lines[i] || "", audioText: lines[i + 1] || "" });
  }
  return out;
}

function parseTwoColumnText(text: string) {
  text = markdownExportScript(text);
  const detected = detectTwoColumnFormat(text);
  let rows;
  if (detected === "stacked") return parseStackedMarkdownExport(text);
  if (detected === "table") rows = parseMarkdownTable(text);
  else if (detected === "tab") rows = parseTabDelimited(text);
  else if (detected === "labels") rows = parseLabeledLines(text);
  else rows = parseAlternatingLines(text);
  return rows.filter(function (r) { return r.visualText || r.audioText; });
}

export function parseImportRows(text: string, mode: string) {
  if (mode === "twocolumn") return parseTwoColumnText(text);
  return splitImportText(text, mode).map(function (c) { return { visualText: "", audioText: c }; });
}

