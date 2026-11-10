import type { JournalWorkerClient } from "../journal-client.ts";
import type { InstanceRecord, InstanceSnapshot } from "./storage.ts";

export class InstanceGateway {
  private readonly journal: JournalWorkerClient;
  private readonly phase: (name: string) => Promise<void>;
  constructor(journal: JournalWorkerClient, phase: (name: string) => Promise<void> = async () => {}) {
    this.journal = journal;
    this.phase = phase;
  }

  request(action: string, data: Record<string, unknown>): Promise<unknown> {
    return this.journal.instanceRequest(action, data, this.phase);
  }

  async create(operation: string, owner: string, invite: string): Promise<InstanceRecord> {
    return await this.request("create", { operation, owner, invite }) as InstanceRecord;
  }

  async authorize(id: string, token: string): Promise<InstanceRecord> {
    return await this.request("authorize", { id, token }) as InstanceRecord;
  }

  async authorizeBlob(id: string, token: string): Promise<void> {
    await this.request("authorize-blob", { id, token });
  }

  async initial(operation: string, owner: string): Promise<{ id: string; payload: Uint8Array }> {
    return await this.request("initial", { operation, owner }) as { id: string; payload: Uint8Array };
  }

  async capture(id: string): Promise<InstanceSnapshot> {
    return await this.request("capture", { id }) as InstanceSnapshot;
  }

  async recover(id: string): Promise<InstanceSnapshot> {
    return await this.request("recover", { id }) as InstanceSnapshot;
  }

  async checkpoint(snapshot: InstanceSnapshot): Promise<boolean> {
    return await this.request("checkpoint", { id: snapshot.document, sequence: snapshot.sequence, payload: snapshot.payload }) as boolean;
  }

  async prune(id: string): Promise<number> {
    return await this.request("prune", { id }) as number;
  }
}
