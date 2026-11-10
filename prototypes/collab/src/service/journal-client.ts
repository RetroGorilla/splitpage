import { Worker } from "node:worker_threads";

export class JournalWorkerClient {
  readonly worker: Worker;
  readonly ready: Promise<{ journalMode: string; synchronous: number }>;
  private next = 1;
  private terminalError: Error | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; onMutationBeforeCommit?: () => void }>();

  constructor(path: string, settings: { journalMode: string; synchronous: string }) {
    this.worker = new Worker(new URL("./journal-worker.ts", import.meta.url), { workerData: { path, ...settings } });
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve: value => resolve(value as { journalMode: string; synchronous: number }), reject }));
    this.worker.on("message", (message: { id: number; value?: unknown; error?: string; phase?: string }) => {
      const pending = this.pending.get(message.id);
      if (message.phase === "mutation-before-commit") {
        pending?.onMutationBeforeCommit?.();
        this.worker.postMessage({ id: message.id, command: "commit-mutation" });
        return;
      }
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    });
    this.worker.on("error", (error: Error) => this.fail(error));
    this.worker.on("exit", code => this.fail(new Error(`Journal worker exited (${code})`)));
  }

  private fail(error: Error): void {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) pending.reject(this.terminalError);
    this.pending.clear();
  }

  private request(command: string, document = "", payloads: readonly Uint8Array[] = [], onMutationBeforeCommit?: () => void): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(onMutationBeforeCommit ? { onMutationBeforeCommit } : {}) });
      this.worker.postMessage({ id, command, document, payloads, mutation: Boolean(onMutationBeforeCommit) });
    });
  }

  async append(document: string, payloads: readonly Uint8Array[], onMutationBeforeCommit?: () => void): Promise<number[]> {
    return await this.request("append", document, payloads, onMutationBeforeCommit) as number[];
  }

  async read(document: string): Promise<{ sequence: number; payload: Uint8Array }[]> {
    return await this.request("read", document) as { sequence: number; payload: Uint8Array }[];
  }

  async close(): Promise<void> {
    await this.request("close");
    await this.worker.terminate();
  }
}
