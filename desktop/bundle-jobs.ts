"use strict";

import type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier } from "./bundle-copy.ts";

type BundleSender = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type BundleJobResult = BundleCopyResult | { ok: false; code: "DROPPED" | "UNKNOWN" | "NO_FOLDER" };
type BundleSavePlan = { ok: true } | { ok: false; folder: string; name: string };

interface BundleCopyJob {
  readonly kind: "copy" | "follow";
  readonly key: string;
  readonly sender: BundleSender;
  readonly job: string;
  readonly tabId: string;
  readonly run: (progress: BundleProgress, signal: AbortSignal) => Promise<BundleJobResult>;
  readonly ctl: AbortController;
  readonly finish: (result: BundleJobResult) => void;
}

interface BundleCarryJob {
  readonly kind: "carry";
  readonly key: string;
  readonly sender: BundleSender;
  readonly job: string;
  readonly from: string;
  readonly to: string;
  readonly names: readonly string[];
  readonly ctl: AbortController;
}

type BundleJob = BundleCopyJob | BundleCarryJob;

interface SaveTarget {
  readonly tabId: string;
  readonly from: string | null;
  names: readonly string[];
}

const SAVE_TARGETS_MAX = 50;
const FINISHED_MAX = 500;
const MOVES_MAX = 20;

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
  const finished = new Map<string, { tabId: string; script: string; name: string }>();
  const moves = new Map<string, { from: string; to: string }[]>();
  let running: BundleJob | null = null;
  let carries = 0;
  let idleWaiters: (() => void)[] = [];

  const same = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keyOf = (sender: BundleSender, job: string) => String(sender.id) + ":" + job;

  function reaches(tabId: string, from: string, to: string): boolean {
    const seen: string[] = [from];
    for (let i = 0; i < seen.length; i++) {
      const at = seen[i] as string;
      if (same(at, to)) return true;
      for (const m of moves.get(tabId) || []) if (same(m.from, at) && !seen.some((s) => same(s, m.to))) seen.push(m.to);
    }
    return false;
  }

  function savingTo(tabId: string, from: string, now: string): boolean {
    for (const [fileId, noted] of saveTargets) {
      if (noted.tabId !== tabId || !noted.from || !same(noted.from, from)) continue;
      const to = pathOf(fileId);
      if (to && same(to, now)) return true;
    }
    return false;
  }

  function remember(key: string, record: { tabId: string; script: string; name: string }): void {
    finished.delete(key);
    if (finished.size >= FINISHED_MAX) finished.delete(finished.keys().next().value as string);
    finished.set(key, record);
  }

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

  async function runCarry(job: BundleCarryJob): Promise<void> {
    const note = (done: number, total: number, result?: BundleCarryResult) => tell(job.sender, (to) => to.send("splitpage:bundle-carry", {
      job: job.job, from: copier.folderName(job.from), to: copier.folderName(job.to), done, total, ...(result ? { result } : {})
    }));
    if (job.ctl.signal.aborted) { note(job.names.length, job.names.length, { ok: false, code: "CANCELLED", copied: 0 }); return; }
    const result = await copier.carry(job.from, job.to, job.names, allow, (done, total) => note(done, total), job.ctl.signal);
    note(job.names.length, job.names.length, result);
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
      if (job.kind === "carry") await runCarry(job);
      else if (job.ctl.signal.aborted) job.finish({ ok: false, code: "CANCELLED" });
      else {
        const progress: BundleProgress = (done, total) => tell(job.sender, (to) => to.send("splitpage:bundle-progress", { job: job.job, done, total }));
        job.finish(await job.run(progress, job.ctl.signal));
      }
    } catch {
      if (job.kind !== "carry") job.finish({ ok: false, code: "FAILED" });
    } finally {
      if (byKey.get(job.key) === job) byKey.delete(job.key);
      running = null;
      void pump();
    }
  }

  function submit(kind: "copy" | "follow", sender: BundleSender, tabId: string, job: string, run: BundleCopyJob["run"]): Promise<BundleJobResult> {
    return new Promise((finish) => {
      enqueue({ kind, key: keyOf(sender, job), sender, job, tabId, run, ctl: new AbortController(), finish });
    });
  }

  function copy(sender: BundleSender, tabId: string, job: string, source: string, script: string): Promise<BundleJobResult> {
    const key = keyOf(sender, job);
    return submit("copy", sender, tabId, job, async (progress, signal) => {
      const now = scriptOfTab(tabId);
      if (!now) return { ok: false, code: "DROPPED" };
      const into = reaches(tabId, script, now) ? now : savingTo(tabId, script, now) ? script : null;
      if (!into) return { ok: false, code: "DROPPED" };
      const result = await copier.copyIn(source, into, allow, progress, signal);
      if (result.ok) remember(key, { tabId, script: into, name: result.name });
      return result;
    });
  }

  function follow(sender: BundleSender, tabId: string, job: string): Promise<BundleJobResult> {
    const key = keyOf(sender, job);
    const record = finished.get(key);
    if (!record || record.tabId !== tabId) return Promise.resolve({ ok: false, code: "UNKNOWN" });
    return submit("follow", sender, tabId, job, async (progress, signal) => {
      const now = scriptOfTab(tabId);
      if (!now) return { ok: false, code: "NO_FOLDER" };
      if (same(record.script, now)) return { ok: true, name: record.name };
      if (!reaches(tabId, record.script, now)) return { ok: false, code: "REFUSED" };
      const result = await copier.copyOn(record.script, record.name, now, allow, progress, signal);
      if (result.ok) remember(key, { tabId, script: now, name: result.name });
      return result;
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
    saveTargets.set(fileId, { tabId: tab.id, from, names: [] });
  }

  async function planSave(fileId: string, text: string): Promise<BundleSavePlan> {
    const noted = saveTargets.get(fileId);
    const to = pathOf(fileId);
    if (!noted || !noted.from || !to || same(noted.from, to)) return { ok: true };
    const names = namesInProject(text);
    const clash = await copier.clashIn(noted.from, to, names, allow);
    if (clash) return { ok: false, folder: copier.folderName(to), name: clash };
    noted.names = names;
    return { ok: true };
  }

  function saveLanded(fileId: string, sender: BundleSender): void {
    const noted = saveTargets.get(fileId);
    if (!noted) return;
    saveTargets.delete(fileId);
    const to = pathOf(fileId);
    if (!noted.from || !to || same(noted.from, to)) return;
    const list = moves.get(noted.tabId) || [];
    list.push({ from: noted.from, to });
    if (list.length > MOVES_MAX) list.shift();
    moves.set(noted.tabId, list);
    if (!noted.names.length) return;
    const job = "carry" + (++carries);
    enqueue({ kind: "carry", key: keyOf(sender, job), sender, job, from: noted.from, to, names: noted.names, ctl: new AbortController() });
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

  return { abortAll, busy, cancel, copy, follow, idle, noteSaveTarget, planSave, saveLanded };
}

export type { BundleJobResult, BundleSavePlan, BundleSender, createBundleJobs };

module.exports = { createBundleJobs };
