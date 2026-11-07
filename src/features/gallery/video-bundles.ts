import { VIDEO_FILE_EXT, bundleFolderName } from "../../../shared/video-path.ts";
import { bundleVideoLinks } from "../../core/document/gallery.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

import type { DesktopBundleCarry, DesktopBundleCopy } from "../../application/media/desktop-video.ts";
import type { BundleSaveWindow } from "../../application/save/file-saving-ports.ts";
import type { UndoEntry } from "../../application/editing/undo/history.ts";
import type { VideoLink } from "../../core/document/gallery.ts";
import type { StepRow, Step } from "../../core/text/steps.ts";
import type { DroppedVideo, VideoBundleMount, VideoBundlePorts } from "./ports.ts";

const GALLERY_KEYS: Record<string, boolean> = { imageRef: true, imageLinks: true, moreImages: true, imageName: true, imageAnnotation: true };

export function touchesGallery(rowId: string | null) {
  return function (s: Step) {
    if (s.op === "rowField") return s.rowId === rowId && !!GALLERY_KEYS[s.key];
    if (s.op === "insertRow" || s.op === "deleteRow") return !!(s.row && s.row.id === rowId);
    return false;
  };
}

interface Offer {
  readonly rowId: string;
  readonly videos: readonly DroppedVideo[];
  readonly entry: UndoEntry | null;
  readonly ctx: ReturnType<VideoBundlePorts["ownership"]["capture"]>;
  readonly folder: string;
}

interface Copy {
  readonly job: string;
  readonly offer: Offer;
  readonly video: DroppedVideo;
  readonly from: VideoLink;
  cancelled: boolean;
}

function quoted(name: string): string { return "“" + name + "”"; }

function nounFor(names: readonly string[]): string {
  return names.every(function (n) { return VIDEO_FILE_EXT.test(n); }) ? "video" : "file";
}

function videos(n: number, noun = "video"): string { return n === 1 ? "1 " + noun : n + " " + noun + "s"; }

export function bundlePromptText(names: readonly string[], folder: string): { title: string; detail: string } {
  const one = names.length === 1;
  const noun = nounFor(names);
  return {
    title: one ? "Copy this " + noun + " into the script's folder?" : "Copy these " + noun + "s into the script's folder?",
    detail: (one ? "Splitpage can copy " + quoted(names[0] as string) : "Splitpage can copy these " + names.length + " " + noun + "s") +
      " into " + quoted(folder) + ", a folder next to this script, and link to the copy. Keep that folder with the script, " +
      "and " + (one ? "the " + noun + " opens" : "the " + noun + "s open") + " wherever the script goes. Otherwise the script links to " +
      (one ? "the file" : "the files") + " where " + (one ? "it is" : "they are") + " now."
  };
}

export function startVideoBundles(ports: VideoBundlePorts): VideoBundleMount {
  const win = ports.window;
  const page = win.document;
  const life = createViewLifetime(win);
  const el = (id: string): HTMLElement | null => page.getElementById(id);
  let asking: Offer[] = [];
  const pending: Copy[] = [];
  const drainWaiters: ((drained: boolean) => void)[] = [];
  let carrying: string | null = null;
  let jobs = 0;
  let saving = 0;

  function waitingOn(): Copy[] { return pending.filter(function (c) { return !c.cancelled; }); }

  function modal(): HTMLElement | null { return el("bundle-modal"); }

  function showPrompt(): void {
    const m = modal();
    const first = asking[0];
    if (!m || !first) return;
    const text = bundlePromptText(asking.flatMap(function (o) { return o.videos.map(function (v) { return v.name; }); }), first.folder);
    const title = el("bundle-title"), detail = el("bundle-detail");
    if (title) title.textContent = text.title;
    if (detail) detail.textContent = text.detail;
    m.hidden = false;
    const accept = el("bundle-accept");
    if (accept) { try { accept.focus({ preventScroll: true }); } catch (e) { } }
  }

  function offer(rowId: string, dropped: readonly DroppedVideo[], entry: UndoEntry | null): void {
    if (!life.active() || saving) return;
    const script = ports.script();
    const list = dropped.filter(function (v) { return !!(v && v.name && v.path); });
    if (!script || !list.length) return;
    asking.push({ rowId, videos: list, entry, ctx: ports.ownership.capture(), folder: bundleFolderName(script) });
    showPrompt();
  }

  function showProgress(what: string, done: number, total: number): void {
    const box = el("bundle-progress");
    if (!box) return;
    const pct = total > 0 ? Math.min(100, Math.floor(done * 100 / total)) : 0;
    const text = el("bundle-progress-text");
    if (text) text.textContent = "Copying " + what + " — " + pct + "%";
    const bar = el("bundle-progress-bar") as HTMLProgressElement | null;
    if (bar) { bar.max = total > 0 ? total : 1; bar.value = total > 0 ? Math.min(done, total) : 0; }
    box.hidden = false;
  }

  function copyText(c: Copy): string { return quoted(c.video.name) + " to " + quoted(c.offer.folder); }

  function showNext(): void {
    const next = waitingOn()[0];
    if (next) { showProgress(copyText(next), 0, next.video.size); return; }
    if (carrying) return;
    const box = el("bundle-progress");
    if (box) box.hidden = true;
  }

  function relink(o: Offer, from: VideoLink, name: string): void {
    const rowAt = function (): number { return ports.document.read(function (doc) { return rowIndexOf(doc, o.rowId); }); };
    if (rowAt() === -1) return;
    const folded = ports.undo.fold(o.entry, touchesGallery(o.rowId), function (draft) {
      const i = rowAt();
      return i !== -1 && bundleVideoLinks([draft.rows[i] as StepRow], from, name);
    });
    if (!folded) ports.cells.editGallery(o.rowId, "Linked to the copy in " + quoted(o.folder), function (row) { return bundleVideoLinks([row], from, name); });
    ports.viewer.refresh();
  }

  function copied(c: Copy, res: DesktopBundleCopy): void {
    if (res.ok) {
      // why: a Save As stopped waiting for this copy, so its bytes may already be captured without the link
      if (c.cancelled && saving) return;
      if (!ports.ownership.stillOwns(c.offer.ctx)) return;
      relink(c.offer, c.from, res.name);
      ports.notices.show("Copied " + quoted(c.video.name) + " to " + quoted(c.offer.folder) + ".", "ok");
      return;
    }
    if (res.code === "DROPPED") return;
    if (res.code === "CANCELLED") {
      ports.notices.show("Stopped copying " + quoted(c.video.name) + ". It links to where it is.", "warn");
      return;
    }
    ports.notices.show("Could not copy " + quoted(c.video.name) + " to " + quoted(c.offer.folder) + ", so it links to where it is.", "error");
  }

  function carried(note: DesktopBundleCarry, res: NonNullable<DesktopBundleCarry["result"]>): void {
    if (!res.ok) return;
    if (res.copied) ports.notices.show("Copied " + videos(res.copied, "file") + " to " + quoted(note.to) + ".", "ok");
    const missing = res.missing;
    if (!missing) return;
    ports.notices.show(videos(missing, "file") + " could not be copied to " + quoted(note.to) + ", so " + (missing === 1 ? "it does" : "they do") +
      " not open from this copy of the script. Look for " + (missing === 1 ? "it" : "them") + " in " + quoted(note.from) + ".", "error", true);
  }

  function onCarry(note: DesktopBundleCarry): void {
    if (!life.active() || !note || typeof note.job !== "string") return;
    if (note.result) {
      if (carrying === note.job) carrying = null;
      carried(note, note.result);
      showNext();
      return;
    }
    carrying = note.job;
    showProgress("files to " + quoted(note.to), note.done, note.total);
  }

  function drained(): void {
    if (waitingOn().length) return;
    drainWaiters.splice(0).forEach(function (resolve) { resolve(true); });
  }

  function settle(c: Copy, res: DesktopBundleCopy): void {
    if (!life.active()) return;
    const at = pending.indexOf(c);
    if (at !== -1) pending.splice(at, 1);
    copied(c, res);
    showNext();
    drained();
  }

  function submit(o: Offer, video: DroppedVideo): void {
    const c: Copy = { job: "bundle" + (++jobs), offer: o, video, from: { name: video.name, size: video.size, location: { kind: "path", path: video.path } }, cancelled: false };
    pending.push(c);
    ports.files.bundle(c.from, c.job, function (p) {
      if (life.active() && !carrying && !c.cancelled) showProgress(copyText(c), p.done, p.total);
    }).then(function (res) { settle(c, res); }, function () { settle(c, { ok: false, code: "FAILED" }); });
  }

  function answer(copy: boolean): void {
    const m = modal();
    if (!m || m.hidden) return;
    m.hidden = true;
    const offers = asking;
    asking = [];
    if (!copy) return;
    offers.forEach(function (o) { o.videos.forEach(function (v) { submit(o, v); }); });
    showNext();
  }

  function cancel(): void {
    pending.forEach(function (c) { c.cancelled = true; ports.files.cancelBundle(c.job); });
    if (carrying) ports.files.cancelBundle(carrying);
    drainWaiters.splice(0).forEach(function (resolve) { resolve(false); });
    showNext();
  }

  function beginSave(): BundleSaveWindow {
    if (!life.active()) return { drained: null, end: function () { } };
    saving++;
    answer(false);
    let open = true;
    const end = function (): void { if (open) { open = false; saving--; } };
    if (!waitingOn().length) return { drained: null, end };
    showNext();
    return { drained: new Promise(function (resolve) { drainWaiters.push(resolve); }), end };
  }

  ports.carries(onCarry);
  life.listen(el("bundle-accept"), "click", function () { answer(true); });
  life.listen(el("bundle-decline"), "click", function () { answer(false); });
  life.listen(el("bundle-cancel"), "click", cancel);
  life.listen(win, "keydown", function (e) {
    const m = modal();
    if (e.key === "Escape" && m && !m.hidden) { e.preventDefault(); answer(false); }
  });

  return {
    offerAfterDrop: offer,
    beginSave,
    dispose: function (): void {
      if (!life.active()) return;
      pending.forEach(function (c) { ports.files.cancelBundle(c.job); });
      pending.length = 0;
      drained();
      carrying = null;
      asking = [];
      const m = modal();
      if (m) m.hidden = true;
      const box = el("bundle-progress");
      if (box) box.hidden = true;
      life.dispose();
    }
  };
}
