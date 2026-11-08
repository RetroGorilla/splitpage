import { VIDEO_FILE_EXT, bundleFolderName } from "../../../shared/video-path.ts";
import { bundledNamesInProject } from "../../../shared/video-embed.ts";
import { bundleVideoLinks } from "../../core/document/gallery.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

import type {
  BundleSaveChoice, DesktopBundleCarry, DesktopBundleCopy, DesktopBundleExport, DesktopBundleExportPlan, DesktopBundleSavePlan
} from "../../application/media/desktop-video.ts";
import type { BundleSaveWindow } from "../../application/save/file-saving-ports.ts";
import type { UndoEntry } from "../../application/editing/undo/history.ts";
import type { BundledPathLink, VideoLink } from "../../core/document/gallery.ts";
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

interface SaveAsk {
  readonly handle: unknown;
  readonly resolve: (links: readonly BundledPathLink[] | null) => void;
  readonly reject: (error: unknown) => void;
  readonly focused: Element | null;
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

export const BUNDLE_WARN_BYTES = 250 * 1024 * 1024;
const BIG_COPY = "That is a lot to copy, and it may take a while and use disk space. You can keep working while it copies.";

export function sizeText(bytes: number): string {
  const kb = 1024, mb = kb * 1024, gb = mb * 1024;
  const tenths = function (n: number): string { return n.toFixed(1).replace(/\.0$/, ""); };
  if (bytes >= gb) return tenths(bytes / gb) + " GB";
  if (bytes >= mb) return tenths(bytes / mb) + " MB";
  if (bytes >= kb) return Math.round(bytes / kb) + " KB";
  return Math.max(0, Math.round(bytes)) + " B";
}

export function saveCopyPromptText(plan: DesktopBundleSavePlan): { title: string; detail: string; warning: string | null; copy: string; share: string | null } {
  const one = plan.files === 1;
  return {
    title: "Save the files with this script?",
    detail: "This script links " + videos(plan.files, "file") + " in " + quoted(plan.from) + " (" + sizeText(plan.bytes) + "). Copy files adds " +
      (one ? "it" : "them") + " to " + quoted(plan.to) + ", next to the new script. Otherwise the new script links to " +
      (one ? "the file where it is" : "the files where they are") + " now.",
    warning: plan.copyBytes > BUNDLE_WARN_BYTES ? BIG_COPY : null,
    copy: "Copy files (" + sizeText(plan.copyBytes) + ")",
    share: plan.linkable ? null : "“Don't copy the files” is not available: the files are on a network share, which a script cannot link to."
  };
}

export function exportFilesText(plan: DesktopBundleExportPlan): string {
  const parts = [plan.files ? videos(plan.files, "file") + " (" + sizeText(plan.bytes) + ") in a folder beside the script" : "no linked files to include"];
  if (plan.left) parts.push(videos(plan.left, "file") + " can't be included: missing, or a type Splitpage doesn't attach");
  return parts.join(" · ") + (plan.bytes > BUNDLE_WARN_BYTES ? ". " + BIG_COPY : "");
}

export function exportDoneText(name: string, res: DesktopBundleExport | null): { text: string; kind: "ok" | "warn" | "error"; left: string | null } {
  if (res && res.ok) {
    return {
      text: "Exported " + quoted(name) + (res.files ? " with " + videos(res.files, "file") : "") + ".", kind: "ok",
      left: res.left ? videos(res.left, "file") + " couldn't be included in " + quoted(name) + ". " + (res.left === 1 ? "It is" : "They are") +
        " missing, or a type Splitpage doesn't attach, so " + (res.left === 1 ? "its link doesn't" : "their links don't") + " open from the exported script." : null
    };
  }
  if (res && res.code === "CANCELLED") return { text: "Stopped exporting " + quoted(name) + ". Nothing was saved.", kind: "warn", left: null };
  if (res && res.code === "TAKEN") return { text: "Could not export — " + quoted(name) + " already exists. Export again and choose a new name.", kind: "error", left: null };
  return { text: "Could not export " + quoted(name) + ".", kind: "error", left: null };
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
  let tucked = false;
  let saveAsk: SaveAsk | null = null;
  let exporting: { readonly job: string; readonly name: string } | null = null;
  let exportJobs = 0;

  function waitingOn(): Copy[] { return pending.filter(function (c) { return !c.cancelled; }); }

  function busy(): boolean { return waitingOn().length > 0 || !!carrying; }

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
    // why: a drop copied into the new folder while the Save As copy runs could take a name the new script links
    if (!life.active() || saving || carrying) return;
    const script = ports.script();
    const list = dropped.filter(function (v) { return !!(v && v.name && v.path); });
    if (!script || !list.length) return;
    asking.push({ rowId, videos: list, entry, ctx: ports.ownership.capture(), folder: bundleFolderName(script) });
    showPrompt();
  }

  function showProgress(what: string, done: number, total: number, verb = "Copying", chipText = "Copying files"): void {
    const box = el("bundle-progress");
    if (!box) return;
    const pct = total > 0 ? Math.min(100, Math.floor(done * 100 / total)) : 0;
    const text = el("bundle-progress-text");
    if (text) text.textContent = verb + " " + what + " — " + pct + "%";
    const bar = el("bundle-progress-bar") as HTMLProgressElement | null;
    if (bar) { bar.max = total > 0 ? total : 1; bar.value = total > 0 ? Math.min(done, total) : 0; }
    const chip = el("bundle-indicator");
    if (chip) { chip.textContent = chipText + " — " + pct + "%"; chip.hidden = !tucked; }
    box.hidden = tucked;
  }

  function showExport(done: number, total: number): void {
    if (exporting) showProgress(quoted(exporting.name), done, total, "Exporting", "Exporting");
  }

  function tuck(hide: boolean, moveFocus = false): void {
    const box = el("bundle-progress"), chip = el("bundle-indicator");
    if (!box || (box.hidden && !tucked)) return;
    tucked = hide;
    box.hidden = hide;
    if (chip) chip.hidden = !hide;
    if (moveFocus) focusOn(hide ? chip : el("bundle-hide"));
  }

  function copyText(c: Copy): string { return quoted(c.video.name) + " to " + quoted(c.offer.folder); }

  function showNext(): void {
    const next = waitingOn()[0];
    if (next) { showProgress(copyText(next), 0, next.video.size); return; }
    if (carrying) return;
    if (exporting) { showExport(0, 1); return; }
    const box = el("bundle-progress"), chip = el("bundle-indicator");
    if (box) box.hidden = true;
    if (chip) chip.hidden = true;
    tucked = false;
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
    if (!res.ok) {
      const left = typeof res.left === "number" ? res.left : 0;
      if (!left) return;
      const lead = res.code === "CANCELLED" ? "Stopped copying files to " + quoted(note.to) + ". " :
        "Could not copy " + (res.name ? quoted(res.name) : "the files") + " to " + quoted(note.to) + ". ";
      ports.notices.show(lead + videos(left, "file") + (left === 1 ? " was" : " were") + " not copied, so " + (left === 1 ? "it does" : "they do") +
        " not open from this copy of the script. Look for " + (left === 1 ? "it" : "them") + " in " + quoted(note.from) + ".", "error", true);
      return;
    }
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
      drained();
      return;
    }
    carrying = note.job;
    showProgress("files to " + quoted(note.to), note.done, note.total);
  }

  function drained(): void {
    if (busy()) return;
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
    if (exporting) ports.files.cancelBundle(exporting.job);
    drainWaiters.splice(0).forEach(function (resolve) { resolve(false); });
    showNext();
  }

  function exportPlan(body: string): Promise<DesktopBundleExportPlan | null> {
    if (!life.active()) return Promise.resolve(null);
    return ports.exports.plan("files" + (++exportJobs), "Script.splitpage", body);
  }

  async function exportWithFiles(zipName: string, scriptName: string, body: string): Promise<boolean> {
    if (!life.active()) return false;
    if (exporting) {
      ports.notices.show("Splitpage is already exporting " + quoted(exporting.name) + ". Wait for it to finish, then export again.", "warn");
      return false;
    }
    const job = "export" + (++exportJobs);
    const plan = await ports.exports.plan(job, scriptName, body).catch(function () { return null; });
    if (!life.active()) return false;
    if (!plan) { ports.notices.show(exportDoneText(zipName, null).text, "error"); return false; }
    const picked = await ports.exports.pick(zipName);
    if (!picked || !life.active()) return false;
    const mine = { job, name: picked.name };
    exporting = mine;
    showNext();
    let res: DesktopBundleExport | null;
    try {
      res = await ports.exports.run(job, picked.id, function (p) { if (life.active() && exporting === mine && !carrying && !waitingOn().length) showExport(p.done, p.total); });
    } catch (e) { res = null; }
    if (exporting === mine) exporting = null;
    if (!life.active()) return false;
    showNext();
    const said = exportDoneText(picked.name, res);
    ports.notices.show(said.text, said.kind);
    if (said.left) ports.notices.show(said.left, "error", true);
    return !!(res && res.ok);
  }

  function saveModal(): HTMLElement | null { return el("bundle-save-modal"); }

  function focusOn(node: Element | null): void {
    if (node && typeof (node as HTMLElement).focus === "function" && node.isConnected) {
      try { (node as HTMLElement).focus({ preventScroll: true }); } catch (e) { }
    }
  }

  function takeSaveAsk(): SaveAsk | null {
    const was = saveAsk;
    if (!was) return null;
    saveAsk = null;
    const m = saveModal();
    if (m) m.hidden = true;
    focusOn(was.focused);
    return was;
  }

  function closeSaveAsk(): void {
    const was = takeSaveAsk();
    if (was) was.resolve(null);
  }

  function chose(choice: BundleSaveChoice): void {
    const was = takeSaveAsk();
    if (!was) return;
    ports.saves.choose(was.handle, choice).then(function (links) {
      was.resolve(links ? links : choice === "copy" ? [] : null);
    }, was.reject);
  }

  function showSaveAsk(plan: DesktopBundleSavePlan): void {
    const m = saveModal();
    const text = saveCopyPromptText(plan);
    const set = function (id: string, value: string | null): void {
      const node = el(id);
      if (!node) return;
      node.textContent = value || "";
      node.hidden = value === null;
    };
    set("bundle-save-title", text.title);
    set("bundle-save-detail", text.detail);
    set("bundle-save-warning", text.warning);
    set("bundle-save-share", text.share);
    set("bundle-save-copy", text.copy);
    const link = el("bundle-save-link") as HTMLButtonElement | null;
    if (link) link.disabled = !plan.linkable;
    if (m) m.hidden = false;
    const copy = el("bundle-save-copy");
    if (copy) { try { copy.focus({ preventScroll: true }); } catch (e) { } }
  }

  function ask(handle: unknown, body: string): Promise<readonly BundledPathLink[] | null> {
    if (!life.active()) return Promise.resolve([]);
    const names = bundledNamesInProject(body);
    if (!names.length) return Promise.resolve([]);
    return ports.saves.plan(handle, names).then(function (plan) {
      if (!plan || !life.active()) return [];
      closeSaveAsk();
      return new Promise<readonly BundledPathLink[] | null>(function (resolve, reject) {
        saveAsk = { handle, resolve, reject, focused: page.activeElement };
        showSaveAsk(plan);
      });
    });
  }

  function beginSave(): BundleSaveWindow {
    if (!life.active()) return { drained: null, ask: function () { return Promise.resolve([]); }, end: function () { } };
    saving++;
    answer(false);
    let open = true;
    const end = function (): void { if (open) { open = false; saving--; } };
    if (!busy()) return { drained: null, ask, end };
    tuck(false);
    showNext();
    return { drained: new Promise(function (resolve) { drainWaiters.push(resolve); }), ask, end };
  }

  ports.carries(onCarry);
  life.listen(el("bundle-accept"), "click", function () { answer(true); });
  life.listen(el("bundle-decline"), "click", function () { answer(false); });
  life.listen(el("bundle-cancel"), "click", cancel);
  life.listen(el("bundle-hide"), "click", function () { tuck(true, true); });
  life.listen(el("bundle-indicator"), "click", function () { tuck(false, true); });
  life.listen(el("bundle-save-copy"), "click", function () { chose("copy"); });
  life.listen(el("bundle-save-link"), "click", function () { chose("link"); });
  life.listen(el("bundle-save-cancel"), "click", function () { closeSaveAsk(); });
  life.listen(win, "keydown", function (e) {
    if (e.key !== "Escape") return;
    const m = modal(), s = saveModal();
    if (s && !s.hidden) { e.preventDefault(); closeSaveAsk(); return; }
    if (m && !m.hidden) { e.preventDefault(); answer(false); }
  });

  return {
    offerAfterDrop: offer,
    beginSave,
    exportPlan,
    exportWithFiles,
    dispose: function (): void {
      if (!life.active()) return;
      pending.forEach(function (c) { ports.files.cancelBundle(c.job); });
      if (exporting) ports.files.cancelBundle(exporting.job);
      exporting = null;
      pending.length = 0;
      carrying = null;
      drained();
      closeSaveAsk();
      asking = [];
      const m = modal();
      if (m) m.hidden = true;
      const box = el("bundle-progress"), chip = el("bundle-indicator");
      if (box) box.hidden = true;
      if (chip) chip.hidden = true;
      life.dispose();
    }
  };
}
