import type { SharedFileInfo, SharedFileResult } from "../../../shared/shared-file-copy.d.ts";

export type FileCopyMode = "check" | "overwrite" | "new" | "export";
export type FileCopyProblem = "changed" | "unavailable" | "missing";
export type FileCopyWritten = Extract<SharedFileResult, { kind: "file-copy-written" }>;
type DepartureChoice = Extract<SharedFileResult, { kind: "file-copy-choice" }>["choice"];
export interface FileCopyReads {
  readonly read: () => { readonly file: SharedFileInfo | null; readonly problem: FileCopyProblem | null };
  readonly subscribe: (listener: () => void) => () => void;
}

interface FileCopyPorts {
  readonly now: () => number;
  readonly startTimer: (run: () => void, delay: number) => () => void;
  readonly capture: (file: SharedFileInfo, mode: FileCopyMode) => Promise<{ bytes: Uint8Array; missing: number; docId: string }>;
  readonly write: (bytes: Uint8Array, missing: number, mode: FileCopyMode, docId: string) => Promise<SharedFileResult>;
  readonly forget: () => Promise<boolean>;
  readonly publish: (file: SharedFileInfo | null, problem: FileCopyProblem | null) => void;
}

export function createFileCopy(initial: SharedFileInfo, ports: FileCopyPorts, freshRevision?: number) {
  let file: SharedFileInfo | null = initial;
  let problem: FileCopyProblem | null = null;
  let revision = freshRevision ?? -1;
  let pictures = 0;
  let writtenRevision = freshRevision ?? -1;
  let writtenPictures = freshRevision === undefined ? -1 : 0;
  let lastAttempt = -Infinity;
  let lastEdit = ports.now();
  let disposed = false;
  let suspended = 0;
  let stopTimer: (() => void) | undefined;
  let queue = Promise.resolve<unknown>(undefined);
  const pending = () => revision !== writtenRevision || pictures !== writtenPictures;

  function publish(next: FileCopyProblem | null) {
    problem = next;
    if (!disposed) ports.publish(file, problem);
  }

  function cancelTimer() {
    stopTimer?.();
    stopTimer = undefined;
  }

  function schedule() {
    cancelTimer();
    if (disposed || suspended || !file || problem || !pending()) return;
    const due = Math.max(lastEdit + 2000, lastAttempt + 30_000);
    stopTimer = ports.startTimer(() => { void flush(false); }, Math.max(0, due - ports.now()));
  }

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  }

  function flush(requireComplete: boolean, mode: FileCopyMode = "check") {
    cancelTimer();
    return enqueue(async (): Promise<FileCopyWritten | FileCopyProblem | null> => {
      if (disposed || !file) return null;
      lastAttempt = ports.now();
      const capturedRevision = revision;
      const capturedPictures = pictures;
      try {
        const { bytes, missing, docId } = await ports.capture(file, mode);
        if (disposed) return null;
        if (requireComplete && missing) return "missing";
        const result = await ports.write(bytes, missing, mode, docId);
        if (result.kind === "file-copy-written") {
          if (mode === "export") return result;
          file = result.file;
          writtenRevision = capturedRevision;
          writtenPictures = capturedPictures;
          publish(null);
          return result;
        }
        if (result.kind === "file-copy" && !result.file) {
          file = null;
          publish(null);
          return null;
        }
        const failed = result.kind === "file-copy-problem" ? result.problem : "unavailable";
        publish(failed);
        return failed;
      } catch {
        publish("unavailable");
        return "unavailable";
      } finally { schedule(); }
    });
  }

  async function beforeDeparture(choose: (problem: FileCopyProblem) => Promise<DepartureChoice>) {
    suspended++;
    cancelTimer();
    try {
      let mode: FileCopyMode = "check";
      while (!disposed) {
        const result = await flush(true, mode);
        if (typeof result !== "string") {
          if (!result || revision === writtenRevision) return result;
          mode = "check";
          continue;
        }
        const choice = await choose(result);
        if (choice === "cancel") return false;
        if (choice === "continue") return null;
        mode = choice === "new" ? "new" : "check";
      }
      return false;
    } finally {
      suspended--;
      schedule();
    }
  }

  publish(null);
  return {
    changed(nextRevision: number) {
      if (revision === nextRevision) return;
      revision = nextRevision;
      lastEdit = ports.now();
      schedule();
    },
    picturesChanged() {
      if (!pending() && !file?.missing) return;
      pictures++;
      lastEdit = ports.now();
      schedule();
    },
    flush,
    pending,
    beforeDeparture,
    stop() {
      cancelTimer();
      return enqueue(async () => {
        if (disposed || !file) return true;
        if (!await ports.forget()) { publish("unavailable"); return false; }
        file = null;
        publish(null);
        return true;
      });
    },
    info: () => file,
    dispose() { disposed = true; cancelTimer(); }
  };
}
