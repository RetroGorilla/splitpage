"use strict";

import type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier } from "./bundle-copy.ts";

type BundleSender = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type BundleJobResult = BundleCopyResult | { ok: false; code: "DROPPED" };

interface BundleCopyJob {
  readonly kind: "copy";
  readonly key: string;
  readonly sender: BundleSender;
  readonly job: string;
  readonly tabId: string;
  readonly source: string;
  readonly script: string;
  readonly mirrors: string[];
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
  readonly ctl: AbortController;
}

type BundleJob = BundleCopyJob | BundleCarryJob;

const SAVE_TARGETS_MAX = 50;

function createBundleJobs(options: {
  copier: ReturnType<typeof createBundleCopier>;
  allow: RegExp;
  scriptOfTab: (tabId: string) => string | null;
  pathOf: (fileId: string) => string | null;
  foldCase?: boolean;
}) {
  const { copier, allow, scriptOfTab, pathOf } = options;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const queue: BundleJob[] = [];
  const byKey = new Map<string, BundleJob>();
  const saveTargets = new Map<string, { tabId: string; from: string | null }>();
  let running: BundleJob | null = null;
  let carries = 0;
  let idleWaiters: (() => void)[] = [];

  const same = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keyOf = (sender: BundleSender, job: string) => String(sender.id) + ":" + job;
  const lastScriptOf = (job: BundleCopyJob) => job.mirrors.length ? job.mirrors[job.mirrors.length - 1] as string : job.script;

  function savingTo(job: BundleCopyJob, now: string): boolean {
    for (const [fileId, noted] of saveTargets) {
      if (noted.tabId !== job.tabId || !noted.from || !same(noted.from, lastScriptOf(job))) continue;
      const to = pathOf(fileId);
      if (to && same(to, now)) return true;
    }
    return false;
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

  async function runCopy(job: BundleCopyJob): Promise<BundleJobResult> {
    if (job.ctl.signal.aborted) return { ok: false, code: "CANCELLED" };
    const now = scriptOfTab(job.tabId);
    if (!now || !([job.script, ...job.mirrors].some((s) => same(s, now)) || savingTo(job, now))) return { ok: false, code: "DROPPED" };
    const progress: BundleProgress = (done, total) => tell(job.sender, (to) => to.send("splitpage:bundle-progress", { job: job.job, done, total }));
    let result = await copier.copyIn(job.source, job.script, allow, progress, job.ctl.signal);
    let at = job.script;
    for (let i = 0; result.ok && i < job.mirrors.length; i++) {
      const next = job.mirrors[i] as string;
      result = await copier.copyOn(at, result.name, next, allow, progress, job.ctl.signal);
      at = next;
    }
    return result;
  }

  async function runCarry(job: BundleCarryJob): Promise<void> {
    const note = (done: number, total: number, result?: BundleCarryResult) => tell(job.sender, (to) => to.send("splitpage:bundle-carry", {
      job: job.job, from: copier.folderName(job.from), to: copier.folderName(job.to), done, total, ...(result ? { result } : {})
    }));
    if (job.ctl.signal.aborted) { note(0, 0, { ok: false, code: "CANCELLED", copied: 0 }); return; }
    const names = await copier.namesIn(job.from, allow);
    if (!names.length) return;
    const result = await copier.carry(job.from, job.to, names, allow, (done, total) => note(done, total), job.ctl.signal);
    note(names.length, names.length, result);
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
      if (job.kind === "copy") job.finish(await runCopy(job));
      else await runCarry(job);
    } catch {
      if (job.kind === "copy") job.finish({ ok: false, code: "FAILED" });
    } finally {
      if (byKey.get(job.key) === job) byKey.delete(job.key);
      running = null;
      void pump();
    }
  }

  function copy(sender: BundleSender, tabId: string, job: string, source: string, script: string): Promise<BundleJobResult> {
    return new Promise((finish) => {
      enqueue({ kind: "copy", key: keyOf(sender, job), sender, job, tabId, source, script, mirrors: [], ctl: new AbortController(), finish });
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

  function saveLanded(fileId: string, sender: BundleSender): void {
    const noted = saveTargets.get(fileId);
    if (!noted) return;
    saveTargets.delete(fileId);
    const to = pathOf(fileId);
    if (!noted.from || !to || same(noted.from, to)) return;
    const from = noted.from;
    for (const job of [running, ...queue]) {
      if (job && job.kind === "copy" && job.tabId === noted.tabId && same(lastScriptOf(job), from)) job.mirrors.push(to);
    }
    const job = "carry" + (++carries);
    enqueue({ kind: "carry", key: keyOf(sender, job), sender, job, from, to, ctl: new AbortController() });
  }

  function idle(): Promise<void> {
    if (!running && !queue.length) return Promise.resolve();
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  return { cancel, copy, idle, noteSaveTarget, saveLanded };
}

export type { BundleJobResult, BundleSender, createBundleJobs };

module.exports = { createBundleJobs };
