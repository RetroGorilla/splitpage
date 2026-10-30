import type { RowsRenderPorts } from "./render-ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { ChangeSet, SessionChange } from "../../application/session/change-set.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { ShotRowEntry, ShotStrip } from "../../application/shot-hiding.ts";
import type { ViewFlagChange } from "../../application/preferences/view-flags.ts";
import type { Slot, VideoLink } from "../../core/document/gallery.ts";
import type { Marks, Run } from "../../core/text/runs.ts";
import { rowSlots, videoLinkKey } from "../../core/document/gallery.ts";
import { editableCellHtml } from "../common/editable-cell.js";
import { disarmDeleteButton } from "./delete-button.ts";
import { hasSetLength } from "../../core/document/timing.ts";
import type { LengthHolder } from "../../core/document/timing.ts";
import { ROW_STATUSES, rowStatus } from "../../core/production/looks.ts";
import { hiddenShotStripHtml } from "./hide-shot.ts";
import { videoLinkLabel } from "../../core/document/gallery.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { ensureTrailingCaretSpot } from "../common/dom.ts";
import { safeHref } from "../../core/document/text-policy.ts";
import { cssAttr } from "../common/dom.ts";
import { slotPoster } from "../common/gallery.ts";
import { rowMotionKey, withRowMotion } from "./row-motion.js";
import { formatTimestamp } from "../common/comment-time.js";
import { idMap } from "../../core/document/id-map.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { estimatedSeconds, pad2, formatDuration, formatTimecode, rowSeconds } from "../../core/production/timing.ts";
import { cueShortcut } from "../../core/text/cues.ts";
import { directionRangeAt, directionShortcut, directionToggleRange, toggleDirection } from "../../core/text/directions.ts";
import {
  breakLine,
  clamp,
  insertText,
  insideDirection,
  markThroughout,
  setMark,
  toggleMark,
  typingMarks
} from "../../core/text/edits.ts";
import { cellLength, projection } from "../../core/text/runs.ts";
import { cellSelection, placeEditorSelection, rememberCellSelection } from "../common/cell-selection.ts";
import { formatVideoLength } from "../../../shared/text.js";

type Ports = RowsRenderPorts;
type Row = DocumentView["rows"][number];
type TextField = "visualText" | "audioText";
type PatchedPart = "gutter" | TextField | "media";
type FormatMark = "b" | "i" | "u" | "s" | "hl";
type DraftMedia = ReturnType<Ports["draft"]["model"]>["media"];
type ModelEdit = (cell: Run[], sel: CellRange | null, media?: DraftMedia) => { cell: Run[]; sel?: CellRange } | null;

interface RowParts {
  readonly cls: string;
  readonly gutter: string;
  readonly media: string;
  visualText: string;
  audioText: string;
}

interface SignedRow extends Element {
  __splitpageRowSig?: RowParts;
}

interface RowPatch {
  readonly p: RowParts;
  readonly parts: { readonly key: PatchedPart; readonly el: Element; readonly fresh: Element }[];
}

interface RowsStep {
  readonly node: Element;
  readonly patch?: RowPatch;
  readonly added?: true;
}

type RowsPlan = { readonly empty: true } | { readonly empty?: undefined; readonly steps: RowsStep[]; readonly drop: Element[] };

interface RenderFocus {
  cell: HTMLElement | null;
  id: string | null;
  field: string | null;
  rowEl: Element | null;
  sel: { sc: Node; so: number; ec: Node; eo: number } | null;
}

interface StalePlace {
  readonly id?: string;
  readonly row?: string | null;
  readonly field?: string | null;
}

interface RedrawToast extends HTMLElement {
  dismiss: () => void;
}

type PendingMarks = { cell: Element; pos: number; marks: Partial<Record<FormatMark, boolean>> };

type ScreenChange = Pick<SessionChange, "kind" | "changes">;

type PaintKind = "row" | "rows" | "screen" | "tags";

interface RenderCounts {
  render: number;
  rowsPainted: number;
  cellsPainted: number;
  productionDerived: number;
  idleFlushes: number;
}

interface RenderTest {
  render: () => void;
  counts: () => RenderCounts | null;
  reset: () => void;
}

interface ScreenListeners {
  readonly session: (change: ScreenChange) => void;
  readonly stamped: (changes: ChangeSet) => void;
  readonly refresh: (jobs: ReadonlySet<string>) => void;
  readonly hiding: () => void;
  readonly preference: (name: string) => void;
  readonly location: () => void;
  readonly flag: (change: ViewFlagChange) => void;
}

type RenderWindow = Window & { __renderTest?: RenderTest };

let currentDocument: Ports["document"]["current"];
let readSession: Ports["document"]["read"];
let editAllowed: Ports["edits"]["allowed"];
let sanitizeHtml: Ports["text"]["sanitizeHtml"];
let storedHtmlFromDom: Ports["text"]["storedHtmlFromDom"];
let fromHtml: Ports["text"]["fromHtml"];
let productionReaders: Ports["text"]["productionReaders"];
let buildVideoCardEl: Ports["video"]["card"];
let videoHostLabel: Ports["video"]["hostLabel"];
let cellEditing: Ports["editing"]["cells"];
let editorSelection: Ports["editing"]["selection"];
let paintGuard: Ports["editing"]["paint"];
let undoGuard: Ports["editing"]["undo"];
let appendDraftMedia: Ports["draft"]["appendMedia"];
let draftModel: Ports["draft"]["model"];
let editDraft: Ports["draft"]["edit"];
let isDraftBox: Ports["draft"]["isDraft"];
let isScriptCell: Ports["draft"]["isScript"];
let trackDocument: Ports["undo"]["track"];
let shotHiding: Ports["hiding"];
let blobImgHtml: Ports["pictures"]["imgHtml"];
let personColors: Ports["personColors"];
let preferences: Ports["preferences"];
let viewFlags: Ports["view"];
let showToast: Ports["notices"]["show"];
let showActionToast: Ports["notices"]["showAction"];
let appActions: Ports["actions"];
let deleteConfirmation: Ports["deletes"];
let setTagAddingPerson: Ports["tagPanel"]["setTagAddingPerson"];
let makeId: Ports["ids"]["id"];
let productionIndexStats: Ports["production"]["stats"];
let resetProductionIndexStats: Ports["production"]["resetStats"];
let scheduleUntaggedScan: Ports["production"]["scan"];
let tagFieldOccurrences: Ports["production"]["occurrences"];
let activeRender: object | null = null;

const FIELD_PLACEHOLDERS: Record<TextField, string> = {
  visualText: "Describe what is on screen…",
  audioText: "Write what gets said…"
};

function rowFieldHtml(row: Row, field: TextField): string {
  return editableCellHtml({
    rowId: row.id,
    field: field,
    value: row[field],
    placeholder: FIELD_PLACEHOLDERS[field],
    toolbar: field === "audioText" ? "scriptAudio" : "script"
  });
}

const STATUS_CHECK_SVG =
  '<svg class="status-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function rowMenuItemHtml(row: Row, action: string, icon: string, label: string, title: string, danger?: boolean): string {
  return '<button class="gutter-btn row-menu-item' + (danger ? ' danger' : '') + '" type="button" role="menuitem" data-action="' +
    action + '" data-id="' + row.id + '" title="' + title + '">' +
    '<svg class="mi-icon" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
    '<span class="row-menu-label">' + label + '</span></button>';
}

function rowGutterHtml(row: Row, index: number): string {
  const st = (rowStatus(row.status) || ROW_STATUSES[0]) as NonNullable<ReturnType<typeof rowStatus>>;
  const num = pad2(index + 1);
  const lamp = '<span class="status-dot ' + st.cls + '" aria-hidden="true">' +
    (st.id === "shot" ? STATUS_CHECK_SVG : '') + '</span><span class="status-word">' + escapeHtml(st.label) + '</span>';
  const head = '<div class="row-head" data-action="drag-grip" data-id="' + row.id + '" title="Drag to reorder">' +
        '<span class="row-num">' + num + '</span><span class="row-start"></span>' +
      '</div>';
  const controls = '<button class="status-btn" type="button" data-action="cycle-status" data-id="' + row.id +
        '" title="' + escapeHtml(st.label) + ' — click to change" aria-label="Scene ' + num + ' status: ' +
        escapeHtml(st.label) + '. Change status">' + lamp + '</button>' +
      '<div class="row-tools">' +
        '<span class="row-grip" data-action="drag-grip" data-id="' + row.id + '" title="Drag to move this scene" aria-hidden="true">' +
          '<svg aria-hidden="true"><use href="#i-grip"/></svg></span>' +
        '<div class="row-menu-wrap">' +
          '<button class="row-more" type="button" data-action="row-menu" data-id="' + row.id +
            '" aria-haspopup="menu" aria-expanded="false" aria-label="Scene ' + num + ' actions" title="Move, insert or delete this scene">' +
            '<svg aria-hidden="true"><use href="#i-more"/></svg></button>' +
          '<div class="row-menu" role="menu" aria-label="Scene ' + num + '" hidden>' +
            rowMenuItemHtml(row, "move-up", "i-arrow-up", "Move up", "Move this scene up (Alt+Up)") +
            rowMenuItemHtml(row, "move-down", "i-arrow-down", "Move down", "Move this scene down (Alt+Down)") +
            rowMenuItemHtml(row, "insert-below", "i-plus", "Insert scene", "Insert an empty scene below this one") +
            rowMenuItemHtml(row, "delete-row", "i-trash", "Delete", "Delete this scene", true) +
          '</div>' +
        '</div>' +
      '</div>';
  return (
    '<div class="gutter">' +
      head +
      '<div class="row-controls">' + controls + '</div>' +
      (row.updatedBy
        ? '<div class="row-meta" title="Last edited by ' + escapeHtml(row.updatedBy) + '">' +
            '<span class="row-meta-who"><span class="person-dot" style="--person:' + personColors.personColor(row.updatedBy) +
              '" aria-hidden="true"></span>' + escapeHtml(String(row.updatedBy).split(/\s+/)[0]) + '</span><br>' +
            formatTimestamp(row.updatedAt, preferences().clock()) + '</div>'
        : '') +
    '</div>'
  );
}

export function paintRowTimes() {
  const rowsEl = document.getElementById("rows");
  const doc = currentDocument();
  if (!rowsEl || !doc) return;
  const byId = idMap<Element>();
  for (let c = rowsEl.firstElementChild; c; c = c.nextElementSibling) {
    if (c.classList.contains("row")) byId[c.getAttribute("data-id") as string] = c;
  }
  let t = 0;
  doc.rows.forEach(function (row) {
    const secs = rowSeconds(row, doc, productionReaders);
    const el = byId[row.id];
    if (el) {
      setTextIfChanged(el.querySelector(".row-start"), formatTimecode(t));
      paintReadTime(el.querySelector<HTMLElement>(".row-read"), row, secs, doc);
    }
    t += secs;
  });
}

function paintReadTime(btn: HTMLElement | null, row: Row, secs: number, doc: DocumentView): void {
  if (!btn) return;
  const set = hasSetLength(row as LengthHolder);
  const est = set ? estimatedSeconds(row, doc, productionReaders) : secs;
  const over = set && Math.round(est) > Math.round(secs);
  setTextIfChanged(btn, set || secs >= 0.5 ? formatDuration(secs) : "");
  btn.classList.toggle("is-set", set);
  btn.classList.toggle("is-over", over);
  const title = set
    ? "Set by hand · estimate " + formatDuration(est) +
      (over ? " — the Audio now reads longer than this" : "") +
      ". Click to change; clear it to use the estimate"
    : "Estimated read time — click to set this scene’s length";
  if (btn.title !== title) btn.title = title;
}

function setTextIfChanged(el: Element | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

const GALLERY_CELL_MAX = 4;
const GALLERY_CAPTION_MAX = 3;

export function gallerySlotPictureHtml(slot: Slot): string {
  if (slot.ref) return blobImgHtml(slot.ref);
  if (slot.dataUrl) return '<img src="' + escapeHtml(slot.dataUrl) + '" alt="">';
  return '<span class="scene-gallery-placeholder" aria-hidden="true"></span>';
}

export function galleryBadgeHtml(big: boolean): string {
  return '<span class="scene-gallery-play' + (big ? ' is-big' : '') + '" aria-hidden="true"></span>';
}

function galleryTileHtml(row: Row, slots: readonly Slot[], i: number, kind: "cover" | "small" | "more"): string {
  const slot = slots[i] as Slot;
  const poster = slotPoster(slot);
  const n = slots.length;
  const inner = gallerySlotPictureHtml(slot);
  if (kind === "more") {
    const rest = n - (GALLERY_CELL_MAX - 1);
    return '<button type="button" class="scene-gallery-tile is-more" data-action="gallery-open" data-id="' + row.id +
      '" data-slot="' + i + '" aria-label="Show all ' + n + ' pictures and videos">' + inner +
      (poster ? galleryBadgeHtml(false) : '') + '<span class="scene-gallery-more-count">+' + rest + '</span></button>';
  }
  const what = (poster ? "Video " : "Picture ") + (i + 1) + " of " + n +
    (poster ? ": " + videoLinkLabel(poster) : slot.name ? ": " + slot.name : "");
  const cover = kind === "cover";
  const length = cover && poster ? formatVideoLength(poster.duration) : "";
  return '<button type="button" class="scene-gallery-tile' + (cover ? ' is-cover' : '') + (poster ? ' is-video' : '') +
    '" data-action="gallery-open" data-id="' + row.id + '" data-slot="' + i + '" aria-label="' + escapeHtml(what) + '">' +
    inner + (poster ? galleryBadgeHtml(cover) : '') +
    (length ? '<span class="scene-gallery-length">' + length + '</span>' : '') + '</button>';
}

function galleryLinkHtml(row: Row, slotIdx: number, l: VideoLink): string {
  const key = escapeHtml(videoLinkKey(l));
  const label = escapeHtml(videoLinkLabel(l));
  const full = escapeHtml(l.href ? l.href : l.name);
  const attrs = ' data-action="gallery-link" data-id="' + row.id + '" data-slot="' + slotIdx + '" data-key="' + key + '" title="' + full + '"';
  const href = l.href ? safeHref(l.href) : null;
  const link = href
    ? '<a class="scene-gallery-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' + attrs + '>' + label + '</a>'
    : '<button type="button" class="scene-gallery-link is-file"' + attrs + '>' + label + '</button>';
  return '<div class="scene-gallery-line"><span class="scene-gallery-host">' + escapeHtml(videoHostLabel(l)) + '</span>' + link +
    '<button type="button" class="scene-gallery-link-remove" data-action="gallery-link-remove" data-id="' + row.id +
      '" data-slot="' + slotIdx + '" data-key="' + key + '" title="Take this link off" aria-label="Take ' + label + ' off">×</button>' +
    '</div>';
}

export function galleryVideoLinks(slots: readonly Slot[]): { slot: number; link: VideoLink }[] {
  const out: { slot: number; link: VideoLink }[] = [];
  slots.forEach(function (s, i) { s.links.forEach(function (l) { out.push({ slot: i, link: l }); }); });
  return out;
}

function rowGalleryHtml(row: Row, slots: readonly Slot[]): string {
  const n = slots.length;
  let tiles = galleryTileHtml(row, slots, 0, "cover");
  for (let i = 1; i < Math.min(n, GALLERY_CELL_MAX); i++) {
    tiles += galleryTileHtml(row, slots, i, n > GALLERY_CELL_MAX && i === GALLERY_CELL_MAX - 1 ? "more" : "small");
  }
  const videos = galleryVideoLinks(slots);
  let caption = videos.slice(0, GALLERY_CAPTION_MAX).map(function (v) { return galleryLinkHtml(row, v.slot, v.link); }).join("");
  if (videos.length > GALLERY_CAPTION_MAX) {
    const more = videos.length - GALLERY_CAPTION_MAX;
    caption += '<button type="button" class="scene-gallery-more-videos" data-action="gallery-open-videos" data-id="' + row.id + '">+' +
      more + ' more video' + (more === 1 ? '' : 's') + '</button>';
  }
  const single = n === 1;
  return '<div class="image-thumb-wrap scene-gallery ' + (single ? 'is-single' : 'is-mosaic') + '" data-id="' + row.id + '" data-count="' + n + '">' +
      tiles +
      '<div class="image-thumb-actions">' +
        '<button type="button" data-action="image-add-more" data-id="' + row.id + '" title="Add another picture to this scene">Add</button>' +
        (single
          ? '<button type="button" data-action="image-replace" data-id="' + row.id + '" data-slot="0">Replace</button>' +
            '<button type="button" data-action="image-remove" data-id="' + row.id + '" data-slot="0">Remove</button>'
          : '') +
      '</div>' +
    '</div>' +
    (caption ? '<div class="scene-gallery-caption">' + caption + '</div>' : '');
}

function rowMediaHtml(row: Row): string {
  let imageBlock: string;
  const slots = rowSlots(row);
  const img = slots.length ? slots[0] : null;
  if (img) {
    imageBlock = rowGalleryHtml(row, slots);
  } else {
    imageBlock =
      '<button type="button" class="image-clip" data-action="image-add" data-id="' + row.id +
        '" title="Add a picture — or drag one anywhere onto this scene’s visual column">' +
        '<svg class="clip-icon" aria-hidden="true"><use href="#i-image"/></svg>Add picture</button>';
  }
  return '<div class="visual-media' + (img ? '' : ' is-empty') + '" data-id="' +
    row.id + '">' + imageBlock + '</div>';
}

function rowParts(row: Row, index: number): RowParts {
  return {
    cls: "row" + (row.status === "shot" ? " is-shot" : ""),
    gutter: rowGutterHtml(row, index),
    media: rowMediaHtml(row),
    visualText: rowFieldHtml(row, "visualText"),
    audioText: rowFieldHtml(row, "audioText")
  };
}

function rowHtmlFromParts(row: Row, p: RowParts): string {
  return (
    '<div class="' + p.cls + '" data-id="' + row.id + '">' +
      p.gutter +
      '<div class="cell visual-cell">' + p.visualText + p.media + '</div>' +
      '<div class="cell audio-cell">' + p.audioText + '</div>' +
      '<div class="row-rail"><button type="button" class="row-read" data-id="' + row.id + '"></button></div>' +
    '</div>'
  );
}

const ROW_SIG = "__splitpageRowSig";
const PATCHED_PARTS: readonly PatchedPart[] = ["gutter", "media", "visualText", "audioText"];

function childWithClass(el: Element | null, cls: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.classList.contains(cls)) return c;
  }
  return null;
}

function rowPartEl(rowEl: Element, part: PatchedPart): Element | null {
  if (part === "gutter") return childWithClass(rowEl, "gutter");
  if (part === "media") return childWithClass(childWithClass(rowEl, "visual-cell"), "visual-media");
  if (part === "visualText") return childWithClass(childWithClass(rowEl, "visual-cell"), "field-wrap");
  return childWithClass(childWithClass(rowEl, "audio-cell"), "field-wrap");
}

let partTemplate: HTMLTemplateElement | null = null;
function nodeFromHtml(html: string): Element {
  if (!partTemplate) partTemplate = document.createElement("template");
  partTemplate.innerHTML = html;
  return partTemplate.content.firstElementChild as Element;
}

function newRowEl(row: Row, index: number): SignedRow {
  const p = rowParts(row, index);
  const el: SignedRow = nodeFromHtml(rowHtmlFromParts(row, p));
  el[ROW_SIG] = p;
  el.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
  return el;
}

function resetRowShell(rowEl: Element, cls: string): void {
  if (rowEl.className !== cls) rowEl.className = cls;
  for (let i = rowEl.attributes.length - 1; i >= 0; i--) {
    const name = (rowEl.attributes[i] as Attr).name;
    if (name !== "class" && name !== "data-id") rowEl.removeAttribute(name);
  }
  const vc = childWithClass(rowEl, "visual-cell");
  if (vc && vc.className !== "cell visual-cell") vc.className = "cell visual-cell";
  const ac = childWithClass(rowEl, "audio-cell");
  if (ac && ac.className !== "cell audio-cell") ac.className = "cell audio-cell";
}

function planRowPatch(rowEl: SignedRow, row: Row, index: number): RowPatch | null {
  const sig = rowEl[ROW_SIG];
  if (!sig) return null;
  const p = rowParts(row, index);
  const parts: RowPatch["parts"][number][] = [];
  for (let i = 0; i < PATCHED_PARTS.length; i++) {
    const k = PATCHED_PARTS[i] as PatchedPart;
    if (sig[k] === p[k]) continue;
    const old = rowPartEl(rowEl, k);
    if (!old) return null;
    const fresh = nodeFromHtml(p[k]);
    if (k === "visualText" || k === "audioText") ensureTrailingCaretSpot(fresh.querySelector(".cell-editable"));
    parts.push({ key: k, el: old, fresh: fresh });
  }
  return { p: p, parts: parts };
}

function commitRowPatch(rowEl: SignedRow, patch: RowPatch): boolean {
  resetRowShell(rowEl, patch.p.cls);
  patch.parts.forEach(function (part) {
    const active = document.activeElement;
    const action = active && active !== part.el && part.el.contains(active) &&
      active.getAttribute && active.getAttribute("data-action");
    (part.el.parentNode as ParentNode & Node).replaceChild(part.fresh, part.el);
    if (part.key === "visualText" || part.key === "audioText") {
      cellsPainted++;
    } else if (action && !viewFlags().writerOpen()) {
      const again = part.fresh.querySelector('[data-action="' + cssAttr(action) + '"]');
      if (again) (again as HTMLElement).focus({ preventScroll: true });
    }
  });
  rowEl[ROW_SIG] = patch.p;
  if (patch.parts.length) rowsPainted++;
  return patch.parts.length > 0;
}

export function renderRow(rowId: string): boolean {
  return paintGuard().whilePainting(function () { return paintOneRow(rowId); });
}

function paintOneRow(rowId: string): boolean {
  const doc = currentDocument();
  if (!doc) return false;
  const idx = readSession(function (held) { return rowIndexOf(held, rowId); });
  const rowsEl = document.getElementById("rows");
  if (idx === -1 || !rowsEl) return false;
  const rowEl = rowsEl.querySelector(':scope > .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return false;
  const shown = doc.rows[idx] as Row;
  const patch = planRowPatch(rowEl, shown, idx);
  const whole = patch ? null : newRowEl(shown, idx);
  const active = document.activeElement;
  const heldCell = active && active.classList && active.classList.contains("cell-editable") && rowEl.contains(active) &&
    rememberCellSelection(editorSelection(), active) ? active : null;
  let touched = true;
  if (patch) touched = commitRowPatch(rowEl, patch);
  else {
    rowsEl.replaceChild(whole as SignedRow, rowEl);
    rowsPainted++;
    cellsPainted += 2;
  }
  if (heldCell && !heldCell.isConnected) placeEditorSelection(editorSelection(), rowsEl);
  if (touched) {
    paintRowTimes();
    announcePainted("row");
  }
  return true;
}

export function noteFieldPainted(cellEl: Element, field: string, row: Row): void {
  const rowEl: SignedRow | null = cellEl.closest(".row");
  const sig = rowEl ? rowEl[ROW_SIG] : undefined;
  if (!rowEl || !sig || !rowEl.parentNode || (rowEl.parentNode as Element).id !== "rows") return;
  if (rowEl.getAttribute("data-id") !== row.id) return;
  sig[field as TextField] = rowFieldHtml(row, field as TextField);
}

function markLongestIncreasing(positions: readonly number[], from: number, to: number, lo: number, hi: number, keep: boolean[]): void {
  const tails: number[] = [], tailAt: number[] = [], prev: Record<number, number> = {};
  for (let i = from; i < to; i++) {
    const p = positions[i] as number;
    if (p < 0 || p <= lo || p >= hi) continue;
    let a = 0, b = tails.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if ((tails[m] as number) < p) a = m + 1; else b = m;
    }
    prev[i] = a > 0 ? tailAt[a - 1] as number : -1;
    tails[a] = p;
    tailAt[a] = i;
  }
  let k = tails.length ? tailAt[tails.length - 1] as number : -1;
  while (k !== -1) { keep[k] = true; k = prev[k] as number; }
}

const EMPTY_ROWS_HTML =
  '<div class="empty-state">' +
    '<div>No rows yet. Each row pairs what is on screen with what gets said.</div>' +
    '<button class="btn btn-accent" type="button" data-action="add-row">+ Add your first row</button>' +
  '</div>';

function planRows(rowsEl: Element, doc: DocumentView): RowsPlan {
  if (!doc.rows.length) return { empty: true };
  const existing = new Map<string, SignedRow>();
  const drop: Element[] = [];
  Array.prototype.slice.call(rowsEl.children).forEach(function (el: SignedRow) {
    const key: string | null = rowMotionKey(el);
    const reusable = key && !existing.has(key) && (key.indexOf("strip:") === 0 || el[ROW_SIG]);
    if (reusable) existing.set(key as string, el);
    else drop.push(el);
  });

  const steps = shotHiding().groups(doc.rows).map(function (item): RowsStep {
    const strip = (item as Partial<ShotStrip>).strip;
    const entry = item as ShotRowEntry<Row>;
    const key = strip ? "strip:" + strip.join(",") : "row:" + entry.row.id;
    const el = existing.get(key);
    if (el) {
      existing.delete(key);
      if (strip) return { node: el };
      const patch = planRowPatch(el, entry.row, entry.index);
      if (patch) return { node: el, patch: patch };
      drop.push(el);
    }
    if (strip) return { node: nodeFromHtml(hiddenShotStripHtml(strip)) };
    return { node: newRowEl(entry.row, entry.index), added: true };
  });
  existing.forEach(function (el) { drop.push(el); });
  return { steps: steps, drop: drop };
}

function commitRows(rowsEl: Element, plan: RowsPlan, pinned: Element | null | undefined): void {
  if (plan.empty) {
    rowsEl.innerHTML = EMPTY_ROWS_HTML;
    return;
  }
  plan.drop.forEach(function (el) { if (el.parentNode === rowsEl) rowsEl.removeChild(el); });
  const nodes = plan.steps.map(function (step) {
    if (step.patch) commitRowPatch(step.node as SignedRow, step.patch);
    if (step.added) {
      rowsPainted++;
      cellsPainted += 2;
    }
    return step.node;
  });

  const at = new Map<Element, number>();
  for (let c = 0; c < rowsEl.children.length; c++) at.set(rowsEl.children[c] as Element, c);
  const positions = nodes.map(function (n) { return at.has(n) ? at.get(n) as number : -1; });
  const keep: boolean[] = [];
  const pin = pinned ? nodes.indexOf(pinned) : -1;
  const pinAt = pin !== -1 ? positions[pin] as number : -1;
  if (pin !== -1 && pinAt >= 0) {
    markLongestIncreasing(positions, 0, pin, -1, pinAt, keep);
    keep[pin] = true;
    markLongestIncreasing(positions, pin + 1, nodes.length, pinAt, Infinity, keep);
  } else {
    markLongestIncreasing(positions, 0, nodes.length, -1, Infinity, keep);
  }
  let next: Element | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i] as Element;
    if (!keep[i]) rowsEl.insertBefore(node, next);
    next = node;
  }

  let inOrder = rowsEl.children.length === nodes.length;
  for (let j = 0; inOrder && j < nodes.length; j++) inOrder = rowsEl.children[j] === nodes[j];
  if (!inOrder) nodes.forEach(function (n) { rowsEl.appendChild(n); });

  rowsEl.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
}

function captureRenderFocus(rowsEl: Element | null): RenderFocus | null {
  const active = document.activeElement;
  if (!active || !active.classList || !rowsEl || !rowsEl.contains(active)) return null;
  const out: RenderFocus = { cell: null, id: null, field: null, rowEl: null, sel: null };
  if (active.classList.contains("cell-editable")) {
    out.cell = active as HTMLElement;
    out.id = active.getAttribute("data-id");
    out.field = active.getAttribute("data-field");
  }
  const rowEl = active.closest(".row");
  if (rowEl && rowEl.parentNode === rowsEl) out.rowEl = rowEl;
  const sel = window.getSelection();
  if (out.cell && sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (active.contains(r.startContainer) && active.contains(r.endContainer)) {
      out.sel = { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
    }
  }
  return (out.cell || out.rowEl) ? out : null;
}

function restoreRenderFocus(rowsEl: Element, f: RenderFocus | null): void {
  if (!f || !f.cell) return;
  if (f.rowEl && rowsEl.contains(f.cell)) {
    if (document.activeElement === f.cell) return;
    f.cell.focus({ preventScroll: true });
    if (f.sel && f.cell.contains(f.sel.sc) && f.cell.contains(f.sel.ec)) {
      try {
        const keepRange = document.createRange();
        keepRange.setStart(f.sel.sc, f.sel.so);
        keepRange.setEnd(f.sel.ec, f.sel.eo);
        const keepSel = window.getSelection() as Selection;
        keepSel.removeAllRanges();
        keepSel.addRange(keepRange);
      } catch (e) {}
    }
    return;
  }
  placeEditorSelection(editorSelection(), rowsEl);
}

function resetTransientUiState(): void {
  deleteConfirmation().disarm("row");
  document.querySelectorAll("#rows .gutter-btn.danger.armed").forEach(disarmDeleteButton);
  deleteConfirmation().disarm("comment");
  deleteConfirmation().disarm("tag");
  setTagAddingPerson(null);
}

let renderCalls = 0;
let rowsPainted = 0;
let cellsPainted = 0;

export function syncPageTitle(): void {
  const name = (currentDocument()?.title || "").trim();
  document.title = !name || name === "Untitled Script" ? "Splitpage" : name + " — Splitpage";
}

let paintBroke = false;

export function render(): void {
  try {
    paintGuard().whilePainting(function () {
      try {
        paintAll();
      } catch (e) {
        paintBroke = true;
        throw e;
      }
    });
  } finally {
    paintBroke = false;
  }
}

const paintedListeners: ((kind: PaintKind) => void)[] = [];

export function onPainted(listener: (kind: PaintKind) => void): () => void {
  const listeners = paintedListeners;
  let removed = false;
  listeners.push(listener);
  return function () {
    if (removed) return;
    removed = true;
    const at = listeners.indexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  };
}

function announcePainted(kind: PaintKind): void {
  paintedListeners.slice().forEach(function (listener) { listener(kind); });
}

export function paintingScreen(): boolean {
  return paintGuard().painting();
}

function paintAll(): void {
  trackDocument();
  const doc = currentDocument();
  if (!doc) return;
  renderCalls++;
  const rowsEl = document.getElementById("rows") as HTMLElement;
  const plan = planRows(rowsEl, doc);
  const title = doc.title || "";

  resetTransientUiState();
  const focus = captureRenderFocus(rowsEl);
  if (focus && focus.cell) rememberCellSelection(editorSelection(), focus.cell);
  withRowMotion(rowsEl, function () {
    commitRows(rowsEl, plan, focus && focus.rowEl);
    announcePainted("rows");
  });
  editorSelection().notePainted(rowsEl);
  if (!viewFlags().writerOpen()) restoreRenderFocus(rowsEl, focus);

  const titleInput = document.getElementById("doc-title") as HTMLInputElement;
  if (document.activeElement !== titleInput) titleInput.value = title;
  syncPageTitle();
  paintRowTimes();
  announcePainted("screen");
  scheduleUntaggedScan();
  const link = editorSelection().heldLink();
  if (link && !link.cell.isConnected) editorSelection().dropLink();
  screen.drawn = true;
  screen.edit = editAllowed();
}

const REDRAW_FAILED = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";
const FIRST_DRAW_FAILED = "Could not draw the script. Nothing was lost — press Redraw before you start editing.";
let redrawToast: RedrawToast | null = null;
let screenStale = false;
let staleFocus: StalePlace | null = null;
const STALE_PARTS = "#rows, .add-row-bar, #doc-title, #writer-title, #writer-doc, #writer .wr-fmt, " +
  "#replace-input, #find-replace, #find-replace-all, #find-tag-go, #tag-ghost, #tag-suggest";
const STALE_EVENTS: readonly string[] = ["keydown", "beforeinput", "input", "paste", "cut", "drop", "dragstart",
  "compositionstart", "pointerdown", "mousedown", "click"];

function offerRedraw(failed: string): void {
  if (redrawToast && redrawToast.isConnected && !redrawToast.classList.contains("is-leaving")) return;
  const lifetime = activeRender;
  const toast = showActionToast(failed, "error", "Redraw", function () { if (activeRender === lifetime) absorbRender(failed); }, true) as RedrawToast;
  redrawToast = toast;
  toast.removeEventListener("click", toast.dismiss);
  toast.removeAttribute("title");
  toast.classList.add("is-held");
  toast.setAttribute("role", "alert");
}

function focusPlace(el: Element): StalePlace | null {
  const cellEl = el.closest(".cell-editable[data-id][data-field]");
  if (!cellEl) return el.id ? { id: el.id } : null;
  return { row: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field") };
}

function markStaleParts(on: boolean): void {
  document.querySelectorAll(STALE_PARTS).forEach(function (el) {
    el.toggleAttribute("inert", on);
    el.classList.toggle("is-stale-part", on);
  });
}

function holdStaleScreen(failed: string): void {
  const active = document.activeElement;
  const inPart = !!(active && active.closest && active.closest(STALE_PARTS));
  const onRedraw = !!(redrawToast && active && redrawToast.contains(active));
  if (!screenStale && inPart) staleFocus = focusPlace(active as Element);
  screenStale = true;
  document.body.classList.add("is-stale-screen");
  markStaleParts(true);
  offerRedraw(failed);
  if (inPart || onRedraw) ((redrawToast as RedrawToast).querySelector(".toast-action") as HTMLElement).focus();
}

function releaseStaleScreen(): void {
  if (!screenStale) return;
  screenStale = false;
  document.body.classList.remove("is-stale-screen");
  markStaleParts(false);
  const place = staleFocus;
  staleFocus = null;
  const active = document.activeElement;
  if (!place || (active && active !== document.body && !(redrawToast && redrawToast.contains(active)))) return;
  const target = place.id ? document.getElementById(place.id) : document.querySelector<HTMLElement>(
    '#rows .cell-editable[data-id="' + cssAttr(place.row) + '"][data-field="' + cssAttr(place.field) + '"]');
  if (!target) return;
  target.focus();
  if (place.id || document.activeElement !== target) return;
  const end = window.getSelection() as Selection;
  const caret = document.createRange();
  caret.selectNodeContents(target);
  caret.collapse(false);
  end.removeAllRanges();
  end.addRange(caret);
}

function refuseOnStaleScreen(e: Event): void {
  if (!screenStale) return;
  const t = e.target as Element | null;
  if (!(t && t.closest && t.closest(STALE_PARTS))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

export function screenIsStale(): boolean {
  return screenStale;
}

function absorbRender(failed: string): boolean {
  try {
    render();
    releaseStaleScreen();
    if (redrawToast && redrawToast.isConnected) redrawToast.dismiss();
    return true;
  } catch (e) {
    if (window.console) console.error(e);
    holdStaleScreen(failed);
    return false;
  }
}

export function renderAbsorbed(): boolean {
  return absorbRender(REDRAW_FAILED);
}

export function renderFirstDraw(): boolean {
  screen.drawn = true;
  return absorbRender(FIRST_DRAW_FAILED);
}

let screen = { drawn: false, edit: true };

const ABSORBED: Readonly<Record<string, true>> = { adopt: true, server: true, recovery: true, reload: true };

const ON_SCREEN_ALREADY: Readonly<Record<string, true>> = { visualText: true, audioText: true, updatedAt: true, updatedBy: true };

const ONE_ROW: Readonly<Record<string, true>> = { status: true, lengthSeconds: true, updatedAt: true, updatedBy: true };

const SHOWN_DOC_FIELDS: Readonly<Record<string, true>> = { title: true, wordsPerMinute: true, comments: true };

const TEXT_FIELDS: Readonly<Record<string, true>> = { visualText: true, audioText: true };

const SHOWN_PREFERENCES: Readonly<Record<string, true>> = { clock: true, commentAuthor: true, personColor: true };

function rowsTouched(cells: ChangeSet["cells"], skip: Readonly<Record<string, true>> | null): string[] {
  const ids: string[] = [];
  cells.forEach(function (cell) {
    if (skip && skip[cell.field]) return;
    if (ids.indexOf(cell.rowId) === -1) ids.push(cell.rowId);
  });
  return ids;
}

function paintRows(ids: readonly string[]): void {
  let all = true;
  ids.forEach(function (id) { if (!renderRow(id)) all = false; });
  if (!all) render();
}

function paintsWhole(change: ScreenChange): boolean {
  const c = change.changes;
  if (change.kind === "replay" || c.whole || c.rowsInserted.length || c.rowsRemoved.length || c.rowsMoved) return true;
  if (c.docFields.some(function (field) { return SHOWN_DOC_FIELDS[field]; })) return true;
  return change.kind !== "amend" && c.cells.some(function (cell) { return !ONE_ROW[cell.field]; });
}

function paintSessionChange(change: ScreenChange): void {
  if (!screen.drawn) return;
  if (ABSORBED[change.kind]) { absorbRender(REDRAW_FAILED); return; }
  if (screenStale || paintBroke) return;
  const c = change.changes;
  if (paintGuard().shown()) {
    const left = rowsTouched(c.cells, ON_SCREEN_ALREADY);
    if (left.length) {
      const lifetime = activeRender;
      paintGuard().afterShown(function () { if (activeRender === lifetime) paintRows(left); });
    }
    return;
  }
  if (change.kind === "replay") { undoGuard().whileApplying(render); return; }
  if (paintsWhole(change)) { render(); return; }
  const rows = rowsTouched(c.cells, null);
  if (rows.length) paintRows(rows);
  if (c.docFields.indexOf("productionTags") !== -1) paintProductionViews();
}

function paintProductionViews(): void {
  announcePainted("tags");
}

export function screenListeners(): ScreenListeners {
  screen.drawn = false;
  return {
    session: paintSessionChange,
    stamped: function (changes: ChangeSet) {
      if (!screen.drawn || screenStale || paintBroke) return;
      if (changes.docFields.indexOf("comments") !== -1 || changes.cells.some(function (cell) { return TEXT_FIELDS[cell.field]; })) render();
    },
    refresh: function (jobs: ReadonlySet<string>) {
      if (screen.drawn && jobs.has("production")) paintRowTimes();
    },
    hiding: function () {
      if (screen.drawn) render();
    },
    preference: function (name: string) {
      if (screen.drawn && SHOWN_PREFERENCES[name]) render();
    },
    location: function () {
      if (screen.drawn && editAllowed() !== screen.edit) render();
    },
    flag: function (change: ViewFlagChange) {
      if (screen.drawn && change.flag === "writerOpen" && !change.value) absorbRender(REDRAW_FAILED);
    }
  };
}

const FORMAT_MARKS: Readonly<Record<string, FormatMark>> = { bold: "b", italic: "i", underline: "u", strikeThrough: "s", highlight: "hl" };

function throughModel(cellEl: Element, fn: ModelEdit): Element | null {
  let ran = false;
  function run(cell: Run[], sel: CellRange | null, media?: DraftMedia) {
    ran = true;
    return fn(cell, sel, media);
  }
  const fresh = isScriptCell(cellEl) ? cellEditing().edit(cellEl, run) : isDraftBox(cellEl) ? editDraft(cellEl, run) : null;
  return ran ? (fresh || cellEl) : null;
}

let pendingMarks: PendingMarks | null = null;

function pendingAt(cellEl: Element, pos: number): PendingMarks["marks"] | null {
  return pendingMarks && pendingMarks.cell === cellEl && pendingMarks.pos === pos ? pendingMarks.marks : null;
}

function marksForTyping(cellEl: Element, cell: Run[], pos: number): Marks {
  const m = typingMarks(cell, pos);
  const p = pendingAt(cellEl, pos);
  if (p) (Object.keys(p) as FormatMark[]).forEach(function (k) { if (p[k]) m[k] = true; else Reflect.deleteProperty(m, k); });
  return m;
}

function togglePendingMark(cellEl: Element, cell: Run[], pos: number, mark: FormatMark): void {
  const p = pendingAt(cellEl, pos) || {};
  const on = !marksForTyping(cellEl, cell, pos)[mark];
  if (on === !!typingMarks(cell, pos)[mark]) Reflect.deleteProperty(p, mark); else p[mark] = on;
  pendingMarks = Object.keys(p).length ? { cell: cellEl, pos: pos, marks: p } : null;
}

export function forgetStalePendingMarks(): void {
  if (!pendingMarks) return;
  const c = pendingMarks.cell;
  const sel = c.isConnected && document.activeElement === c ? cellSelection(c) : null;
  if (!sel || sel.from !== sel.to || sel.from !== pendingMarks.pos) pendingMarks = null;
}

export function typePendingMarks(cellEl: Element, text: string): Element | null {
  if (!pendingMarks || pendingMarks.cell !== cellEl || !text) return null;
  let typed = false;
  const fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to || !pendingAt(cellEl, sel.from)) return null;
    const from = clamp(cell, sel.from);
    const after = projection(cell).charAt(from);
    const t = / $/.test(text) && (after === "" || after === "\n") ? text.slice(0, -1) + " " : text;
    const next = insertText(cell, from, t, marksForTyping(cellEl, cell, from));
    const at = from + cellLength(next) - cellLength(cell);
    typed = true;
    return { cell: next, sel: { from: at, to: at } };
  });
  pendingMarks = null;
  return typed ? fresh : null;
}

export function toggleCellFormat(cellEl: Element, cmd: string): Element | null {
  const mark = FORMAT_MARKS[cmd];
  if (!mark) return null;
  return throughModel(cellEl, function (cell, sel, media) {
    if (!sel) return null;
    if (sel.from === sel.to) {
      togglePendingMark(cellEl, cell, sel.from, mark);
      return null;
    }
    pendingMarks = null;
    const next = media ? media.toggleMark(cell, sel.from, sel.to, mark) : toggleMark(cell, sel.from, sel.to, mark);
    return { cell: next, sel: sel };
  });
}

export function isDirectionCell(cellEl: Element): boolean {
  return isScriptCell(cellEl) && cellEl.getAttribute("data-field") === "audioText";
}

export function toggleCellDirection(cellEl: Element): Element | null {
  if (!isDirectionCell(cellEl)) return null;
  let said = false;
  const fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel) return null;
    if (sel.from === sel.to) {
      const r = directionRangeAt(cell, sel.from);
      if (!r) { said = true; return null; }
      return { cell: setMark(cell, r.from, r.to, "dir", false), sel: sel };
    }
    pendingMarks = null;
    const span = directionToggleRange(cell, sel.from, sel.to);
    return { cell: toggleDirection(cell, sel.from, sel.to), sel: span.off || span.from === span.to ? sel : span };
  });
  if (said || !fresh) {
    showToast("Select the words of a stage direction first — or type ((like this)).", "warn");
    return null;
  }
  return fresh;
}

export function maybeDirectionShortcut(e: InputEvent, cellEl: Element): void {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ")") return;
  if (!isDirectionCell(cellEl)) return;
  const s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return;
  const r = s.getRangeAt(0);
  const node = r.startContainer, offset = r.startOffset;
  if (node.nodeType !== 3 || offset < 2 || (node as Text).data.slice(offset - 2, offset) !== "))") return;
  if ((cellEl.textContent as string).indexOf("((") === -1) return;
  cellEditing().edit(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to) return null;
    const got = directionShortcut(cell, sel.from);
    return got ? { cell: got.cell, sel: { from: got.end, to: got.end } } : null;
  });
}

const CUE_HINT_RE = /(sfx|music)[ \t\u00a0]*:$/i;

export function maybeCueShortcut(e: InputEvent, cellEl: Element): void {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ":") return;
  if (!isDirectionCell(cellEl)) return;
  const s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return;
  const r = s.getRangeAt(0);
  const node = r.startContainer, offset = r.startOffset;
  if (node.nodeType !== 3 || !CUE_HINT_RE.test((node as Text).data.slice(0, offset).replace(/\u200B/g, ""))) return;
  cellEditing().edit(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to) return null;
    const next = cueShortcut(cell, sel.from);
    return next ? { cell: next, sel: sel } : null;
  });
}

function holdsDirection(n: Node | undefined): boolean {
  return !!(n && n.nodeType === 1 && ((n as Element).classList.contains("stage-dir") || (n as Element).querySelector(".stage-dir")));
}

export function typeAtDirectionEdge(cellEl: Element, text: string): Element | null {
  if (!text || !isDirectionCell(cellEl)) return null;
  const s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return null;
  const range = s.getRangeAt(0);
  const node = range.startContainer, offset = range.startOffset;
  if (!cellEl.contains(node)) return null;
  const el = (node.nodeType === 3 ? node.parentNode : node) as Element | null;
  const inSpan = !!(el && el.closest && el.closest(".stage-dir"));
  const between = node.nodeType === 1 && (holdsDirection(node.childNodes[offset - 1]) || holdsDirection(node.childNodes[offset]));
  if (!inSpan && !between) return null;
  const at0 = cellSelection(cellEl);
  if (!at0 || at0.from !== at0.to || insideDirection(fromHtml(storedHtmlFromDom(cellEl.innerHTML)), at0.from)) return null;
  let typed = false;
  const fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to || insideDirection(cell, sel.from)) return null;
    const from = clamp(cell, sel.from);
    const after = projection(cell).charAt(from);
    const t = / $/.test(text) && (after === "" || after === "\n") ? text.slice(0, -1) + " " : text;
    const next = insertText(cell, from, t, marksForTyping(cellEl, cell, from));
    const at = from + cellLength(next) - cellLength(cell);
    typed = true;
    return { cell: next, sel: { from: at, to: at } };
  });
  pendingMarks = null;
  return typed ? fresh : null;
}

export function cellFormatState(cellEl: Element): Record<string, boolean> | null {
  let read: () => { cell: Run[]; media: DraftMedia | null };
  if (isScriptCell(cellEl)) {
    const html = storedHtmlFromDom(cellEl.innerHTML);
    if (/<img|video-embed-card/.test(html)) return null;
    read = function () { return { cell: fromHtml(html), media: null }; };
  } else if (isDraftBox(cellEl)) {
    read = function () { return draftModel(cellEl); };
  } else {
    return null;
  }
  const out: Record<string, boolean> = {};
  const sel = cellSelection(cellEl);
  if (!sel) return out;
  const m = read();
  const typing = sel.from === sel.to ? marksForTyping(cellEl, m.cell, sel.from) : null;
  Object.keys(FORMAT_MARKS).forEach(function (cmd) {
    const k = FORMAT_MARKS[cmd] as FormatMark;
    if (typing) out[cmd] = !!typing[k];
    else out[cmd] = m.media ? m.media.markThroughout(m.cell, sel.from, sel.to, k) : markThroughout(m.cell, sel.from, sel.to, k);
  });
  if (!m.media) {
    out.direction = sel.from === sel.to ? !!directionRangeAt(m.cell, sel.from)
      : markThroughout(m.cell, sel.from, sel.to, "dir");
  }
  return out;
}

export function insertLineBreak(cellEl: Element): Element {
  return throughModel(cellEl, function (cell, sel) {
    if (!sel) return null;
    const b = breakLine(cell, sel.from, sel.to);
    return { cell: b.cell, sel: { from: b.pos, to: b.pos } };
  }) || cellEl;
}

export function updateToolbarState(cellEl: Element): void {
  const wrap = cellEl.closest(".field-wrap");
  if (!wrap) return;
  const toolbar = wrap.querySelector(".mini-toolbar");
  if (!toolbar) return;
  const model = toolbar.querySelector('[data-cmd="bold"]') ? cellFormatState(cellEl) : null;
  ["bold", "italic", "underline", "strikeThrough"].forEach(function (cmd) {
    const btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  const hiBtn = toolbar.querySelector('[data-cmd="highlight"]');
  if (hiBtn) hiBtn.classList.toggle("is-active", !!(model && model.highlight));
  const dirBtn = toolbar.querySelector('[data-cmd="direction"]');
  if (dirBtn) dirBtn.classList.toggle("is-active", !!(model && model.direction));
}

export function handleToolbarCmd(btn: Element): void {
  const wrap = btn.closest(".field-wrap") as Element;
  const cellEl = wrap.querySelector(".cell-editable") as HTMLElement;
  const cmd = btn.getAttribute("data-cmd") as string;
  cellEl.focus();
  if (FORMAT_MARKS[cmd]) {
    updateToolbarState(toggleCellFormat(cellEl, cmd) || cellEl);
    return;
  }
  if (cmd === "direction") {
    updateToolbarState(toggleCellDirection(cellEl) || cellEl);
    return;
  }
  if (cmd === "link") {
    const sel = window.getSelection() as Selection;
    if (!sel.rangeCount || sel.isCollapsed || !rangeInside(sel.getRangeAt(0), cellEl)) {
      showToast("Select some text inside one cell, then add a link.", "warn");
      return;
    }
    editorSelection().holdLink(sel.getRangeAt(0).cloneRange(), cellEl);
    const popover = wrap.querySelector(".link-popover") as HTMLElement;
    popover.hidden = false;
    const input = popover.querySelector("input") as HTMLInputElement;
    input.value = "";
    input.focus();
    return;
  }
  if (cmd === "comment") {
    const csel = window.getSelection() as Selection;
    if (!csel.rangeCount || csel.isCollapsed || !rangeInside(csel.getRangeAt(0), cellEl)) {
      showToast("Select some text inside one cell, then add a comment.", "warn");
      return;
    }
    const quotedText = csel.toString();
    const cRange = csel.getRangeAt(0);
    const cmtId = makeId("c");
    let anchorSpanEl: HTMLElement;
    try {
      anchorSpanEl = wrapRangeInComment(cRange, cmtId);
    } catch (e) {
      showToast("Could not anchor a comment to that selection.", "error");
      return;
    }
    csel.removeAllRanges();
    const afterC = document.createRange();
    afterC.setStartAfter(anchorSpanEl);
    afterC.collapse(true);
    csel.addRange(afterC);
    cellEditing().sync(cellEl);
    appActions.invoke("comment-on-selection", "button", {
      id: cmtId,
      rowId: cellEl.getAttribute("data-id"),
      field: cellEl.getAttribute("data-field"),
      quotedText: quotedText
    });
    return;
  }
  if (cmd === "tag") {
    const tsel = window.getSelection() as Selection;
    if (!tsel.rangeCount || tsel.isCollapsed || !rangeInside(tsel.getRangeAt(0), cellEl)) {
      showToast("Select the words you want to label first.", "warn");
      return;
    }
    const tagQuoted = tsel.toString().trim();
    const tagRange = tsel.getRangeAt(0);
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(cellEl);
    beforeRange.setEnd(tagRange.startContainer, tagRange.startOffset);
    const beforeDiv = document.createElement("div");
    beforeDiv.appendChild(beforeRange.cloneContents());
    const tagOccurrenceIndex = tagQuoted
      ? tagFieldOccurrences(beforeDiv.innerHTML, tagQuoted, "x", "x", true).hits
      : 0;
    appActions.invoke("tag-selection", "button", {
      rowId: cellEl.getAttribute("data-id"),
      field: cellEl.getAttribute("data-field"),
      quotedText: tagQuoted,
      occurrenceIndex: tagOccurrenceIndex
    });
    return;
  }
  if (cmd === "image") {
    (document.getElementById("comment-image-input") as HTMLElement).click();
    return;
  }
  if (cmd === "video") {
    const vpopover = wrap.querySelector<HTMLElement>(".video-popover");
    if (vpopover) {
      vpopover.hidden = false;
      const vinput = vpopover.querySelector("input") as HTMLInputElement;
      vinput.value = "";
      vinput.focus();
    }
    return;
  }
}

function rangeInside(range: Range | null, el: Element | null): boolean {
  if (!range || !el) return false;
  return el.contains(range.startContainer) && el.contains(range.endContainer) &&
         el.contains(range.commonAncestorContainer);
}

export function confirmLink(wrap: Element | null): void {
  if (!wrap) return;
  const popover = wrap.querySelector(".link-popover") as HTMLElement;
  const input = popover.querySelector("input") as HTMLInputElement;
  let url = (input.value || "").trim();
  const owner = wrap.querySelector(".cell-editable");
  const link = editorSelection().heldLink();
  if (!url || !link || link.cell !== owner || !document.contains(link.cell)) {
    popover.hidden = true;
    editorSelection().dropLink();
    return;
  }
  if (!/^https?:\/\//i.test(url) && url.indexOf("mailto:") !== 0) url = "https://" + url;
  const cellEl = link.cell as HTMLElement;
  const saved = link.range;
  popover.hidden = true;
  editorSelection().dropLink();
  cellEl.focus();
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(saved);
  const linked = throughModel(cellEl, function (cell, s) {
    if (!s || s.from === s.to) return null;
    return { cell: setMark(cell, s.from, s.to, "href", url), sel: { from: s.to, to: s.to } };
  });
  if (linked) caretOutOfLinkEnd(linked);
}

function caretOutOfLinkEnd(cellEl: Element): void {
  const sel = window.getSelection() as Selection;
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const node = (r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer) as Element | null;
  const a = node && node.closest ? node.closest("a") : null;
  if (!a || !cellEl.contains(a)) return;
  const rest = document.createRange();
  rest.selectNodeContents(a);
  rest.setStart(r.startContainer, r.startOffset);
  if (rest.toString().replace(/\u200B/g, "")) return;
  const after = document.createRange();
  after.setStartAfter(a);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}

export function cancelLink(wrap: Element | null): void {
  if (!wrap) return;
  (wrap.querySelector(".link-popover") as HTMLElement).hidden = true;
  editorSelection().dropLink();
}

function wrapRangeInComment(range: Range, cmtId: string): HTMLElement {
  const frag = range.extractContents();
  const span = document.createElement("span");
  span.className = "cmt-anchor";
  span.setAttribute("data-cmt", cmtId);
  span.appendChild(frag);
  range.insertNode(span);
  return span;
}

export function confirmVideo(wrap: Element | null): void {
  if (!wrap) return;
  const popover = wrap.querySelector(".video-popover") as HTMLElement;
  const input = popover.querySelector("input") as HTMLInputElement;
  let url = (input.value || "").trim();
  popover.hidden = true;
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const card = sanitizeHtml(buildVideoCardEl(url).outerHTML);
  if (card) appendDraftMedia(wrap.querySelector(".cell-editable") as Element, card);
}

export function cancelVideo(wrap: Element | null): void {
  if (!wrap) return;
  (wrap.querySelector(".video-popover") as HTMLElement).hidden = true;
}

export function startRowsRender(ports: Ports) {
  currentDocument = ports.document.current;
  readSession = ports.document.read;
  editAllowed = ports.edits.allowed;
  sanitizeHtml = ports.text.sanitizeHtml;
  storedHtmlFromDom = ports.text.storedHtmlFromDom;
  fromHtml = ports.text.fromHtml;
  productionReaders = ports.text.productionReaders;
  buildVideoCardEl = ports.video.card;
  videoHostLabel = ports.video.hostLabel;
  cellEditing = ports.editing.cells;
  editorSelection = ports.editing.selection;
  paintGuard = ports.editing.paint;
  undoGuard = ports.editing.undo;
  appendDraftMedia = ports.draft.appendMedia;
  draftModel = ports.draft.model;
  editDraft = ports.draft.edit;
  isDraftBox = ports.draft.isDraft;
  isScriptCell = ports.draft.isScript;
  trackDocument = ports.undo.track;
  shotHiding = ports.hiding;
  blobImgHtml = ports.pictures.imgHtml;
  personColors = ports.personColors;
  preferences = ports.preferences;
  viewFlags = ports.view;
  showToast = ports.notices.show;
  showActionToast = ports.notices.showAction;
  appActions = ports.actions;
  deleteConfirmation = ports.deletes;
  setTagAddingPerson = ports.tagPanel.setTagAddingPerson;
  makeId = ports.ids.id;
  productionIndexStats = ports.production.stats;
  resetProductionIndexStats = ports.production.resetStats;
  scheduleUntaggedScan = ports.production.scan;
  tagFieldOccurrences = ports.production.occurrences;
  let disposed = false;
  const mine = {};
  activeRender = mine;
  const renderTest: RenderTest = (window as RenderWindow).__renderTest = {
    render: render,
    counts: function () {
      if (disposed) return null;
      const p = productionIndexStats();
      return { render: renderCalls, rowsPainted: rowsPainted, cellsPainted: cellsPainted,
               productionDerived: p.derived, idleFlushes: p.flushes };
    },
    reset: function () {
      if (disposed) return;
      renderCalls = 0;
      rowsPainted = 0;
      cellsPainted = 0;
      resetProductionIndexStats();
    }
  };
  STALE_EVENTS.forEach(function (type) { window.addEventListener(type, refuseOnStaleScreen, true); });
  return {
    paintRowTimes: paintRowTimes,
    gallerySlotPictureHtml: gallerySlotPictureHtml,
    galleryBadgeHtml: galleryBadgeHtml,
    galleryVideoLinks: galleryVideoLinks,
    renderRow: renderRow,
    noteFieldPainted: noteFieldPainted,
    syncPageTitle: syncPageTitle,
    render: render,
    onPainted: onPainted,
    paintingScreen: paintingScreen,
    screenIsStale: screenIsStale,
    renderAbsorbed: renderAbsorbed,
    renderFirstDraw: renderFirstDraw,
    screenListeners: screenListeners,
    forgetStalePendingMarks: forgetStalePendingMarks,
    typePendingMarks: typePendingMarks,
    toggleCellFormat: toggleCellFormat,
    isDirectionCell: isDirectionCell,
    toggleCellDirection: toggleCellDirection,
    maybeDirectionShortcut: maybeDirectionShortcut,
    maybeCueShortcut: maybeCueShortcut,
    typeAtDirectionEdge: typeAtDirectionEdge,
    cellFormatState: cellFormatState,
    insertLineBreak: insertLineBreak,
    updateToolbarState: updateToolbarState,
    handleToolbarCmd: handleToolbarCmd,
    confirmLink: confirmLink,
    cancelLink: cancelLink,
    confirmVideo: confirmVideo,
    cancelVideo: cancelVideo,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      renderTest.render = function () {};
      if (activeRender !== mine) return;
      activeRender = null;
      STALE_EVENTS.forEach(function (type) { window.removeEventListener(type, refuseOnStaleScreen, true); });
      if (redrawToast) redrawToast.dismiss();
      redrawToast = null;
      screenStale = false;
      staleFocus = null;
      document.body.classList.remove("is-stale-screen");
      markStaleParts(false);
      pendingMarks = null;
      partTemplate = null;
      paintBroke = false;
      screen = { drawn: false, edit: true };
      renderCalls = rowsPainted = cellsPainted = 0;
      if ((window as RenderWindow).__renderTest === renderTest) delete (window as RenderWindow).__renderTest;
      (currentDocument as unknown) = null;
      (readSession as unknown) = null;
      (editAllowed as unknown) = null;
      (sanitizeHtml as unknown) = null;
      (storedHtmlFromDom as unknown) = null;
      (fromHtml as unknown) = null;
      (productionReaders as unknown) = null;
      (buildVideoCardEl as unknown) = null;
      (videoHostLabel as unknown) = null;
      (cellEditing as unknown) = null;
      (editorSelection as unknown) = null;
      (paintGuard as unknown) = null;
      (undoGuard as unknown) = null;
      (appendDraftMedia as unknown) = null;
      (draftModel as unknown) = null;
      (editDraft as unknown) = null;
      (isDraftBox as unknown) = null;
      (isScriptCell as unknown) = null;
      (trackDocument as unknown) = null;
      (shotHiding as unknown) = null;
      (blobImgHtml as unknown) = null;
      (personColors as unknown) = null;
      (preferences as unknown) = null;
      (viewFlags as unknown) = null;
      (showToast as unknown) = null;
      (showActionToast as unknown) = null;
      (appActions as unknown) = null;
      (deleteConfirmation as unknown) = null;
      (setTagAddingPerson as unknown) = null;
      (makeId as unknown) = null;
      (productionIndexStats as unknown) = null;
      (resetProductionIndexStats as unknown) = null;
      (scheduleUntaggedScan as unknown) = null;
      (tagFieldOccurrences as unknown) = null;
    }
  };
}
