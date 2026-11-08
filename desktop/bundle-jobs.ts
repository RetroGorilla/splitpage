"use strict";

import type { VideoPathVerdict } from "../shared/video-embed.ts";
import type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier } from "./bundle-copy.ts";

type BundleSender = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type BundleJobResult = BundleCopyResult | { ok: false; code: "DROPPED" | "UNKNOWN" | "NO_FOLDER" };
type BundleSaveRefusal = { reason: "clash" | "failed" | "cancelled" | "unlinkable" | "missing"; folder: string; name: string; copied: number; count?: number };
type BundleSaveChoice = "copy" | "link";
interface BundleSavePlan {
  readonly from: string;
  readonly to: string;
  readonly files: number;
  readonly bytes: number;
  readonly copyBytes: number;
  readonly linkable: boolean;
}
interface BundlePathLink {
  readonly name: string;
  readonly path: string;
}
type BundlePlanAnswer = { ok: true; plan: BundleSavePlan | null } | { ok: false; code: "UNKNOWN" } |
  { ok: false; code: "CLASH" | "MISSING"; refused: BundleSaveRefusal };
type BundleChoiceAnswer = { ok: true; links: BundlePathLink[] } | { ok: false; code: "UNKNOWN" | "REFUSED" } |
  { ok: false; code: "MISSING" | "UNLINKABLE"; refused: BundleSaveRefusal };
type BundleWrite = { refused: BundleSaveRefusal } | { refused: null; landed: (ok: boolean) => void };

interface BundleJob {
  readonly key: string;
  readonly sender: BundleSender;
  readonly job: string;
  readonly run: (progress: BundleProgress, signal: AbortSignal) => Promise<void>;
  readonly ctl: AbortController;
  readonly stop: (code: "CANCELLED" | "FAILED") => void;
}

interface SaveTarget {
  readonly tabId: string;
  readonly from: string | null;
  choice: BundleSaveChoice | null;
  names: readonly string[] | null;
}

interface PendingOpen {
  readonly tabId: string;
  readonly from: string;
  readonly to: string;
  readonly names: readonly string[];
  landed: boolean;
}

const SAVE_TARGETS_MAX = 50;
const PLAN_NAMES_MAX = 2000;
const REFUSALS: Record<string, BundleSaveRefusal["reason"]> = { CLASH: "clash", FAILED: "failed", CANCELLED: "cancelled" };

function createBundleJobs(options: {
  copier: ReturnType<typeof createBundleCopier>;
  allow: RegExp;
  scriptOfTab: (tabId: string) => string | null;
  pathOf: (fileId: string) => string | null;
  namesInProject: (text: string) => string[];
  foldCase?: boolean;
}) {
  const { copier, allow, scriptOfTab, pathOf, namesInProject } = options;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const queue: BundleJob[] = [];
  const byKey = new Map<string, BundleJob>();
  const saveTargets = new Map<string, SaveTarget>();
  const opens = new Set<PendingOpen>();
  let running: BundleJob | null = null;
  let carries = 0;
  let idleWaiters: (() => void)[] = [];

  const same = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keyOf = (sender: BundleSender, job: string) => String(sender.id) + ":" + job;

  function tell(sender: BundleSender, push: (to: BundleSender) => void): void {
    try { if (!sender.isDestroyed()) push(sender); } catch { }
  }

  function enqueue(job: BundleJob): void {
    const earlier = byKey.get(job.key);
    if (earlier) earlier.ctl.abort();
    byKey.set(job.key, job);
    queue.push(job);
    void pump();
  }

  async function pump(): Promise<void> {
    if (running) return;
    const job = queue.shift();
    if (!job) {
      const waiting = idleWaiters;
      idleWaiters = [];
      waiting.forEach((resolve) => resolve());
      return;
    }
    running = job;
    try {
      const signal = job.ctl.signal;
      if (!signal.aborted) {
        const ran = job.run((done, total) => tell(job.sender, (to) => to.send("splitpage:bundle-progress", { job: job.job, done, total })), signal)
          .catch(() => job.stop("FAILED"));
        // why: a read stalled on a lost drive never answers its abort; the job is let go, and it cannot publish once aborted
        await Promise.race([ran, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      }
      if (signal.aborted) job.stop("CANCELLED");
    } finally {
      if (byKey.get(job.key) === job) byKey.delete(job.key);
      running = null;
      void pump();
    }
  }

  function copy(sender: BundleSender, tabId: string, job: string, source: string, script: string): Promise<BundleJobResult> {
    return new Promise((finish) => {
      let settled = false;
      const done = (result: BundleJobResult) => { if (!settled) { settled = true; finish(result); } };
      enqueue({
        key: keyOf(sender, job), sender, job, ctl: new AbortController(),
        stop: (code) => done({ ok: false, code }),
        run: async (progress, signal) => {
          const now = scriptOfTab(tabId);
          if (!now || !same(script, now)) { done({ ok: false, code: "DROPPED" }); return; }
          done(await copier.copyIn(source, script, allow, progress, signal));
        }
      });
    });
  }

  function cancel(sender: BundleSender, job: string): void {
    const found = byKey.get(keyOf(sender, job));
    if (found) found.ctl.abort();
  }

  function noteSaveTarget(fileId: string, tab: { id: string; source: { kind: string; absPath?: unknown } } | null): void {
    if (!tab) return;
    if (saveTargets.size >= SAVE_TARGETS_MAX) saveTargets.delete(saveTargets.keys().next().value as string);
    const from = tab.source.kind === "file" && typeof tab.source.absPath === "string" ? tab.source.absPath : null;
    saveTargets.set(fileId, { tabId: tab.id, from, choice: null, names: null });
  }

  function targetOf(fileId: unknown, tab: { id: string } | null): SaveTarget | null {
    const noted = typeof fileId === "string" ? saveTargets.get(fileId) : undefined;
    return noted && tab && noted.tabId === tab.id ? noted : null;
  }

  function carrying(from: string | null, to: string | null): from is string {
    return !!from && !!to && !same(from, to) && !same(copier.storedPath(from, "x"), copier.storedPath(to, "x"));
  }

  function missingRefusal(from: string, name: string, count: number): BundleSaveRefusal {
    return { reason: "missing", folder: copier.folderName(from), name, copied: 0, count };
  }

  async function sizeIn(from: string, name: string): Promise<number | null> {
    const found = await copier.resolveIn(from, name, allow);
    const size = found.ok ? await copier.sizeOfFile(found.path) : null;
    return size === null || size < 0 ? null : size;
  }

  async function planSave(fileId: unknown, names: unknown, tab: { id: string } | null): Promise<BundlePlanAnswer> {
    const noted = targetOf(fileId, tab);
    if (!noted) return { ok: false, code: "UNKNOWN" };
    const to = pathOf(fileId as string);
    const from = noted.from;
    if (!carrying(from, to) || !to) return { ok: true, plan: null };
    const wanted = Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === "string"))].slice(0, PLAN_NAMES_MAX) : [];
    noted.names = wanted;
    const toFolder = copier.folderName(to);
    let files = 0, bytes = 0, copyBytes = 0, missing = 0, firstMissing = "", linkable = true;
    for (const name of wanted) {
      const size = await sizeIn(from, name);
      if (size === null) { if (!missing++) firstMissing = name; continue; }
      files++;
      bytes += size;
      const there = await copier.sizeOfFile(copier.storedPath(to, name));
      if (there === null) copyBytes += size;
      else if (there !== size) return { ok: false, code: "CLASH", refused: { reason: "clash", folder: toFolder, name, copied: 0 } };
      if (linkable && !(await copier.openStored(copier.storedPath(from, name), allow)).ok) linkable = false;
    }
    if (missing) return { ok: false, code: "MISSING", refused: missingRefusal(from, firstMissing, missing) };
    if (!files) return { ok: true, plan: null };
    return { ok: true, plan: { from: copier.folderName(from), to: toFolder, files, bytes, copyBytes, linkable } };
  }

  async function linksFor(from: string, names: readonly string[]): Promise<BundleChoiceAnswer> {
    const links: BundlePathLink[] = [];
    let missing = 0, firstMissing = "";
    for (const name of names) {
      if ((await sizeIn(from, name)) === null) { if (!missing++) firstMissing = name; continue; }
      const stored = copier.storedPath(from, name);
      if (!(await copier.openStored(stored, allow)).ok) {
        return { ok: false, code: "UNLINKABLE", refused: { reason: "unlinkable", folder: copier.folderName(from), name, copied: 0 } };
      }
      links.push({ name, path: stored });
    }
    if (missing) return { ok: false, code: "MISSING", refused: missingRefusal(from, firstMissing, missing) };
    return { ok: true, links };
  }

  async function chooseSave(fileId: unknown, choice: unknown, tab: { id: string } | null): Promise<BundleChoiceAnswer> {
    const noted = targetOf(fileId, tab);
    if (!noted) return { ok: false, code: "UNKNOWN" };
    if (choice !== "copy" && choice !== "link") return { ok: false, code: "REFUSED" };
    if (choice === "copy") { noted.choice = choice; return { ok: true, links: [] }; }
    const to = pathOf(fileId as string);
    if (!noted.names || !carrying(noted.from, to)) return { ok: false, code: "REFUSED" };
    const answer = await linksFor(noted.from, noted.names);
    if (answer.ok) noted.choice = choice;
    return answer;
  }

  function plainWrite(fileId: string): BundleWrite {
    return { refused: null, landed: (ok) => { if (ok) saveTargets.delete(fileId); } };
  }

  function carryForSave(fileId: string, noted: SaveTarget, from: string, to: string, names: readonly string[], sender: BundleSender): Promise<BundleWrite> {
    const job = "carry" + (++carries);
    const note = (done: number, total: number, result?: BundleCarryResult & { left?: number }) => tell(sender, (s) => s.send("splitpage:bundle-carry", {
      job, from: copier.folderName(from), to: copier.folderName(to), done, total, ...(result ? { result } : {})
    }));
    const refusal = (result: BundleCarryResult): BundleSaveRefusal | null => {
      if (result.ok) return null;
      if (result.code === "MISSING") return missingRefusal(from, result.name, result.missing);
      return { reason: REFUSALS[result.code] as BundleSaveRefusal["reason"], folder: copier.folderName(to), name: result.name, copied: result.copied };
    };
    return new Promise((answer) => {
      let answered = false;
      let settled = false;
      let committed = 0;
      let pending: readonly string[] | null = null;
      let wrote: "waiting" | "yes" | "no" = "waiting";
      let open: PendingOpen | null = null;
      let release: ((go: boolean) => void) | null = null;
      const reply = (w: BundleWrite) => { if (!answered) { answered = true; answer(w); } };
      const done = (result: BundleCarryResult) => {
        if (settled) return;
        settled = true;
        if (open) { opens.delete(open); open = null; }
        const waiting = release;
        release = null;
        if (waiting) waiting(false);
        if (!answered) {
          const refused = refusal(result);
          reply(refused ? { refused } : plainWrite(fileId));
        }
        const background = pending !== null && wrote !== "no";
        note(1, 1, background && !result.ok ? { ...result, left: Math.max(0, (pending as readonly string[]).length - result.copied) } : result);
      };
      enqueue({
        key: keyOf(sender, job), sender, job, ctl: new AbortController(),
        stop: (code) => done({ ok: false, code, name: "", copied: committed }),
        run: async (_progress, signal) => {
          done(await copier.carry(from, to, names, allow, (d, t) => { if (!settled && !signal.aborted) note(d, t); }, signal, (n) => { committed = n; }, {
            strict: true,
            source: (name) => copier.resolveIn(from, name, allow),
            ready: (listed) => {
              if (settled || signal.aborted) return Promise.resolve(false);
              pending = listed;
              open = { tabId: noted.tabId, from, to, names: listed, landed: false };
              opens.add(open);
              note(0, 1);
              return new Promise<boolean>((go) => {
                release = go;
                reply({
                  refused: null, landed: (ok) => {
                    wrote = ok ? "yes" : "no";
                    if (ok) saveTargets.delete(fileId);
                    if (ok && open) open.landed = true;
                    if (release === go) { release = null; go(ok && !settled); }
                  }
                });
              });
            }
          }));
        }
      });
    });
  }

  function prepareWrite(fileId: string, text: () => string, sender: BundleSender): Promise<BundleWrite> {
    const noted = saveTargets.get(fileId);
    const to = pathOf(fileId);
    if (!noted || !to || !carrying(noted.from, to)) return Promise.resolve(plainWrite(fileId));
    const names = namesInProject(text());
    // why: Don't copy changed every listed name to a path, so a name still bundled would link the new folder
    if (noted.choice === "link" && names.length) return Promise.resolve({ refused: missingRefusal(noted.from, names[0] as string, names.length) });
    if (!names.length) return Promise.resolve(plainWrite(fileId));
    return carryForSave(fileId, noted, noted.from, to, names, sender);
  }

  function stillOpen(open: PendingOpen): boolean {
    const now = scriptOfTab(open.tabId);
    if (now && !(open.landed && !same(now, open.to))) return true;
    opens.delete(open);
    return false;
  }

  async function openBundled(tabId: string, script: string, name: unknown): Promise<VideoPathVerdict> {
    const found = await copier.resolveIn(script, name, allow);
    if (found.ok || found.code !== "GONE" || typeof name !== "string") return found;
    for (const open of [...opens]) {
      if (!stillOpen(open)) continue;
      if (open.tabId === tabId && same(open.to, script) && open.names.some((n) => same(n, name))) return copier.resolveIn(open.from, name, allow);
    }
    return found;
  }

  function noteScript(tabId: string, script: string | null): void {
    for (const open of [...opens]) {
      const kept = !!script && (same(script, open.to) || (!open.landed && same(script, open.from)));
      if (open.tabId === tabId && !kept) opens.delete(open);
    }
  }

  function forgetTab(tabId: string): void {
    for (const open of [...opens]) if (open.tabId === tabId) opens.delete(open);
    for (const [fileId, noted] of [...saveTargets]) if (noted.tabId === tabId) saveTargets.delete(fileId);
  }

  function busy(): boolean {
    return !!running || queue.length > 0;
  }

  function idle(): Promise<void> {
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  function abortAll(): Promise<void> {
    for (const job of [running, ...queue]) if (job) job.ctl.abort();
    return idle();
  }

  return { abortAll, busy, cancel, chooseSave, copy, forgetTab, idle, noteSaveTarget, noteScript, openBundled, planSave, prepareWrite };
}

export type { BundleJobResult, BundleSaveRefusal, BundleSender, createBundleJobs };

module.exports = { createBundleJobs };
