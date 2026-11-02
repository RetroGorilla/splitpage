import type { CellClipboardPorts } from "./ports.ts";
import type { Attachment, AttachedCount, BrollScope, ClipboardPorts, PasteRequest, Pasted, TextRange, VideoFileAttachment } from "../../application/commands/clipboard.ts";
import type { CellInput, NormalizeOptions, Run } from "../../core/text/runs.ts";
import type { VideoFiles, VideoPosterFrame } from "../../application/media/video-files.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";

type ClipboardOptions = NormalizeOptions & { keepComments?: boolean | undefined; nonce?: string | null | undefined; skipImages?: boolean | undefined };
export interface ClipboardMediaInput {
  attach?: Attachment[] | undefined;
  skipImages?: boolean | undefined;
  lost?: number | undefined;
}
export interface ClipboardMediaReader {
  frame?: ((file: File) => Promise<VideoPosterFrame | null>) | undefined;
  grant?: VideoFiles["grant"] | undefined;
}
interface CellPasteResult {
  done: boolean;
  cellEl: Element;
  media: number;
  lost: number;
  attached: AttachedCount | null;
  rowIndex: number;
  field: string | null;
  movedComments: boolean;
}
type PasteTarget = Pick<PasteRequest, "rowId" | "field"> & { rest: readonly Run[] };

import { rowIndexOf } from "../../core/document/rows.ts";
import { cellLength, commentIds, normalizeCell, projection } from "../../core/text/runs.ts";
import { sliceCell } from "../../core/text/edits.ts";
import { flattenDirections } from "../../core/text/directions.ts";
import { toHtml } from "../../core/text/html.ts";
import {
  attachToGallery,
  cutCommand,
  freshBrollIds as freshIds,
  pasteCommand,
  takenBrollIds
} from "../../application/commands/clipboard.ts";
import { safeHref } from "../../core/document/text-policy.ts";

export { attachToGallery };

const CUT_ATTR = "data-splitpage-cut";

let ports: CellClipboardPorts | null = null;

function never() { return false; }
function always() { return true; }

export function stripComments(cell: CellInput) {
  return normalizeCell(cell, { hasComment: never });
}

export function clipboardOfCell(cell: CellInput, opts?: ClipboardOptions) {
  opts = opts || {};
  const c = opts.keepComments ? normalizeCell(cell) : stripComments(cell);
  let html = toHtml(c);
  if (opts.nonce) html = "<span " + CUT_ATTR + '="' + String(opts.nonce).replace(/[^A-Za-z0-9]/g, "") + '">' + html + "</span>";
  let text = "";
  flattenDirections(c).forEach(function (r) { text += r.text; });
  return { html: html, text: text.replace(/\u00a0/g, " ") };
}

export function cutNonceIn(html: unknown) {
  const m = new RegExp(CUT_ATTR + "\\s*=\\s*[\"']?([A-Za-z0-9]+)").exec(String(html == null ? "" : html));
  return m ? m[1] as string : null;
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|dailymotion\.com|dai\.ly|wistia\.com|wistia\.net|wi\.st|twitch\.tv|tiktok\.com|streamable\.com|frame\.io|f\.io|vidyard\.com)$/i;
const VIDEO_FILE_PATH = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;
const URL_RE = /https?:\/\/[^\s<>"]+/gi;

export function videoLink(href: unknown) {
  const safe = safeHref(String(href == null ? "" : href));
  if (!safe || !/^https?:\/\//i.test(safe)) return null;
  try {
    const u = new URL(safe);
    return VIDEO_HOSTS.test(u.hostname) || VIDEO_FILE_PATH.test(u.pathname) ? safe : null;
  } catch (e) { return null; }
}

function urlInText(u: string) {
  return videoLink(u.replace(/[.,;:!?)\]]+$/, ""));
}

function bareUrl(u: string) {
  return String(u).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
}

function attachKey(item: Attachment) {
  if (item.kind === "image") return "img:" + item.ref.sha256;
  if (item.kind === "video") return "video:" + item.href;
  return "file:" + item.name + ":" + item.size;
}

function addAttachment(list: Attachment[], item: Attachment) {
  const key = attachKey(item);
  if (!list.some(function (x) { return attachKey(x) === key; })) list.push(item);
  return list;
}

export function videoLinksInText(text: unknown) {
  const t = String(text == null ? "" : text);
  const links: string[] = [];
  (t.match(URL_RE) || []).forEach(function (u) {
    const v = urlInText(u);
    if (v && links.indexOf(v) === -1) links.push(v);
  });
  if (!links.length) return { text: t, links: links };
  const rest = t.replace(URL_RE, function (u) { return urlInText(u) ? "" : u; });
  return { text: /\S/.test(rest) ? t : "", links: links };
}

function prepareHtml(html: string, opts?: ClipboardOptions) {
  opts = opts || {};
  const body = (ports as CellClipboardPorts).text.inertBody(html);
  let media = 0, lost = 0;
  const attach: Attachment[] = [];
  const available = new Map<string, StoredImageRef | null>();
  const images = Array.from(body.querySelectorAll("img"), function (el) {
    const ref = opts.skipImages ? null : (ports as CellClipboardPorts).imageRefOf(el);
    if (ref) available.set(ref.sha256, ref);
    return { el: el, ref: ref };
  });
  available.forEach(function (ref, sha) {
    available.set(sha, (ports as CellClipboardPorts).pictures.has(sha) ? ref : null);
  });
  images.forEach(function (image) {
    const el = image.el;
    media++;
    if (!opts.skipImages) {
      const ref = image.ref && available.get(image.ref.sha256);
      if (ref) addAttachment(attach, { kind: "image", ref: ref });
      else lost++;
    }
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("a[href]"), function (el: HTMLAnchorElement) {
    if (!el.parentNode) return;
    const card = el.classList.contains("video-embed-card");
    let href = card ? safeHref(el.getAttribute("href") || "") : videoLink(el.getAttribute("href"));
    if (href && !/^https?:/i.test(href)) href = null;
    if (!href && !card) return;
    media++;
    if (href) addAttachment(attach, { kind: "video", href: href });
    const words = (el.textContent || "").trim();
    if (card || !href || !words || bareUrl(words) === bareUrl(href)) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("video"), function (el: HTMLVideoElement) {
    if (!el.parentNode) return;
    media++;
    const source = el.querySelector("source[src]");
    const href = safeHref(el.getAttribute("src") || (source ? source.getAttribute("src") : "") || "");
    if (href && /^https?:/i.test(href)) addAttachment(attach, { kind: "video", href: href });
    el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("picture"), function (el: HTMLPictureElement) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("style, script, template, noscript, title, meta, link"), function (el: Element) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  let last = body.lastChild;
  while (last && (last.nodeType === 8 || (last.nodeType === 3 && !/\S/.test(last.nodeValue as string)))) {
    body.removeChild(last);
    last = body.lastChild;
  }
  const endsInBlock = !!(last && last.nodeType === 1 && ((last as Element).tagName === "P" || (last as Element).tagName === "DIV"));
  return { html: body.innerHTML, media: media, lost: lost, attach: attach, endsInBlock: endsInBlock };
}

export function cellFromClipboard(html: unknown, text: unknown, opts?: ClipboardOptions) {
  opts = opts || {};
  let media = 0, lost = 0;
  let attach: Attachment[] = [];
  if (html) {
    const raw = String(html);
    const fromCut = !!(opts.nonce && cutNonceIn(raw) === opts.nonce);
    const prep = prepareHtml(raw, opts);
    media = prep.media;
    lost = prep.lost;
    attach = prep.attach;
    let cell = (ports as CellClipboardPorts).text.fromHtml(prep.html, { hasComment: fromCut ? (opts.hasComment || always) : never });
    if (prep.endsInBlock && projection(cell).slice(-1) === "\n") cell = sliceCell(cell, 0, cellLength(cell) - 1);
    if (cellLength(cell)) {
      return { cell: cell, text: null, media: media, lost: lost, attach: attach, fromCut: fromCut, comments: fromCut ? commentIds(cell) : [] };
    }
  }
  const vt = videoLinksInText(text);
  vt.links.forEach(function (href) { addAttachment(attach, { kind: "video", href: href }); });
  const t = vt.text;
  return { cell: normalizeCell([{ text: t, marks: {} }]), text: t, media: media, lost: lost, attach: attach, fromCut: false, comments: [] };
}

export function brollIdsTaken(state: BrollScope | null, rowId: PasteRequest["rowId"], field: PasteRequest["field"], rest: readonly Run[] | null, fromCut: boolean) {
  return takenBrollIds(state, rowId, field, rest, fromCut, (ports as CellClipboardPorts).text.cellOf);
}

export function freshBrollIds(cell: readonly Run[], taken: Readonly<Record<string, true>>, mint?: (() => string) | undefined) {
  return freshIds(cell, taken, mint || function () { return (ports as CellClipboardPorts).ids.id("bs"); });
}

function clipboardPorts(): ClipboardPorts {
  return {
    clock: (ports as CellClipboardPorts).edits.text.clock,
    editor: (ports as CellClipboardPorts).edits.text.editor,
    cells: (ports as CellClipboardPorts).edits.text.cells,
    ids: (ports as CellClipboardPorts).ids,
    brollSeed: (ports as CellClipboardPorts).brollSeed
  };
}

let cutNonce: string | null = null;

function isTextField(field: string | null): field is "visualText" | "audioText" {
  return field === "visualText" || field === "audioText";
}

function holdsDocument() {
  return (ports as CellClipboardPorts).document.read(function (doc) { return !!doc; });
}

function commentAnchoredAs(id: string) {
  return (ports as CellClipboardPorts).document.read(function (doc) {
    return !!doc && (doc.comments || []).some(function (c) {
      return c.kind !== "conflict" && (c.anchorId || c.id) === id;
    });
  });
}

function anchoredInText(id: string, target: PasteTarget) {
  return (ports as CellClipboardPorts).document.read(function (doc) {
    return !!doc && doc.rows.some(function (row) {
      return ["visualText", "audioText"].some(function (field) {
        const cell = target.rowId === row.id && target.field === field ? target.rest : (ports as CellClipboardPorts).text.cellOf(typeof row[field as string] === "string" ? row[field as string] : "");
        return commentIds(cell).indexOf(id) !== -1;
      });
    });
  });
}

function liveCellHtml(cellEl: Element) {
  let html = cellEl.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return (ports as CellClipboardPorts).text.storedHtmlFromDom(html);
}

function outsideSelection(cellEl: Element) {
  const cell = (ports as CellClipboardPorts).text.fromHtml(liveCellHtml(cellEl));
  const sel = (ports as CellClipboardPorts).selection(cellEl);
  if (!sel) return cell;
  const len = cellLength(cell);
  return sliceCell(cell, 0, Math.min(sel.from, len)).concat(sliceCell(cell, Math.min(sel.to, len), len));
}

export function copyFromCell(e: ClipboardEvent, cellEl: Element, cut: boolean) {
  const cd = e.clipboardData;
  const field = cellEl.getAttribute("data-field");
  if (!cd || !holdsDocument() || !isTextField(field) || (ports as CellClipboardPorts).document.read(function (doc) { return rowIndexOf(doc, cellEl.getAttribute("data-id")); }) === -1) return false;
  const html = liveCellHtml(cellEl);
  if (/<img|video-embed-card/.test(html)) return false;
  const sel = (ports as CellClipboardPorts).selection(cellEl);
  if (!sel || sel.from === sel.to) return false;
  const moving = cut;
  const nonce = moving ? (ports as CellClipboardPorts).nonce() : null;
  const out = clipboardOfCell(sliceCell((ports as CellClipboardPorts).text.fromHtml(html), sel.from, sel.to), { keepComments: moving, nonce: nonce });
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  e.preventDefault();
  if (!moving) return true;
  cutSelection(cellEl);
  cutNonce = nonce;
  return true;
}

function storedField(rowId: PasteRequest["rowId"], field: PasteRequest["field"]) {
  return (ports as CellClipboardPorts).document.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row && row[field as string] ? row[field as string] : "";
  });
}

function caretOf(caret: number | null) {
  return caret === null ? null : { from: caret, to: caret };
}

function cutSelection(cellEl: Element) {
  (ports as CellClipboardPorts).paintGuard.whileShown(function () { cutShown(cellEl); });
}

function cutShown(cellEl: Element) {
  const open = (ports as CellClipboardPorts).cells.open(cellEl);
  if (!open || !open.sel || open.sel.from === open.sel.to) return;
  const cut = cutCommand(open.rowId, open.field, open.sel, clipboardPorts());
  const outcome = (ports as CellClipboardPorts).edits.run(cut.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected") return;
  (ports as CellClipboardPorts).cells.close(cellEl, storedField(open.rowId, open.field), caretOf(cut.report().caret));
}

function pasteRequest(rowId: PasteRequest["rowId"], field: PasteRequest["field"], range: TextRange | null, pasted: Pasted | null, got: Pick<PasteRequest, "fromCut" | "comments">, attach: Attachment[]): PasteRequest {
  return { rowId: rowId, field: field, range: range, pasted: pasted, fromCut: got.fromCut, comments: got.comments, attach: attach };
}

export function pasteIntoCell(cellEl: Element, html: unknown, text: unknown, extra?: ClipboardMediaInput | null) {
  return (ports as CellClipboardPorts).paintGuard.whileShown(function () { return pasteShown(cellEl, html, text, extra); });
}

function pasteShown(cellEl: Element, html: unknown, text: unknown, extra?: ClipboardMediaInput | null) {
  extra = extra || {};
  let target: PasteTarget | null = null;
  const hasComment = function (id: string) {
    if (!commentAnchoredAs(id)) return false;
    if (!target) target = { rowId: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field"), rest: outsideSelection(cellEl) };
    return !anchoredInText(id, target);
  };
  const got = cellFromClipboard(html, text, { nonce: cutNonce, hasComment: hasComment, skipImages: !!extra.skipImages });
  const attach = (extra.attach || []).slice();
  got.attach.forEach(function (item) { addAttachment(attach, item); });
  const rowId = cellEl.getAttribute("data-id");
  const field = cellEl.getAttribute("data-field");
  const result: CellPasteResult = { done: true, cellEl: cellEl, media: got.media, lost: got.lost, attached: null,
                 rowIndex: (ports as CellClipboardPorts).document.read(function (doc) { return rowIndexOf(doc, rowId); }), field: field, movedComments: false };
  if (!cellLength(got.cell)) {
    if (!attach.length || result.rowIndex === -1) return result;
    (ports as CellClipboardPorts).undo.breakCoalescing();
    const gallery = pasteCommand(pasteRequest(rowId, field, null, null, got, attach), clipboardPorts());
    const galleryOutcome = (ports as CellClipboardPorts).edits.run(gallery.command);
    if (galleryOutcome.kind === "failed") throw galleryOutcome.error;
    result.attached = gallery.report().attached;
    (ports as CellClipboardPorts).undo.flush();
    (ports as CellClipboardPorts).undo.breakCoalescing();
    return result;
  }
  const open = (ports as CellClipboardPorts).cells.open(cellEl);
  if (!open) {
    result.done = false;
    return result;
  }
  const pasted: Pasted = got.text !== null ? { kind: "text", text: got.text } : { kind: "cell", runs: got.cell };
  const paste = pasteCommand(pasteRequest(rowId, field, open.sel, pasted, got, attach), clipboardPorts());
  const outcome = (ports as CellClipboardPorts).edits.run(paste.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected") {
    result.done = false;
    return result;
  }
  if (got.fromCut) {
    cutNonce = null;
    result.movedComments = got.comments.length > 0;
  }
  const report = paste.report();
  result.attached = report.attached;
  result.cellEl = (ports as CellClipboardPorts).cells.close(cellEl, storedField(rowId, field), caretOf(report.caret));
  return result;
}

export function readClipboardFiles(files: FileList | readonly File[] | null | undefined, compress: (file: File, maxDim: number, quality: number) => Promise<string>, video?: ClipboardMediaReader, html: string = "") {
  video = video || {};
  const list: File[] = Array.prototype.slice.call(files || []) as File[];
  const attach: (Attachment | null)[] = [];
  let skipImages = false;
  const jobs = list.map(function (file) {
    const type = String(file && file.type || "");
    if (type.indexOf("video/") === 0) {
      const item: { -readonly [K in keyof VideoFileAttachment]: VideoFileAttachment[K] } = { kind: "videoFile", name: String(file.name || ""), size: file.size || 0, poster: null };
      attach.push(item);
      if (video.grant) video.grant(file, { name: item.name, size: item.size });
      if (!video.frame) return Promise.resolve();
      return Promise.resolve(video.frame(file)).then(function (got) {
        if (got && got.duration) item.duration = got.duration;
        const rec = got && got.dataUrl ? (ports as CellClipboardPorts).pictures.internDataUrl(got.dataUrl) : null;
        if (!rec) return;
        (ports as CellClipboardPorts).pictures.persist([rec.sha256]);
        item.poster = rec;
      }, function () {});
    }
    if (type.indexOf("image/") !== 0) return Promise.resolve();
    skipImages = true;
    const slot = attach.length;
    attach.push(null);
    return compress(file, 1000, 0.78).then(function (dataUrl) {
      const rec = (ports as CellClipboardPorts).pictures.internDataUrl(dataUrl);
      if (!rec) return;
      (ports as CellClipboardPorts).pictures.persist([rec.sha256]);
      attach[slot] = { kind: "image", ref: rec, name: String(file.name || "") };
    }, function () {});
  });
  if (!skipImages) {
    const shas = clipboardImageHashes(html);
    if (shas.length) jobs.push((ports as CellClipboardPorts).pictures.ensureBytes(shas).then(function () {}));
  }
  return Promise.all(jobs).then(function () {
    const kept = attach.filter(Boolean) as Attachment[];
    return { attach: kept, skipImages: skipImages, lost: attach.length - kept.length };
  });
}

function clipboardImageHashes(html: string): string[] {
  if (!/data-blob/i.test(html)) return [];
  const shas = new Set<string>();
  (ports as CellClipboardPorts).text.inertBody(html).querySelectorAll("img[data-blob]").forEach(function (el) {
    const ref = (ports as CellClipboardPorts).imageRefOf(el);
    if (ref) shas.add(ref.sha256);
  });
  return Array.from(shas);
}

export function hasMediaFiles(files: FileList | readonly File[] | null | undefined, html: string = "") {
  return Array.prototype.some.call(files || [], function (f: File | null | undefined) {
    return /^(image|video)\//.test(String(f && f.type || ""));
  }) || clipboardImageHashes(html).length > 0;
}

export function startCellClipboard(given: CellClipboardPorts) {
  ports = given;
  cutNonce = null;
  return { dispose: function () { cutNonce = null; } };
}
