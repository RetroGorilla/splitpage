import { annotateGallerySlot, moveGallerySlot, removeGallerySlot, rowSlots, setVideoThumbnail, videoLinkKey, videoLinkLabel } from "../../core/document/gallery.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { cssAttr } from "../common/dom.ts";
import { slotPoster } from "../common/gallery.ts";
import { formatVideoLength } from "../../../shared/text.ts";
import { embeddableVideo } from "../../../shared/video-embed.ts";

import type { GalleryOverlayMount, GalleryOverlayPorts } from "./ports.ts";
import type { Slot, VideoLink } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

type OverlayDocument = Pick<DocumentView, "rows">;
interface OverlayPortUse extends Omit<GalleryOverlayPorts, "document"> {
  readonly document: {
    readonly current: (...args: Parameters<GalleryOverlayPorts["document"]["current"]>) => OverlayDocument | Extract<ReturnType<GalleryOverlayPorts["document"]["current"]>, null | undefined>;
    readonly read: GalleryOverlayPorts["document"]["read"];
    readonly numbering: GalleryOverlayPorts["document"]["numbering"];
  };
}
interface GalleryView {
  rowId: string;
  sel: number;
  videos: boolean;
  playing: string | null;
  refused: string | null;
  fetching?: string | null;
}
interface GalleryZoom {
  w: number;
  h: number;
  s: number;
  x: number;
  y: number;
  full: boolean;
  pan: { id: number; sx: number; sy: number; x: number; y: number } | null;
  moved: boolean;
}
interface GalleryPlay {
  note?: string;
  can?: boolean;
  embed?: NonNullable<ReturnType<typeof embeddableVideo>>;
  file?: boolean;
}

let ports: GalleryOverlayPorts | null = null;
let view: GalleryView | null = null;
let returnFocus: HTMLElement | SVGElement | null = null;
let dragFrom = -1;

function modal() { return document.getElementById("gallery-modal") as HTMLElement; }

function rowOf(rowId: string | null) {
  const idx = (ports as OverlayPortUse).document.read(function (doc) { return rowIndexOf(doc, rowId); });
  return idx === -1 ? null : { row: ((ports as OverlayPortUse).document.current() as OverlayDocument).rows[idx], index: idx };
}

function shownSlots(slots: Slot[]) {
  const out: number[] = [];
  slots.forEach(function (s, i) { if (!(view as GalleryView).videos || s.links.length) out.push(i); });
  return out;
}

export function openGalleryOverlay(rowId: string | null, slot?: number, videosOnly?: boolean) {
  const got = rowOf(rowId);
  if (!got || !rowSlots(got.row).length) return;
  returnFocus = document.activeElement as HTMLElement | SVGElement | null;
  view = { rowId: rowId as string, sel: slot || 0, videos: !!videosOnly, playing: null, refused: null };
  const slots = rowSlots(got.row);
  const shown = shownSlots(slots);
  if (shown.indexOf((view as GalleryView).sel) === -1) (view as GalleryView).sel = shown.length ? shown[0] as number : 0;
  (document.getElementById("gallery-body") as HTMLElement).innerHTML = "";
  modal().hidden = false;
  paint();
  const picked = modal().querySelector<HTMLElement>(".scene-gallery-grid-tile.is-selected");
  if (picked) picked.focus({ preventScroll: true });
}

export function closeGalleryOverlay() {
  if (!view) return;
  closeZoom(true);
  const rowId = (view as GalleryView).rowId;
  view = null;
  modal().hidden = true;
  (document.getElementById("gallery-body") as HTMLElement).innerHTML = "";
  const back = returnFocus && returnFocus.isConnected && returnFocus !== document.body ? returnFocus
    : document.querySelector<HTMLElement>('#rows .scene-gallery[data-id="' + cssAttr(rowId) + '"] .scene-gallery-tile');
  if (back) back.focus({ preventScroll: true });
  returnFocus = null;
}

export function refreshGalleryOverlay() {
  if (!view) return;
  const got = rowOf((view as GalleryView).rowId);
  if (!got || !rowSlots(got.row).length) { closeGalleryOverlay(); return; }
  const hadFocus = modal().contains(document.activeElement);
  paint();
  if (zoom) {
    if (zoomSlots().indexOf((view as GalleryView).sel) === -1) closeZoom();
    else paintZoom();
    return;
  }
  if (hadFocus && !modal().contains(document.activeElement)) {
    const picked = modal().querySelector<HTMLElement>(".scene-gallery-grid-tile.is-selected");
    if (picked) picked.focus({ preventScroll: true });
  }
}

function plural(n: number, one: string) { return n + " " + one + (n === 1 ? "" : "s"); }

function paint() {
  const got = rowOf((view as GalleryView).rowId);
  const slots = rowSlots((got as { row: unknown; index: number; }).row);
  let shown = shownSlots(slots);
  if (!shown.length) { (view as GalleryView).videos = false; shown = shownSlots(slots); }
  if (shown.indexOf((view as GalleryView).sel) === -1) (view as GalleryView).sel = shown[Math.min(shown.length - 1, Math.max(0, (view as GalleryView).sel))] || 0;
  if ((view as GalleryView).sel >= slots.length) (view as GalleryView).sel = slots.length - 1;
  const n = slots.length;
  const pictures = slots.filter(function (s) { return (s.ref || s.dataUrl) && !slotPoster(s); }).length;
  let videos = 0;
  slots.forEach(function (s) { videos += s.links.length; });

  (document.getElementById("gallery-title") as HTMLElement).textContent = "Scene " + ((ports as OverlayPortUse).document.numbering().beats[(view as GalleryView).rowId]?.full ?? "") + " · Visual";
  const summary = [];
  if (pictures) summary.push(plural(pictures, "picture"));
  if (videos) summary.push(plural(videos, "video"));
  (document.getElementById("gallery-summary") as HTMLElement).innerHTML = escapeHtml(summary.join(" · ")) +
    ((view as GalleryView).videos ? ' — videos only <button type="button" class="scene-gallery-show-all" data-gact="all">Show all</button>' : '');

  const sel = (view as GalleryView).sel;
  const slot = slots[sel] as Slot;
  const poster = slotPoster(slot as Slot);
  const still = !!(slot.ref || slot.dataUrl);
  const pos = shown.indexOf(sel);
  const length = poster ? formatVideoLength(poster.duration) : "";
  const openLink = poster || slot.links[0] || null;
  const play = playState(poster);
  const playKey = play && play.can ? videoLinkKey(poster) : null;
  if ((view as GalleryView).playing && (view as GalleryView).playing !== playKey) (view as GalleryView).playing = null;
  const playing = !!(playKey && (view as GalleryView).playing === playKey);
  const stillKind = poster && poster.href ? "thumbnail" : "first frame";
  const about = (poster ? "Video " : "Picture ") + (sel + 1) + " of " + n +
    (poster ? ": " + videoLinkLabel(poster) + (length ? ", " + length : "") +
      (still ? ". " + stillKind.charAt(0).toUpperCase() + stillKind.slice(1) + " shown; " : ". No picture of it; ") +
      (play && play.can ? "Play plays it here; " : "") +
      (poster.href ? "Open link opens it in your browser" : "Open file plays it in your video player")
      : slot.name ? ": " + slot.name : "");
  let inner;
  if (playing) {
    inner = playerHtml(poster as VideoLink, play as GalleryPlay);
  } else {
    inner = (ports as OverlayPortUse).render.slotPictureHtml(slot) +
      (poster && !still && !(play && (play.note || play.can)) ? '<svg class="scene-gallery-preview-none" aria-hidden="true"><use href="#i-camera"/></svg>' : '') +
      '<span class="scene-gallery-position">' + (pos + 1) + ' / ' + shown.length + '</span>' +
      (poster ? '<span class="scene-gallery-kind"><svg aria-hidden="true"><use href="#i-play"/></svg>' +
        (still ? 'Video · ' + stillKind : 'Video') + '</span>' : '') +
      (length ? '<span class="scene-gallery-length">' + length + '</span>' : '') +
      (play && play.can ? playButtonHtml(poster as VideoLink, play) : '') +
      (play && play.note ? noteHtml(poster as VideoLink, play.note) : '');
  }
  const group = playing || (play && (play.can || play.note));
  const zoomable = !poster && still;
  const picHtml =
      '<div class="scene-gallery-preview-pic' + (poster ? ' is-video' : '') + (playing ? ' is-playing' : '') +
        (play && play.note ? ' has-note' : '') + (zoomable ? ' is-zoomable' : '') + '"' +
        (playing ? ' data-play="' + escapeHtml(playKey) + '"' : '') +
        (zoomable
          ? ' data-gact="zoom" role="button" tabindex="0" title="Show at full size" aria-label="' +
            escapeHtml(about + ". Shows it at full size") + '">'
          : ' role="' + (group ? 'group' : 'img') + '" aria-label="' + escapeHtml(about) + '">') +
        inner +
      '</div>';
  const preview =
    '<div class="scene-gallery-preview">' +
      '<button type="button" class="scene-gallery-step" data-gact="prev" aria-label="Previous"' + (shown.length < 2 ? ' disabled' : '') + '>' +
        '<svg class="is-flipped" aria-hidden="true"><use href="#i-chevron"/></svg></button>' +
      picHtml +
      '<button type="button" class="scene-gallery-step" data-gact="next" aria-label="Next"' + (shown.length < 2 ? ' disabled' : '') + '>' +
        '<svg aria-hidden="true"><use href="#i-chevron"/></svg></button>' +
    '</div>';

  const caption = slot.links.length
    ? slot.links.map(function (l) {
        return '<div class="scene-gallery-line"><span class="scene-gallery-host">' + escapeHtml((ports as OverlayPortUse).video.hostLabel(l)) + '</span>' +
          '<button type="button" class="scene-gallery-link' + (l.href ? '' : ' is-file') + '" data-gact="link" data-key="' +
          escapeHtml(videoLinkKey(l)) + '" title="' + escapeHtml(l.href || l.name) + '">' + escapeHtml(videoLinkLabel(l)) + '</button></div>';
      }).join("")
    : '<div class="scene-gallery-line is-name">' + escapeHtml(slot.name || (poster ? "" : "Picture " + (sel + 1))) + '</div>';
  const retry = poster && !still && embeddableVideo(poster) && (ports as OverlayPortUse).video.thumbnailsAllowed()
    ? '<button type="button" class="btn-outline" data-gact="retry-thumb" data-key="' + escapeHtml(videoLinkKey(poster)) + '"' +
      ((view as GalleryView).fetching === videoLinkKey(poster) ? ' disabled aria-busy="true"' : '') + '>Retry thumbnail</button>'
    : '';
  const annotate = poster || !slot.ref ? '' :
    '<button type="button" class="btn-outline" data-gact="annotate">' + PEN_ICON +
      (slot.annotation ? 'Edit annotations' : 'Annotate') + '</button>' +
    (slot.annotation ? '<button type="button" class="btn-outline" data-gact="unannotate" title="Go back to the picture as it was">Remove annotations</button>' : '');
  const buttons =
    (openLink ? openButtonHtml(openLink) : '') + retry + annotate +
    '<button type="button" class="btn-outline" data-gact="cover"' + (sel === 0 ? ' disabled' : '') + '>' + COVER_ICON + 'Make cover</button>' +
    '<button type="button" class="scene-gallery-remove" data-gact="remove">Remove</button>';
  const hint = shown.length < 2 ? '' :
    '<p class="scene-gallery-hint"><svg aria-hidden="true"><use href="#i-grip"/></svg>Drag to reorder</p>';
  const actions = hint || buttons
    ? '<div class="scene-gallery-actions">' + hint + '<div class="scene-gallery-buttons">' + buttons + '</div></div>'
    : '';

  let grid = '<ol class="scene-gallery-grid" aria-label="All pictures and videos">';
  shown.forEach(function (i, k) {
    const s = slots[i] as Slot;
    const p = slotPoster(s);
    grid += '<li><button type="button" class="scene-gallery-grid-tile' + (i === sel ? ' is-selected' : '') + (p ? ' is-video' : '') +
      '" data-gact="pick" data-slot="' + i + '" draggable="true"' +
      ' aria-label="' + escapeHtml((p ? "Video " : "Picture ") + (i + 1) + (p ? ": " + videoLinkLabel(p) : (s as Slot).name ? ": " + (s as Slot).name : "")) + '"' +
      (i === sel ? ' aria-current="true"' : '') + '>' +
      (ports as OverlayPortUse).render.slotPictureHtml(s) + (p ? (ports as OverlayPortUse).render.badgeHtml(false) : '') + '<span class="scene-gallery-num">' + (i + 1) + '</span></button></li>';
    if (!(view as GalleryView).videos && n > 4 && k === 2) {
      grid += '<li class="scene-gallery-divider" aria-hidden="true"><span>behind</span> ' +
        '<span class="scene-gallery-divider-count">+' + (n - 3) + '</span></li>';
    }
  });
  if (!(view as GalleryView).videos) {
    grid += '<li><button type="button" class="scene-gallery-grid-tile is-add" data-gact="add" aria-label="Add a picture">' +
      '<svg aria-hidden="true"><use href="#i-plus"/></svg></button></li>';
  }
  grid += '</ol>';
  const before = modal().querySelector<HTMLElement>(".scene-gallery-grid");
  const scrolled = before ? before.scrollTop : 0;
  const body = document.getElementById("gallery-body");
  const rest = '<div class="scene-gallery-preview-caption">' + caption + '</div>' + actions + grid;
  const livePic = playing ? (body as HTMLElement).querySelector<HTMLElement>(".scene-gallery-preview-pic.is-playing") : null;
  const livePreview = livePic && livePic.getAttribute("data-play") === playKey ? livePic.parentNode as HTMLElement | null : null;
  if (livePreview && livePreview.parentNode === body) {
    while (livePreview.previousSibling) (body as HTMLElement).removeChild(livePreview.previousSibling);
    while (livePreview.nextSibling) (body as HTMLElement).removeChild(livePreview.nextSibling);
    livePreview.insertAdjacentHTML("afterend", rest);
    Array.prototype.forEach.call(livePreview.querySelectorAll(".scene-gallery-step"), function (b: HTMLButtonElement) { b.disabled = shown.length < 2; });
    (livePic as HTMLElement).setAttribute("aria-label", about);
  } else {
    (body as HTMLElement).innerHTML = preview + rest;
  }
  const after = modal().querySelector<HTMLElement>(".scene-gallery-grid");
  (after as HTMLElement).scrollTop = scrolled;
  revealPicked(after);
}

const OPEN_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5"/></svg>';
const COVER_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="10" height="14" rx="1.5"/>' +
  '<rect x="16" y="5" width="4.5" height="6" rx="1"/><rect x="16" y="13" width="4.5" height="6" rx="1"/></svg>';
const PEN_ICON = '<svg aria-hidden="true"><use href="#i-pen"/></svg>';

function openButtonHtml(l: VideoLink) {
  const title = l.href
    ? "Opens " + videoLinkLabel(l) + ((ports as OverlayPortUse).desktop() ? " in your web browser" : " in a new tab")
    : "Plays " + l.name + " in your computer’s video player (desktop app)";
  return '<button type="button" class="btn-outline" data-gact="open" data-key="' + escapeHtml(videoLinkKey(l)) +
    '" title="' + escapeHtml(title) + '">' + OPEN_ICON + (l.href ? "Open link" : "Open file") + '</button>';
}

function playState(poster: VideoLink | null | undefined): GalleryPlay | null {
  if (!poster) return null;
  const key = videoLinkKey(poster);
  if (poster.href) {
    const v = embeddableVideo(poster);
    if (!v) return null;
    const why = (view as GalleryView).refused === key ? "The player couldn’t load here." : (ports as OverlayPortUse).video.embedRefusal(v);
    return why ? { note: why } : { can: true, embed: v };
  }
  if ((ports as OverlayPortUse).sessionVideos.has(poster)) return { can: true, file: true };
  return { note: "Only this video’s name is kept, so it can’t play here. Drop the file on this scene again to play it." };
}

function hostName(play: GalleryPlay) {
  return play.embed && play.embed.host === "vimeo" ? "Vimeo" : "YouTube";
}

function playButtonHtml(poster: VideoLink, play: GalleryPlay) {
  const label = videoLinkLabel(poster);
  const title = play.file ? "Play it here"
    : "Play it here. This loads " + hostName(play) + "’s player — nothing is asked of " + hostName(play) + " before you press play.";
  return '<button type="button" class="scene-gallery-playbtn" data-gact="play" aria-label="' + escapeHtml("Play " + label + " here") +
    '" title="' + escapeHtml(title) + '"><span aria-hidden="true"></span></button>';
}

function playerHtml(poster: VideoLink, play: GalleryPlay) {
  if (play.file) {
    const url = (ports as OverlayPortUse).sessionVideos.url(poster);
    return url ? '<video class="scene-gallery-player" src="' + escapeHtml(url) + '" controls autoplay playsinline></video>'
      : noteHtml(poster, "This video couldn’t be read here.");
  }
  const p = (ports as OverlayPortUse).video.playerSrc(play.embed);
  if (!p) return noteHtml(poster, "The player couldn’t load here.");
  return '<iframe class="scene-gallery-player" src="' + escapeHtml(p.src) + '" data-src="' + escapeHtml(p.real) + '"' +
    ' title="' + escapeHtml(hostName(play) + " player: " + videoLinkLabel(poster)) + '"' +
    ' allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin"' +
    ' sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"></iframe>';
}

function noteHtml(poster: VideoLink, text: string) {
  return '<div class="scene-gallery-note"><p>' + escapeHtml(text) + '</p>' +
    '<button type="button" class="btn-outline is-small" data-gact="open" data-key="' + escapeHtml(videoLinkKey(poster)) + '">' +
    OPEN_ICON + (poster.href ? "Open link" : "Open file") + '</button></div>';
}

function startPlaying() {
  const slot = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row)[(view as GalleryView).sel];
  const poster = slot && slotPoster(slot as Slot);
  const play = playState(poster);
  if (!play || !play.can) return;
  (view as GalleryView).playing = videoLinkKey(poster);
  paint();
  const player = modal().querySelector<HTMLElement>(".scene-gallery-player");
  if (player) { try { player.focus({ preventScroll: true }); } catch (e) { } }
}

function retryThumbnail() {
  const rowId = (view as GalleryView).rowId;
  const slot = rowSlots((rowOf(rowId) as { row: unknown; index: number; }).row)[(view as GalleryView).sel];
  const poster = slot && slotPoster(slot as Slot);
  if (!poster || !poster.href) return;
  const key = videoLinkKey(poster);
  const ctx = (ports as OverlayPortUse).ownership.capture();
  (view as GalleryView).fetching = key;
  paint();
  (ports as OverlayPortUse).video.fetchThumbnail(poster.href).then(function (rec) {
    if (view && (view as GalleryView).fetching === key) (view as GalleryView).fetching = null;
    if (!(ports as OverlayPortUse).ownership.stillOwns(ctx)) {
      if (view) refreshGalleryOverlay();
      return;
    }
    const done = rec && rowOf(rowId) && (ports as OverlayPortUse).cells.editGallery(rowId, "Thumbnail added", function (row) { return setVideoThumbnail(row, key, rec); });
    if (!done) (ports as OverlayPortUse).notices.show("Could not get this video’s thumbnail — you may be offline, or the video is private or gone.", "warn");
    if (view && (view as GalleryView).rowId === rowId) refreshGalleryOverlay();
  });
}

function revealPicked(grid: Element | null) {
  const tile = grid && grid.querySelector<HTMLElement>(".scene-gallery-grid-tile.is-selected");
  if (!tile) return;
  const g = grid.getBoundingClientRect();
  const t = tile.getBoundingClientRect();
  const room = 4;
  if (t.top - room < g.top) grid.scrollTop -= g.top - t.top + room;
  else if (t.bottom + room > g.bottom) grid.scrollTop += t.bottom - g.bottom + room;
}

export function announceGalleryEdit(msg: string, before: unknown) {
  const entry = (ports as OverlayPortUse).undo.last();
  (ports as OverlayPortUse).undo.breakCoalescing();
  if (!entry || entry === before) { (ports as OverlayPortUse).notices.show(msg, "ok"); return; }
  (ports as OverlayPortUse).notices.showAction(msg, "ok", "Undo", function () {
    if ((ports as OverlayPortUse).undo.last() === entry) (ports as OverlayPortUse).undo.undo();
    else (ports as OverlayPortUse).notices.show("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function pick(i: number) {
  (view as GalleryView).sel = i;
  paint();
  const picked = modal().querySelector<HTMLElement>(".scene-gallery-grid-tile.is-selected");
  if (picked) picked.focus({ preventScroll: true });
}

function step(by: number) {
  const slots = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row);
  const shown = shownSlots(slots);
  const k = shown.indexOf((view as GalleryView).sel);
  pick(shown[(k + by + shown.length) % shown.length] as number);
}

function moveTo(from: number, to: number) {
  if (from === to) return;
  const rowId = (view as GalleryView).rowId;
  if ((ports as OverlayPortUse).cells.editGallery(rowId, "Moved to " + (to + 1), function (row) { return moveGallerySlot(row, from, to); })) {
    (view as GalleryView).sel = to;
    refreshGalleryOverlay();
  }
}

function makeCover() {
  if (!(view as GalleryView).sel) return;
  const from = (view as GalleryView).sel;
  const rowId = (view as GalleryView).rowId;
  if ((ports as OverlayPortUse).cells.editGallery(rowId, "Made the cover", function (row) { return moveGallerySlot(row, from, 0); })) {
    (view as GalleryView).sel = 0;
    refreshGalleryOverlay();
  }
}

function removeSelected() {
  const at = (view as GalleryView).sel;
  const rowId = (view as GalleryView).rowId;
  const slot = rowSlots((rowOf(rowId) as { row: unknown; index: number; }).row)[at];
  const what = slotPoster(slot as Slot) ? "Video" : "Picture";
  (ports as OverlayPortUse).cells.editGallery(rowId, what + " removed", function (row) { return removeGallerySlot(row, at); });
  if (view) {
    (view as GalleryView).sel = Math.max(0, at - 1);
    refreshGalleryOverlay();
  }
}

function removeAnnotations() {
  const at = (view as GalleryView).sel;
  const slot = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row)[at];
  if (!slot || !slot.annotation) return;
  const original = slot.annotation.imageRef;
  if (!(ports as OverlayPortUse).cells.editGallery((view as GalleryView).rowId, "Annotations removed", function (row) { return annotateGallerySlot(row, at, null, original, []); })) {
    (ports as OverlayPortUse).notices.show("Could not go back to the original — the gallery already shows that picture.", "warn");
    return;
  }
  const btn = modal().querySelector<HTMLElement>('[data-gact="annotate"]');
  if (btn) btn.focus({ preventScroll: true });
}

function onClick(e: MouseEvent) {
  if ((e.target as Element) === modal()) { closeGalleryOverlay(); return; }
  const el = (e.target as Element).closest<HTMLButtonElement>("[data-gact]");
  if (!el || !view || el.disabled) return;
  const act = el.getAttribute("data-gact");
  if (act === "prev") step(-1);
  else if (act === "next") step(1);
  else if (act === "pick") pick(Number(el.getAttribute("data-slot")));
  else if (act === "cover") makeCover();
  else if (act === "remove") removeSelected();
  else if (act === "annotate") (ports as OverlayPortUse).actions.invoke("annotate-picture", "button", { rowId: (view as GalleryView).rowId, slot: (view as GalleryView).sel });
  else if (act === "unannotate") removeAnnotations();
  else if (act === "all") { (view as GalleryView).videos = false; paint(); }
  else if (act === "play") startPlaying();
  else if (act === "zoom") openZoom();
  else if (act === "retry-thumb") retryThumbnail();
  else if (act === "open" || act === "link") (ports as OverlayPortUse).actions.invoke("open-picture-link", "button", { rowId: (view as GalleryView).rowId, slot: (view as GalleryView).sel, key: el.getAttribute("data-key") });
  else if (act === "add") (ports as OverlayPortUse).pickPicture((view as GalleryView).rowId);
}

function onKeydown(e: KeyboardEvent) {
  if (!view) return;
  if (zoom) { onZoomKeydown(e); return; }
  if ((e.key === "Enter" || e.key === " ") && (e.target as Element) && (e.target as Element).classList &&
      (e.target as Element).classList.contains("is-zoomable") && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openZoom();
    return;
  }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeGalleryOverlay(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.target as Element) && (e.target as Element).classList && (e.target as Element).classList.contains("scene-gallery-player")) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const by = e.key === "ArrowRight" ? 1 : -1;
    if (e.shiftKey && !(view as GalleryView).videos) {
      const n = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row).length;
      const to = (view as GalleryView).sel + by;
      if (to >= 0 && to < n) moveTo((view as GalleryView).sel, to);
    } else if (!e.shiftKey) {
      step(by);
    }
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeSelected();
  }
}

function onDragStart(e: DragEvent) {
  const tile = (e.target as Element).closest && (e.target as Element).closest('.scene-gallery-grid-tile[data-gact="pick"]');
  if (!tile || !view) return;
  dragFrom = Number(tile.getAttribute("data-slot"));
  try { (e.dataTransfer as DataTransfer).effectAllowed = "move"; (e.dataTransfer as DataTransfer).setData("text/plain", ""); } catch (err) {}
}

function onDragOver(e: DragEvent) {
  if (dragFrom === -1) return;
  const tile = (e.target as Element).closest && (e.target as Element).closest('.scene-gallery-grid-tile[data-gact="pick"]');
  if (!tile) return;
  e.preventDefault();
  e.stopPropagation();
  try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch (err) {}
}

function onDrop(e: DragEvent) {
  if (dragFrom === -1) return;
  e.preventDefault();
  e.stopPropagation();
  const tile = (e.target as Element).closest && (e.target as Element).closest('.scene-gallery-grid-tile[data-gact="pick"]');
  const from = dragFrom;
  dragFrom = -1;
  if (tile && view) moveTo(from, Number(tile.getAttribute("data-slot")));
}

let zoom: GalleryZoom | null = null;
const ZOOM_PAD = 48;

function zoomEl() { return document.getElementById("gallery-zoom") as HTMLElement; }
function zoomStage() { return document.getElementById("gallery-zoom-stage") as HTMLElement; }

function zoomSlots() {
  if (!view) return [];
  const got = rowOf((view as GalleryView).rowId);
  if (!got) return [];
  const slots = rowSlots(got.row);
  return shownSlots(slots).filter(function (i) {
    const s = slots[i] as Slot;
    return !slotPoster(s) && !!((s as Slot).ref || (s as Slot).dataUrl);
  });
}

function openZoom() {
  if (!view || zoomSlots().indexOf((view as GalleryView).sel) === -1) return;
  zoom = { w: 0, h: 0, s: 1, x: 0, y: 0, full: false, pan: null, moved: false };
  zoomEl().hidden = false;
  paintZoom();
  zoomEl().focus({ preventScroll: true });
}

function closeZoom(quiet?: boolean) {
  if (!zoom) return;
  zoom = null;
  zoomEl().hidden = true;
  zoomStage().innerHTML = "";
  if (quiet) return;
  const pic = modal().querySelector<HTMLElement>(".scene-gallery-preview-pic.is-zoomable");
  if (pic) pic.focus({ preventScroll: true });
}

function paintZoom() {
  const slots = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row);
  const slot = slots[(view as GalleryView).sel] as Slot;
  const stage = zoomStage();
  stage.innerHTML = (ports as OverlayPortUse).render.slotPictureHtml(slot);
  const img = stage.querySelector<HTMLImageElement>("img") as HTMLImageElement;
  img.className = "scene-gallery-zoom-img";
  img.draggable = false;
  img.alt = (slot as Slot).name || "Picture " + ((view as GalleryView).sel + 1);
  (zoom as GalleryZoom).full = false;
  (zoom as GalleryZoom).w = (slot as Slot).ref ? ((slot as Slot).ref as ImageRef).width | 0 : 0;
  (zoom as GalleryZoom).h = (slot as Slot).ref ? ((slot as Slot).ref as ImageRef).height | 0 : 0;
  const measure = function () {
    if (!zoom || img !== zoomStage().querySelector<HTMLImageElement>("img")) return;
    if (img.naturalWidth) { (zoom as GalleryZoom).w = img.naturalWidth; (zoom as GalleryZoom).h = img.naturalHeight; }
    layoutZoom();
  };
  if (img.complete && img.naturalWidth) measure();
  else { img.addEventListener("load", measure); if ((zoom as GalleryZoom).w) layoutZoom(); }
}

function clampAxis(pos: number, size: number, room: number) {
  return size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos));
}

function fitScale() {
  const W = window.innerWidth, H = window.innerHeight;
  const pad = W < 600 ? 16 : ZOOM_PAD;
  return Math.min(1, (W - 2 * pad) / (zoom as GalleryZoom).w, (H - 2 * pad) / (zoom as GalleryZoom).h);
}

function layoutZoom(keep?: boolean) {
  if (!zoom || !(zoom as GalleryZoom).w || !(zoom as GalleryZoom).h) return;
  const fit = fitScale();
  const big = fit < 1;
  if (!big) (zoom as GalleryZoom).full = false;
  const s = (zoom as GalleryZoom).full ? 1 : fit;
  if (!keep) { (zoom as GalleryZoom).x = (window.innerWidth - (zoom as GalleryZoom).w * s) / 2; (zoom as GalleryZoom).y = (window.innerHeight - (zoom as GalleryZoom).h * s) / 2; }
  (zoom as GalleryZoom).s = s;
  (zoom as GalleryZoom).x = clampAxis((zoom as GalleryZoom).x, (zoom as GalleryZoom).w * s, window.innerWidth);
  (zoom as GalleryZoom).y = clampAxis((zoom as GalleryZoom).y, (zoom as GalleryZoom).h * s, window.innerHeight);
  const img = zoomStage().querySelector<HTMLImageElement>("img");
  if (img) {
    img.style.width = (zoom as GalleryZoom).w + "px";
    img.style.height = (zoom as GalleryZoom).h + "px";
    img.style.transform = "translate(" + (zoom as GalleryZoom).x + "px, " + (zoom as GalleryZoom).y + "px) scale(" + s + ")";
  }
  const stage = zoomStage();
  stage.classList.toggle("can-zoom-in", big && !(zoom as GalleryZoom).full);
  stage.classList.toggle("can-zoom-out", big && (zoom as GalleryZoom).full);
  zoomInfo();
}

function zoomInfo() {
  const slots = rowSlots((rowOf((view as GalleryView).rowId) as { row: unknown; index: number; }).row);
  const slot = slots[(view as GalleryView).sel] as Slot;
  const pics = zoomSlots();
  const parts = [];
  if ((zoom as GalleryZoom).w) parts.push('<span class="scene-gallery-zoom-dims">' + (zoom as GalleryZoom).w + ' × ' + (zoom as GalleryZoom).h + '</span>');
  if ((slot as Slot).name) parts.push('<span class="scene-gallery-zoom-name">' + escapeHtml((slot as Slot).name) + '</span>');
  if ((zoom as GalleryZoom).w) parts.push('<span>' + Math.round((zoom as GalleryZoom).s * 100) + '%</span>');
  if (pics.length > 1) parts.push('<span>' + (pics.indexOf((view as GalleryView).sel) + 1) + ' / ' + pics.length + '</span>');
  (document.getElementById("gallery-zoom-info") as HTMLElement).innerHTML = parts.join('<span aria-hidden="true">·</span>');
}

function zoomTo(full: boolean, px: number, py: number) {
  if (!zoom || !(zoom as GalleryZoom).w || fitScale() >= 1 || (zoom as GalleryZoom).full === full) return;
  const s1 = full ? 1 : fitScale();
  const u = (px - (zoom as GalleryZoom).x) / (zoom as GalleryZoom).s, v = (py - (zoom as GalleryZoom).y) / (zoom as GalleryZoom).s;
  (zoom as GalleryZoom).full = full;
  (zoom as GalleryZoom).x = px - u * s1;
  (zoom as GalleryZoom).y = py - v * s1;
  const stage = zoomStage();
  stage.classList.add("is-animating");
  clearTimeout((zoomTo as typeof zoomTo & { t?: ReturnType<typeof setTimeout> }).t);
  (zoomTo as typeof zoomTo & { t?: ReturnType<typeof setTimeout> }).t = setTimeout(function () { stage.classList.remove("is-animating"); }, 260);
  layoutZoom(true);
}

function zoomStep(by: number) {
  const pics = zoomSlots();
  if (pics.length < 2) return;
  const k = pics.indexOf((view as GalleryView).sel);
  (view as GalleryView).sel = pics[(k + by + pics.length) % pics.length] as number;
  paint();
  paintZoom();
}

function onZoomKeydown(e: KeyboardEvent) {
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); e.stopPropagation(); closeZoom(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (k === "ArrowLeft" || k === "ArrowRight") {
    e.preventDefault();
    zoomStep(k === "ArrowRight" ? 1 : -1);
  } else if ((k === "Enter" || k === " ") && (e.target as Element) === zoomEl()) {
    e.preventDefault();
    zoomTo(!(zoom as GalleryZoom).full, window.innerWidth / 2, window.innerHeight / 2);
  } else if (k === "Tab") {
    e.preventDefault();
    const close = document.getElementById("gallery-zoom-close");
    ((document.activeElement === close ? zoomEl() : close) as HTMLElement).focus({ preventScroll: true });
  }
}

function onZoomClick(e: MouseEvent) {
  e.stopPropagation();
  if (!zoom) return;
  if ((zoom as GalleryZoom).moved) { (zoom as GalleryZoom).moved = false; return; }
  if ((e.target as Element).closest("#gallery-zoom-close")) { closeZoom(); return; }
  if ((e.target as Element).classList.contains("scene-gallery-zoom-img") && fitScale() < 1) {
    zoomTo(!(zoom as GalleryZoom).full, e.clientX, e.clientY);
    return;
  }
  if ((e.target as Element).classList.contains("scene-gallery-zoom-img")) return;
  closeZoom();
}

function onZoomWheel(e: WheelEvent) {
  if (!zoom) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomTo(true, e.clientX, e.clientY);
  else if (e.deltaY > 0) zoomTo(false, e.clientX, e.clientY);
}

function onZoomPointerDown(e: PointerEvent) {
  if (!zoom || !(zoom as GalleryZoom).full || e.button !== 0 || !(e.target as Element).classList.contains("scene-gallery-zoom-img")) return;
  e.preventDefault();
  (zoom as GalleryZoom).pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: (zoom as GalleryZoom).x, y: (zoom as GalleryZoom).y };
  zoomStage().classList.remove("is-animating");
  (zoom as GalleryZoom).moved = false;
}

function onZoomPointerMove(e: PointerEvent) {
  if (!zoom || !(zoom as GalleryZoom).pan || e.pointerId !== ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).id) return;
  const dx = e.clientX - ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).sx, dy = e.clientY - ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).sy;
  if (!(zoom as GalleryZoom).moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!(zoom as GalleryZoom).moved) {
    try { zoomStage().setPointerCapture(e.pointerId); } catch (err) {}
  }
  (zoom as GalleryZoom).moved = true;
  zoomStage().classList.add("is-dragging");
  (zoom as GalleryZoom).x = ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).x + dx;
  (zoom as GalleryZoom).y = ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).y + dy;
  layoutZoom(true);
}

function onZoomPointerUp(e: PointerEvent) {
  if (!zoom || !(zoom as GalleryZoom).pan || e.pointerId !== ((zoom as GalleryZoom).pan as { id: number; sx: number; sy: number; x: number; y: number; }).id) return;
  (zoom as GalleryZoom).pan = null;
  zoomStage().classList.remove("is-dragging");
}

export function startGalleryOverlay(given: GalleryOverlayPorts): GalleryOverlayMount {
  ports = given;
  view = null;
  returnFocus = null;
  dragFrom = -1;
  zoom = null;
  const offs: (() => void)[] = [];
  let disposed = false;
  const owner = { dispose: function () {
    if (disposed) return;
    disposed = true;
    while (offs.length) (offs.pop() as () => void)();
    ports = null;
  } };
  function listen<K extends keyof GlobalEventHandlersEventMap>(target: HTMLElement | Document | Window, type: K, fn: (event: GlobalEventHandlersEventMap[K]) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn as EventListener, opts);
    offs.push(function () { target.removeEventListener(type, fn as EventListener, opts); });
  }
  const m = modal();
  if (!m) return owner;
  listen(m, "click", onClick);
  listen(m, "keydown", onKeydown);
  listen(m, "dragstart", onDragStart);
  listen(m, "dragover", onDragOver);
  listen(m, "drop", onDrop);
  listen(m, "dragend", function () { dragFrom = -1; });
  listen(document.getElementById("gallery-close") as HTMLElement, "click", closeGalleryOverlay);
  const z = zoomEl();
  if (z) {
    listen(z, "click", onZoomClick);
    listen(z, "wheel", onZoomWheel, { passive: false });
    listen(z, "pointerdown", onZoomPointerDown);
    listen(z, "pointermove", onZoomPointerMove);
    listen(z, "pointerup", onZoomPointerUp);
    listen(z, "pointercancel", onZoomPointerUp);
    listen(window, "resize", function () { if (zoom) layoutZoom(true); });
  }
  listen(document, "securitypolicyviolation", function (e: SecurityPolicyViolationEvent) {
    if (!view || !(view as GalleryView).playing) return;
    if (!/^(frame-src|child-src|default-src)/.test(e.effectiveDirective || e.violatedDirective || "")) return;
    (view as GalleryView).refused = (view as GalleryView).playing;
    (view as GalleryView).playing = null;
    paint();
  });
  offs.push((ports as OverlayPortUse).changes.onChange(function (change) {
    if (change.name === "videoThumbs") refreshGalleryOverlay();
  }, { elsewhere: false }));
  return owner;
}
