import { bundleFolderName } from "../../../shared/video-path.ts";
import { bundleVideoLinks } from "../../core/document/gallery.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

import type { DesktopBundleCarry, DesktopBundleCopy } from "../../application/media/desktop-video.ts";
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

type Work =
  | { readonly kind: "copy"; readonly offer: Offer; readonly video: DroppedVideo }
  | { readonly kind: "carry"; readonly toFileId: string; readonly names: readonly string[]; readonly from: string; readonly to: string };

function quoted(name: string): string { return "“" + name + "”"; }

function videos(n: number): string { return n === 1 ? "1 video" : n + " videos"; }

export function bundlePromptText(names: readonly string[], folder: string): { title: string; detail: string } {
  const one = names.length === 1;
  return {
    title: one ? "Copy this video into the script's folder?" : "Copy these videos into the script's folder?",
    detail: (one ? "Splitpage can copy " + quoted(names[0] as string) : "Splitpage can copy these " + names.length + " videos") +
      " into " + quoted(folder) + ", a folder next to this script, and link to the copy. Keep that folder with the script, " +
      "and " + (one ? "the video opens" : "the videos open") + " wherever the script goes. Otherwise the script links to " +
      (one ? "the file" : "the files") + " where " + (one ? "it is" : "they are") + " now."
  };
}

export function startVideoBundles(ports: VideoBundlePorts): VideoBundleMount {
  const win = ports.window;
  const page = win.document;
  const life = createViewLifetime(win);
  const el = (id: string): HTMLElement | null => page.getElementById(id);
  let asking: Offer[] = [];
  const queue: Work[] = [];
  let current: { readonly job: string; readonly work: Work } | null = null;
  let jobs = 0;

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
    if (!life.active()) return;
    const script = ports.script();
    const list = dropped.filter(function (v) { return !!(v && v.name && v.path); });
    if (!script || !list.length) return;
    asking.push({ rowId, videos: list, entry, ctx: ports.ownership.capture(), folder: bundleFolderName(script) });
    showPrompt();
  }

  function answer(copy: boolean): void {
    const m = modal();
    if (!m || m.hidden) return;
    m.hidden = true;
    const offers = asking;
    asking = [];
    if (!copy) return;
    offers.forEach(function (o) { o.videos.forEach(function (v) { queue.push({ kind: "copy", offer: o, video: v }); }); });
    pump();
  }

  function progressText(work: Work, done: number, total: number): string {
    const pct = total > 0 ? Math.min(100, Math.floor(done * 100 / total)) : 0;
    const what = work.kind === "copy" ? quoted(work.video.name) + " to " + quoted(work.offer.folder) : videos(work.names.length) + " to " + quoted(work.to);
    return "Copying " + what + " — " + pct + "%";
  }

  function showProgress(work: Work, done: number, total: number): void {
    const box = el("bundle-progress");
    if (!box) return;
    const text = el("bundle-progress-text");
    if (text) text.textContent = progressText(work, done, total);
    const bar = el("bundle-progress-bar") as HTMLProgressElement | null;
    if (bar) { bar.max = total > 0 ? total : 1; bar.value = total > 0 ? Math.min(done, total) : 0; }
    box.hidden = false;
  }

  function hideProgress(): void {
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

  function copied(work: Extract<Work, { kind: "copy" }>, from: VideoLink, res: DesktopBundleCopy): void {
    if (res.ok) {
      if (!ports.ownership.stillOwns(work.offer.ctx)) return;
      relink(work.offer, from, res.name);
      ports.notices.show("Copied " + quoted(work.video.name) + " to " + quoted(work.offer.folder) + ".", "ok");
      return;
    }
    if (res.code === "CANCELLED") {
      ports.notices.show("Stopped copying " + quoted(work.video.name) + ". It links to where it is.", "warn");
      return;
    }
    ports.notices.show("Could not copy " + quoted(work.video.name) + " to " + quoted(work.offer.folder) + ", so it links to where it is.", "error");
  }

  function carried(work: Extract<Work, { kind: "carry" }>, res: DesktopBundleCarry | null): void {
    if (res && res.ok && !res.failed) {
      if (res.copied) ports.notices.show("Copied " + videos(res.copied) + " to " + quoted(work.to) + ".", "ok");
      return;
    }
    if (res && !res.ok && res.code === "CANCELLED") {
      ports.notices.show("Stopped copying videos to " + quoted(work.to) + ". The ones not copied are still in " + quoted(work.from) + ".", "warn", true);
      return;
    }
    const missing = res && res.ok ? res.failed : work.names.length;
    ports.notices.show(videos(missing) + " could not be copied to " + quoted(work.to) + ", so " + (missing === 1 ? "it does" : "they do") +
      " not open from this copy of the script. Look for " + (missing === 1 ? "it" : "them") + " in " + quoted(work.from) + ".", "error", true);
  }

  function pump(): void {
    if (current || !life.active()) return;
    const work = queue.shift();
    if (!work) { hideProgress(); return; }
    const job = "bundle" + (++jobs);
    current = { job, work };
    const progress = function (p: { done: number; total: number }): void {
      if (current && current.job === job) showProgress(work, p.done, p.total);
    };
    function settle(): void {
      current = null;
      pump();
    }
    showProgress(work, 0, work.kind === "copy" ? work.video.size : 0);
    if (work.kind === "copy") {
      const from: VideoLink = { name: work.video.name, size: work.video.size, location: { kind: "path", path: work.video.path } };
      ports.files.bundle(from, job, progress).then(function (res) {
        if (!life.active()) return;
        copied(work, from, res);
        settle();
      }, function () {
        if (!life.active()) return;
        copied(work, from, { ok: false, code: "FAILED" });
        settle();
      });
      return;
    }
    ports.carry(work.toFileId, work.names, job, progress).then(function (res) {
      if (!life.active()) return;
      carried(work, res);
      settle();
    }, function () {
      if (!life.active()) return;
      carried(work, null);
      settle();
    });
  }

  function cancel(): void {
    if (!current) return;
    queue.length = 0;
    ports.files.cancelBundle(current.job);
  }

  function carry(toFileId: string, names: readonly string[], fromScript: string, toScript: string): void {
    if (!life.active() || !toFileId || !names.length) return;
    queue.push({ kind: "carry", toFileId, names: names.slice(), from: bundleFolderName(fromScript), to: bundleFolderName(toScript) });
    pump();
  }

  life.listen(el("bundle-accept"), "click", function () { answer(true); });
  life.listen(el("bundle-decline"), "click", function () { answer(false); });
  life.listen(el("bundle-cancel"), "click", cancel);
  life.listen(win, "keydown", function (e) {
    const m = modal();
    if (e.key === "Escape" && m && !m.hidden) { e.preventDefault(); answer(false); }
  });

  return {
    offerAfterDrop: offer,
    carryAfterSaveAs: carry,
    dispose: function (): void {
      if (!life.active()) return;
      if (current) ports.files.cancelBundle(current.job);
      queue.length = 0;
      asking = [];
      const m = modal();
      if (m) m.hidden = true;
      hideProgress();
      life.dispose();
    }
  };
}
