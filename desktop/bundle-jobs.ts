"use strict";

import type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier } from "./bundle-copy.ts";

type BundleSender = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type BundleJobResult = BundleCopyResult | { ok: false; code: "DROPPED" | "UNKNOWN" | "NO_FOLDER" };
type BundleSaveRefusal = { reason: "clash" | "failed" | "cancelled"; folder: string; name: string; copied: number };

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
}

const SAVE_TARGETS_MAX = 50;
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
    saveTargets.set(fileId, { tabId: tab.id, from });
  }

  function carryForSave(fileId: string, text: () => string, sender: BundleSender): Promise<BundleSaveRefusal | null> {
    const noted = saveTargets.get(fileId);
    const to = pathOf(fileId);
    if (!noted || !noted.from || !to || same(noted.from, to)) return Promise.resolve(null);
    const from = noted.from;
    const names = namesInProject(text());
    if (!names.length) return Promise.resolve(null);
    const job = "carry" + (++carries);
    const note = (done: number, total: number, result?: BundleCarryResult) => tell(sender, (s) => s.send("splitpage:bundle-carry", {
      job, from: copier.folderName(from), to: copier.folderName(to), done, total, ...(result ? { result } : {})
    }));
    const refusal = (result: BundleCarryResult): BundleSaveRefusal | null =>
      (result.ok ? null : { reason: REFUSALS[result.code] as BundleSaveRefusal["reason"], folder: copier.folderName(to), name: result.name, copied: result.copied });
    return new Promise((finish) => {
      let settled = false;
      let committed = 0;
      const done = (result: BundleCarryResult) => {
        if (settled) return;
        settled = true;
        note(1, 1, result);
        finish(refusal(result));
      };
      enqueue({
        key: keyOf(sender, job), sender, job, ctl: new AbortController(),
        stop: (code) => done({ ok: false, code, name: "", copied: committed }),
        run: async (_progress, signal) => {
          done(await copier.carry(from, to, names, allow, (d, t) => note(d, t), signal, (n) => { committed = n; }));
        }
      });
    });
  }

  function saveLanded(fileId: string): void {
    saveTargets.delete(fileId);
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

  return { abortAll, busy, cancel, carryForSave, copy, idle, noteSaveTarget, saveLanded };
}

export type { BundleJobResult, BundleSaveRefusal, BundleSender, createBundleJobs };

module.exports = { createBundleJobs };
