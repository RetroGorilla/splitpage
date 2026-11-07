"use strict";

import type { VideoPathVerdict } from "../shared/video-embed.ts";
import type { BundleCarryResult, BundleCopyResult, BundleProgress, BundleSource, createBundleCopier } from "./bundle-copy.ts";

type BundleSender = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type BundleJobResult = BundleCopyResult | { ok: false; code: "DROPPED" | "UNKNOWN" | "NO_FOLDER" };
type BundleSaveRefusal = { reason: "clash" | "failed" | "cancelled" | "unlinkable"; folder: string; name: string; copied: number };
type BundleSaveChoice = "copy" | "link";
interface BundleSavePlan {
  readonly from: string;
  readonly to: string;
  readonly files: number;
  readonly bytes: number;
  readonly copyBytes: number;
  readonly missing: number;
  readonly linkable: boolean;
}
type BundlePlanAnswer = { ok: true; plan: BundleSavePlan | null } | { ok: false; code: "UNKNOWN" } | { ok: false; code: "CLASH"; refused: BundleSaveRefusal };
type BundleChoiceAnswer = { ok: true } | { ok: false; code: "UNKNOWN" | "REFUSED" };
type BundleWrite = { refused: BundleSaveRefusal } | { refused: null; text: string | null; landed: (ok: boolean) => void };

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
}

interface PendingOpen {
  readonly tabId: string;
  readonly to: string;
  readonly names: readonly string[];
  readonly source: BundleSource;
}

const SAVE_TARGETS_MAX = 50;
const LINKED_MAX = 50;
const PLAN_NAMES_MAX = 2000;
const REFUSALS: Record<string, BundleSaveRefusal["reason"]> = { CLASH: "clash", FAILED: "failed", CANCELLED: "cancelled" };

function createBundleJobs(options: {
  copier: ReturnType<typeof createBundleCopier>;
  allow: RegExp;
  scriptOfTab: (tabId: string) => string | null;
  pathOf: (fileId: string) => string | null;
  namesInProject: (text: string) => string[];
  linkInProject: (text: string, paths: ReadonlyMap<string, string>) => string | null;
  foldCase?: boolean;
}) {
  const { copier, allow, scriptOfTab, pathOf, namesInProject, linkInProject } = options;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const queue: BundleJob[] = [];
  const byKey = new Map<string, BundleJob>();
  const saveTargets = new Map<string, SaveTarget>();
  const linked = new Map<string, Map<string, string>>();
  const opens = new Set<PendingOpen>();
  let running: BundleJob | null = null;
  let carries = 0;
  let idleWaiters: (() => void)[] = [];

  const same = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keyOf = (sender: BundleSender, job: string) => String(sender.id) + ":" + job;
  const pathKey = (p: string) => (foldCase ? p.toLowerCase() : p);

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

  function linkedName(script: string, name: unknown): string | null {
    const map = linked.get(pathKey(script));
    if (!map || typeof name !== "string") return null;
    for (const [n, stored] of map) if (same(n, name)) return stored;
    return null;
  }

  function sourceIn(script: string): BundleSource {
    return (name) => {
      const stored = linkedName(script, name);
      return stored ? copier.openStored(stored, allow) : copier.resolveIn(script, name, allow);
    };
  }

  function storedFor(script: string, name: string): string {
    return linkedName(script, name) || copier.storedPath(script, name);
  }

  function rememberLinks(script: string, paths: Map<string, string>): void {
    linked.delete(pathKey(script));
    if (!paths.size) return;
    if (linked.size >= LINKED_MAX) linked.delete(linked.keys().next().value as string);
    linked.set(pathKey(script), paths);
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
          done(await copier.copyIn(source, script, allow, progress, signal, (name) => !!linkedName(script, name)));
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
    saveTargets.set(fileId, { tabId: tab.id, from, choice: null });
  }

  function targetOf(fileId: unknown, tab: { id: string } | null): SaveTarget | null {
    const noted = typeof fileId === "string" ? saveTargets.get(fileId) : undefined;
    return noted && tab && noted.tabId === tab.id ? noted : null;
  }

  function carrying(from: string | null, to: string | null): from is string {
    return !!from && !!to && !same(from, to) && !same(copier.storedPath(from, "x"), copier.storedPath(to, "x"));
  }

  async function planSave(fileId: unknown, names: unknown, tab: { id: string } | null): Promise<BundlePlanAnswer> {
    const noted = targetOf(fileId, tab);
    if (!noted) return { ok: false, code: "UNKNOWN" };
    const to = pathOf(fileId as string);
    const from = noted.from;
    if (!carrying(from, to) || !to) return { ok: true, plan: null };
    const wanted = Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === "string"))].slice(0, PLAN_NAMES_MAX) : [];
    const source = sourceIn(from);
    const toFolder = copier.folderName(to);
    let files = 0, bytes = 0, copyBytes = 0, missing = 0, linkable = true;
    for (const name of wanted) {
      const found = await source(name);
      const size = found.ok ? await copier.sizeOfFile(found.path) : null;
      if (!found.ok || size === null || size < 0) { missing++; continue; }
      files++;
      bytes += size;
      const there = await copier.sizeOfFile(copier.storedPath(to, name));
      if (there === null) copyBytes += size;
      else if (there !== size) return { ok: false, code: "CLASH", refused: { reason: "clash", folder: toFolder, name, copied: 0 } };
      if (linkable && !(await copier.openStored(storedFor(from, name), allow)).ok) linkable = false;
    }
    if (!files) return { ok: true, plan: null };
    return { ok: true, plan: { from: copier.folderName(from), to: toFolder, files, bytes, copyBytes, missing, linkable } };
  }

  function chooseSave(fileId: unknown, choice: unknown, tab: { id: string } | null): BundleChoiceAnswer {
    const noted = targetOf(fileId, tab);
    if (!noted) return { ok: false, code: "UNKNOWN" };
    if (choice !== "copy" && choice !== "link") return { ok: false, code: "REFUSED" };
    noted.choice = choice;
    return { ok: true };
  }

  function plainWrite(fileId: string, to: string | null, text: () => string): BundleWrite {
    const map = to ? linked.get(pathKey(to)) : undefined;
    return { refused: null, text: map ? linkInProject(text(), map) : null, landed: (ok) => { if (ok) saveTargets.delete(fileId); } };
  }

  async function linkForSave(fileId: string, from: string, to: string, names: readonly string[], text: () => string): Promise<BundleWrite> {
    const source = sourceIn(from);
    const paths = new Map<string, string>();
    for (const name of names) {
      if (!(await source(name)).ok) continue;
      const stored = storedFor(from, name);
      if (!(await copier.openStored(stored, allow)).ok) return { refused: { reason: "unlinkable", folder: copier.folderName(from), name, copied: 0 } };
      paths.set(name, stored);
    }
    return {
      refused: null,
      text: linkInProject(text(), paths),
      landed: (ok) => { if (!ok) return; saveTargets.delete(fileId); rememberLinks(to, paths); }
    };
  }

  function carryForSave(fileId: string, noted: SaveTarget, from: string, to: string, names: readonly string[], sender: BundleSender): Promise<BundleWrite> {
    const job = "carry" + (++carries);
    const source = sourceIn(from);
    const note = (done: number, total: number, result?: BundleCarryResult & { left?: number }) => tell(sender, (s) => s.send("splitpage:bundle-carry", {
      job, from: copier.folderName(from), to: copier.folderName(to), done, total, ...(result ? { result } : {})
    }));
    const refusal = (result: BundleCarryResult): BundleSaveRefusal | null =>
      (result.ok ? null : { reason: REFUSALS[result.code] as BundleSaveRefusal["reason"], folder: copier.folderName(to), name: result.name, copied: result.copied });
    return new Promise((answer) => {
      let answered = false;
      let settled = false;
      let committed = 0;
      let pending: readonly string[] | null = null;
      let wrote: "waiting" | "yes" | "no" = "waiting";
      let open: PendingOpen | null = null;
      const reply = (w: BundleWrite) => { if (!answered) { answered = true; answer(w); } };
      const done = (result: BundleCarryResult) => {
        if (settled) return;
        settled = true;
        if (open) opens.delete(open);
        if (!answered) {
          const refused = refusal(result);
          reply(refused ? { refused } : plainWrite(fileId, null, () => ""));
        }
        const background = pending !== null && wrote !== "no";
        note(1, 1, background && !result.ok ? { ...result, left: Math.max(0, (pending as readonly string[]).length - result.copied) } : result);
      };
      enqueue({
        key: keyOf(sender, job), sender, job, ctl: new AbortController(),
        stop: (code) => done({ ok: false, code, name: "", copied: committed }),
        run: async (_progress, signal) => {
          done(await copier.carry(from, to, names, allow, (d, t) => note(d, t), signal, (n) => { committed = n; }, {
            source,
            ready: (names) => {
              pending = names;
              open = { tabId: noted.tabId, to, names, source };
              opens.add(open);
              note(0, 1);
              return new Promise<boolean>((landed) => {
                reply({
                  refused: null, text: null, landed: (ok) => {
                    wrote = ok ? "yes" : "no";
                    if (ok) { saveTargets.delete(fileId); linked.delete(pathKey(to)); }
                    landed(ok);
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
    if (!noted || !to || !carrying(noted.from, to)) return Promise.resolve(plainWrite(fileId, to, text));
    const names = namesInProject(text());
    if (!names.length) return Promise.resolve(plainWrite(fileId, to, text));
    if (noted.choice === "link") return linkForSave(fileId, noted.from, to, names, text);
    return carryForSave(fileId, noted, noted.from, to, names, sender);
  }

  async function openBundled(tabId: string, script: string, name: unknown): Promise<VideoPathVerdict> {
    const stored = linkedName(script, name);
    if (stored) return copier.openStored(stored, allow);
    const found = await copier.resolveIn(script, name, allow);
    if (found.ok || found.code !== "GONE" || typeof name !== "string") return found;
    for (const open of opens) {
      if (open.tabId === tabId && same(open.to, script) && open.names.some((n) => same(n, name))) return open.source(name);
    }
    return found;
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

  return { abortAll, busy, cancel, chooseSave, copy, idle, noteSaveTarget, openBundled, planSave, prepareWrite };
}

export type { BundleJobResult, BundleSaveRefusal, BundleSender, createBundleJobs };

module.exports = { createBundleJobs };
