import { Worker } from "node:worker_threads";

export class JournalWorkerClient {
  readonly worker: Worker;
  readonly ready: Promise<{ journalMode: string; synchronous: number }>;
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(path: string, settings: { journalMode: string; synchronous: string }) {
    this.worker = new Worker(new URL("./journal-worker.ts", import.meta.url), { workerData: { path, ...settings } });
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve: value => resolve(value as { journalMode: string; synchronous: number }), reject }));
    this.worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    });
    this.worker.on("error", (error: Error) => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
    this.worker.on("exit", code => {
      for (const pending of this.pending.values()) pending.reject(new Error(`Journal worker exited with pending work (${code})`));
      this.pending.clear();
    });
  }

  private request(command: string, document = "", payloads: readonly Uint8Array[] = []): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, command, document, payloads });
    });
  }

  async append(document: string, payloads: readonly Uint8Array[]): Promise<number[]> {
    return await this.request("append", document, payloads) as number[];
  }

  async read(document: string): Promise<{ sequence: number; payload: Uint8Array }[]> {
    return await this.request("read", document) as { sequence: number; payload: Uint8Array }[];
  }

  async close(): Promise<void> {
    await this.request("close");
    await this.worker.terminate();
  }
}
