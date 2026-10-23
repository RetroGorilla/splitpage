import type { InertElement, ProjectFileServices } from "../../application/formats/project-file-services.ts";
import { projectFileServices } from "../../application/formats/project-file-services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { DocumentRow, DocumentTag, ValidatedDocument } from "../../core/document/validated.ts";
import { cloneState } from "../../core/document/clone.ts";
import { docIdEmbeddedIn } from "../../core/document/ids.ts";
import { cappedLongText, legacyMdToHtml, plainText, safeImageSrc } from "../../core/document/text-policy.ts";
import { isDocumentObject } from "../../core/migrate.ts";
import { fileKindFromName } from "../../../shared/file-names.js";
import { inlineStateImages, internDataUrl, missingInlineImages, queuePersist, rowImageDataUrl } from "../storage/02c-blobs.js";
import { makeId } from "../identity/ids.ts";
import { audioDirectionsHtml } from "./docx.ts";
import { mdSceneCellSource, toMarkdownTableDoc } from "./export-text.ts";
import { MD_IMAGE_PREFIX_RE } from "./markdown-image.ts";
import { parseMarkdownTable } from "./markdown-table.ts";
import type { MarkdownTableRow } from "./markdown-table.ts";
import { parseSplitpageFile } from "./splitpage-file.ts";

export interface MarkdownProject {
  readonly state: ValidatedDocument;
  readonly docIdEmbedded: boolean;
  readonly table: readonly MarkdownTableRow[];
  readonly title: string | null;
}

export type ProjectFileKind = "splitpage" | "html" | "md";

export type ParsedProjectFile =
  | { readonly state: ValidatedDocument; readonly kind: ProjectFileKind; readonly docIdEmbedded: boolean }
  | { readonly error: "unreadable" | "not-splitpage" };

export interface ProjectFileOptions {
  readonly noAsk?: boolean | undefined;
}

interface ReadableFile {
  readonly name: string;
  readonly text: () => Promise<string>;
}

interface CellSource {
  readonly visual: string;
  readonly visualText: string;
  readonly image: string | null;
  readonly audio: string;
}

interface CellEdits {
  readonly visual: boolean;
  readonly audio: boolean;
}

interface TagAttributes {
  readonly attrs: Record<string, string>;
  readonly end: number;
}

const MD_DATA_INFO = "splitpage";
const MD_DATA_NOTE = "<!-- splitpage: everything below is Splitpage's own record of this " +
  "script. Edit the text above freely; leave this block alone. -->";
const RAW_TEXT_ELEMENTS: Readonly<Record<string, number>> = Object.freeze({ script: 1, style: 1, textarea: 1, title: 1, xmp: 1, iframe: 1, noembed: 1, noframes: 1 });

function fileStateFor(doc: ExportDocument, services: ProjectFileServices): ValidatedDocument {
  const copy = services.migrateRows(cloneState(doc.document));
  inlineStateImages(copy);
  return copy;
}

export function buildSplitpageFile(doc: ExportDocument, services: ProjectFileServices = projectFileServices()): string {
  return JSON.stringify(fileStateFor(doc, services), null, 2);
}

export function fileImagesMissing(doc: ExportDocument): string[] {
  return missingInlineImages(doc.document) as string[];
}

function splitpageDataFence(json: string): string {
  let longest = 3;
  const re = /~{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return new Array(Math.max(4, longest + 1) + 1).join("~");
}

export function buildMarkdownProject(doc: ExportDocument, services: ProjectFileServices = projectFileServices()): string {
  const json = buildSplitpageFile(doc, services);
  const fence = splitpageDataFence(json);
  return toMarkdownTableDoc(doc) + "\n" + MD_DATA_NOTE + "\n" +
    fence + MD_DATA_INFO + "\n" + json + "\n" + fence + "\n";
}

function findMarkdownDataBlock(text: unknown): { readonly json: string; readonly before: string } | null {
  const lines = String(text || "").replace(/\r\n|\r/g, "\n").split("\n");
  let openAt = -1, fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(~{3,})\s*splitpage\s*$/.exec(lines[i] ?? "");
    if (m) { openAt = i; fenceLen = (m[1] ?? "").length; }
  }
  if (openAt === -1) return null;
  const closeRe = new RegExp("^~{" + fenceLen + ",}\\s*$");
  let closeAt = -1;
  for (let i = openAt + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i] ?? "")) { closeAt = i; break; }
  }
  return {
    json: lines.slice(openAt + 1, closeAt === -1 ? lines.length : closeAt).join("\n"),
    before: lines.slice(0, openAt).join("\n")
  };
}

export function parseMarkdownProject(text: unknown, services: ProjectFileServices = projectFileServices()): MarkdownProject | null {
  const block = findMarkdownDataBlock(text);
  if (!block) return null;
  let parsed: unknown;
  try { parsed = parseSplitpageFile(block.json); } catch { return null; }

  const sceneSection = block.before.split(/^##\s/m)[0] ?? "";
  const heading = /^#\s+(.+)$/m.exec(block.before);
  const docIdEmbedded = docIdEmbeddedIn(parsed);
  return {
    state: services.migrateDocument(parsed, { kind: "file" }),
    docIdEmbedded: docIdEmbedded,
    table: parseMarkdownTable(sceneSection, { keepEmpty: true }),
    title: heading ? (heading[1] ?? "").trim() : null
  };
}

function markdownCellToHtml(s: ValidatedDocument, md: unknown, services: ProjectFileServices): string {
  let html = services.sanitizeHtml(legacyMdToHtml(String(md == null ? "" : md).replace(/\u00A0/g, " ")));
  const names = (s.productionTags || []).slice().sort(function (a, b) {
    return String((b as DocumentTag).name || "").length - String((a as DocumentTag).name || "").length;
  });
  names.forEach(function (t) {
    const tag = t as DocumentTag;
    const name = String(tag.name || "").trim();
    if (!name) return;
    const res = services.tagFieldOccurrences(html, name, tag.cat, name, false);
    if (res.hits) html = res.html;
  });
  return services.sanitizeHtml(html);
}

function markdownAudioCellToHtml(s: ValidatedDocument, md: unknown, services: ProjectFileServices): string {
  return audioDirectionsHtml(markdownCellToHtml(s, md, services));
}

function applyMarkdownVisualCell(s: ValidatedDocument, row: DocumentRow, md: unknown, services: ProjectFileServices): void {
  let text = String(md == null ? "" : md);
  const m = MD_IMAGE_PREFIX_RE.exec(text);
  const rec = m ? internDataUrl(safeImageSrc(m[1]) || "") : null;
  if (rec) queuePersist([rec.sha256]);
  const ref = row["imageRef"] as { readonly sha256?: unknown } | null | undefined;
  const uncarried = !m && ref && !rowImageDataUrl(row);
  delete row["visualImage"];
  if (!uncarried) {
    const was = ref && ref.sha256;
    row["imageRef"] = rec || null;
    if (!rec || rec.sha256 !== was) delete row["imageAnnotation"];
  }
  if (m) text = text.slice(m[0].length);
  row.visualText = markdownCellToHtml(s, text, services);
}

function markdownCellChanged(cellText: unknown, was: string): boolean {
  return String(cellText == null ? "" : cellText).trim() !== was;
}

function markdownVisualCellChanged(cellText: unknown, was: CellSource): boolean {
  if (!markdownCellChanged(cellText, was.visual)) return false;
  const text = String(cellText == null ? "" : cellText).trim();
  const m = MD_IMAGE_PREFIX_RE.exec(text);
  if (!m) return true;
  const rec = internDataUrl(safeImageSrc(m[1]) || "");
  if (!rec || rec.sha256 !== was.image) return true;
  return text.slice(m[0].length).trim() !== was.visualText;
}

function sceneCellEdits(row: DocumentRow, i: number, cells: MarkdownTableRow): CellEdits {
  const was: CellSource = mdSceneCellSource(row, i);
  let model: CellSource | null = null;
  function modelWas(): CellSource { return model || (model = mdSceneCellSource(row, i, true)); }
  return {
    visual: markdownVisualCellChanged(cells.visualText, was) && markdownVisualCellChanged(cells.visualText, modelWas()),
    audio: markdownCellChanged(cells.audioText, was.audio) && markdownCellChanged(cells.audioText, modelWas().audio)
  };
}

function reconcileMarkdownRows(s: ValidatedDocument, table: readonly MarkdownTableRow[], services: ProjectFileServices): number {
  let changed = 0;
  s.rows.forEach(function (row, i) {
    const cells = table[i];
    if (!cells) return;
    const edits = sceneCellEdits(row, i, cells);
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText, services);
      changed++;
    }
    if (edits.audio) {
      row.audioText = markdownAudioCellToHtml(s, cells.audioText, services);
      changed++;
    }
  });
  return changed;
}

function rowsFromMarkdownTable(s: ValidatedDocument, table: readonly MarkdownTableRow[], services: ProjectFileServices): DocumentRow[] {
  return table.map(function (cells, i) {
    const old = s.rows[i] || null;
    const row: DocumentRow = old || { id: makeId(), status: "todo", imageRef: null, updatedAt: "", updatedBy: null };
    const edits: CellEdits = old ? sceneCellEdits(old, i, cells) : { visual: true, audio: true };
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText, services);
    }
    if (edits.audio) {
      row.audioText = markdownAudioCellToHtml(s, cells.audioText, services);
    }
    return row;
  });
}

export async function applyMarkdownProject(proj: MarkdownProject, opts?: ProjectFileOptions | null, services: ProjectFileServices = projectFileServices()): Promise<ValidatedDocument> {
  const s = proj.state;
  if (proj.title && proj.title !== s.title) s.title = cappedLongText(plainText(proj.title), 300);

  if (proj.table.length === s.rows.length) {
    reconcileMarkdownRows(s, proj.table, services);
  } else if (!(opts && opts.noAsk)) {
    const choice = await services.askMarkdownRows(s.rows.length, proj.table.length);
    if (choice === "table") s.rows = rowsFromMarkdownTable(s, proj.table, services);
  }
  return services.migrateRows(s);
}

function tagAttributes(text: string, from: number): TagAttributes | null {
  const attrs: Record<string, string> = {};
  let i = from;
  const n = text.length;
  while (i < n) {
    while (i < n && /[\t\n\f\r /]/.test(text.charAt(i))) i++;
    if (i >= n) return null;
    if (text[i] === ">") return { attrs: attrs, end: i + 1 };
    const nameStart = i;
    i++;
    while (i < n && !/[\t\n\f\r />=]/.test(text.charAt(i))) i++;
    const name = text.slice(nameStart, i).toLowerCase();
    while (i < n && /[\t\n\f\r ]/.test(text.charAt(i))) i++;
    let value = "";
    if (text[i] === "=") {
      i++;
      while (i < n && /[\t\n\f\r ]/.test(text.charAt(i))) i++;
      const quote = text[i];
      if (quote === "\"" || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close === -1) return null;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !/[\t\n\f\r >]/.test(text.charAt(i))) i++;
        value = text.slice(valueStart, i);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = value;
  }
  return null;
}

function stateDataScriptText(text: string): string | null {
  const opening = /<(!--|[a-zA-Z][^\t\n\f\r />]*)/g;
  for (let m = opening.exec(text); m; m = opening.exec(text)) {
    if (m[1] === "!--") {
      const commentEnd = text.indexOf("-->", m.index + 4);
      if (commentEnd === -1) return null;
      opening.lastIndex = commentEnd + 3;
      continue;
    }
    const tag = tagAttributes(text, m.index + m[0].length);
    if (!tag) return null;
    const name = (m[1] ?? "").toLowerCase();
    opening.lastIndex = tag.end;
    if (!RAW_TEXT_ELEMENTS[name]) continue;
    const closing = new RegExp("</" + name + "[\\t\\n\\f\\r />]", "ig");
    closing.lastIndex = tag.end;
    const closed = closing.exec(text);
    const contentEnd = closed ? closed.index : text.length;
    if (name === "script" && tag.attrs["id"] === "state-data") return text.slice(tag.end, contentEnd);
    if (!closed) return null;
    opening.lastIndex = contentEnd;
  }
  return null;
}

function stateDataFromRawText(text: string): Record<string, unknown> | null {
  const data = stateDataScriptText(text);
  if (data === null) return null;
  try {
    const parsed: unknown = JSON.parse(data.replace(/\r\n?/g, "\n"));
    return isDocumentObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function parseProjectFileState(file: ReadableFile, opts?: ProjectFileOptions | null, services: ProjectFileServices = projectFileServices()): Promise<ParsedProjectFile | null> {
  const kind = fileKindFromName(file.name);
  if (kind !== "splitpage" && kind !== "md" && kind !== "html") return null;

  let text: string;
  try {
    text = await file.text();
  } catch {
    return { error: "unreadable" };
  }

  if (kind === "splitpage") {
    let native: unknown;
    try {
      native = parseSplitpageFile(text);
    } catch {
      return { error: "not-splitpage" };
    }
    const nativeEmbedded = docIdEmbeddedIn(native);
    return { state: services.migrateDocument(native, { kind: "file" }), kind: "splitpage", docIdEmbedded: nativeEmbedded };
  }

  if (kind === "html") {
    let legacy: unknown = stateDataFromRawText(text);
    if (!legacy) {
      const dataEl = services.inertBody(text).ownerDocument.getElementById("state-data");
      try {
        legacy = JSON.parse((dataEl as InertElement).textContent as string);
      } catch {
        return { error: "not-splitpage" };
      }
    }
    if (!isDocumentObject(legacy)) return { error: "not-splitpage" };
    const legacyEmbedded = docIdEmbeddedIn(legacy);
    return { state: services.migrateDocument(legacy, { kind: "file" }), kind: "html", docIdEmbedded: legacyEmbedded };
  }

  let project: MarkdownProject | null;
  try {
    project = parseMarkdownProject(text, services);
  } catch {
    project = null;
  }
  if (!project) return null;
  const reconciled = await applyMarkdownProject(project, opts, services);
  return { state: reconciled, kind: "md", docIdEmbedded: !!project.docIdEmbedded };
}
