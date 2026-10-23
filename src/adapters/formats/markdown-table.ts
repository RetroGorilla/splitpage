export interface MarkdownTableRow {
  readonly visualText: string;
  readonly audioText: string;
  readonly statusText: string;
}

export interface ColumnIndices {
  readonly visualIdx: number;
  readonly audioIdx: number;
}

const VISUAL_HEADER_RE = /^(visual|video|scene|shot|b-?roll|image|screen)s?$/i;
const AUDIO_HEADER_RE = /^(audio|vo|voiceover|voice-over|narration|dialogue|script)s?$/i;

export const MD_EXPORT_TAIL_RE = /^\s*##\s+(Production breakdown|B-roll shot list|Comments)\s*$/;
const MD_OWN_TABLE_HEADERS: readonly string[] = Object.freeze(["#|visual|audio|status", "#|start|status|visual|audio|read"]);

export function columnIndicesFromHeader(header: readonly string[]): ColumnIndices {
  let visualIdx = header.findIndex(function (c) { return VISUAL_HEADER_RE.test(c.trim()); });
  let audioIdx = header.findIndex(function (c) { return AUDIO_HEADER_RE.test(c.trim()); });
  if (visualIdx !== -1 && audioIdx === -1) audioIdx = visualIdx === 0 ? 1 : 0;
  else if (audioIdx !== -1 && visualIdx === -1) visualIdx = audioIdx === 0 ? 1 : 0;
  return { visualIdx: visualIdx, audioIdx: audioIdx };
}

export function splitTableRowCells(line: string): string[] {
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") { current += "|"; i++; continue; }
    if (trimmed[i] === "|") { cells.push(current.trim()); current = ""; continue; }
    current += trimmed[i];
  }
  cells.push(current.trim());
  return cells;
}

export function markdownExportScript(text: unknown): string {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!sawHeader) {
      sawHeader = line.indexOf("|") !== -1 &&
        MD_OWN_TABLE_HEADERS.indexOf(splitTableRowCells(line.trim()).join("|").toLowerCase()) !== -1;
    } else if (MD_EXPORT_TAIL_RE.test(line)) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text as string;
}

export function parseMarkdownTable(text: unknown, opts?: { readonly keepEmpty?: boolean } | null): MarkdownTableRow[] {
  const keepEmpty = !!(opts && opts.keepEmpty);
  const lines = markdownExportScript(text).replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  const rows: string[][] = [];
  lines.forEach(function (line) {
    if (line.indexOf("|") === -1) return;
    const cells = splitTableRowCells(line);
    if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ""; })) return;
    rows.push(cells);
  });
  const first = rows[0];
  if (!first) return [];
  let visualIdx = 0, audioIdx = 1, startIdx = 0, statusIdx = -1;
  const header = first.map(function (c) { return c.toLowerCase(); });
  const idxs = columnIndicesFromHeader(header);
  if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
    startIdx = 1;
    if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
    if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
    statusIdx = header.findIndex(function (c) { return c.trim() === "status"; });
  }
  const out: MarkdownTableRow[] = [];
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const v = row[visualIdx] || "", a = row[audioIdx] || "";
    if (!v && !a && !keepEmpty) continue;
    out.push({
      visualText: v,
      audioText: a,
      statusText: statusIdx === -1 ? "" : (row[statusIdx] || "")
    });
  }
  return out;
}
