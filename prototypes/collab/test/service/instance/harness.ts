import assert from "node:assert/strict";
import * as Y from "yjs";
import { NodeInstanceReplica, MemoryCompletionStore, instanceRequest } from "../../../src/service/instance/client.ts";
import { readFrame } from "../../../src/service/wire.ts";
import { until } from "../harness.ts";
import type { JournalChild } from "../harness.ts";

export const OWNER = "owner-management-fixture-1377";
export const INVITE = "editor-invitation-fixture-1377";

export async function createFixture(server: JournalChild, operation = "creation-k", text = "abcd"): Promise<{ id: string; source: Y.Doc }> {
  const source = new Y.Doc();
  source.clientID = 7;
  source.getText("R1").insert(0, text);
  source.clientID = 11;
  try {
    const record = await instanceRequest(server.port, OWNER, { action: "create", operation, invite: INVITE });
    await instanceRequest(server.port, OWNER, { action: "upload", operation, payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64") });
    await instanceRequest(server.port, OWNER, { action: "commit", operation });
    return { id: String(record.id), source };
  } catch (error) { source.destroy(); throw error; }
}

export async function joinFixture(server: JournalChild, id: string, token = INVITE, store = new MemoryCompletionStore()): Promise<NodeInstanceReplica> {
  const client = new NodeInstanceReplica(server.port, id, token, store);
  try {
    await client.connect();
    await until(() => client.hydrated, "replica hydration");
    await until(() => client.receipts.outstanding === 0 && client.provider.synced, "initial exchange receipts");
    await client.settled();
    assert.equal(client.status, "Saved on this device");
    return client;
  } catch (error) { client.destroy(); throw error; }
}

export function acknowledged(client: NodeInstanceReplica): Uint8Array[] {
  const pending: Uint8Array[] = [];
  const accepted: Uint8Array[] = [];
  for (const event of client.frames) {
    const frame = readFrame(event.bytes);
    if (event.direction === "out" && frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) pending.push(frame.payload);
    if (event.direction === "in" && frame.kind === 8) {
      const sent = pending.shift();
      assert.ok(sent, "Receipt requires actual transmission");
      if (frame.subtype === 1) accepted.push(sent);
    }
  }
  return accepted;
}

export async function captureCheckpoint(server: JournalChild, id: string, label = "checkpoint"): Promise<void> {
  await server.command("instance-capture", { document: id, label }, "instance-captured");
}

export async function checkpoint(server: JournalChild, id: string, label = "checkpoint"): Promise<void> {
  await captureCheckpoint(server, id, label);
  await server.command("instance-checkpoint", { label }, "instance-checkpointed");
}

export async function waitGate(server: JournalChild, phase: string): Promise<void> {
  await until(() => server.events.some(event => event.event === `instance-${phase}`), phase);
}

export function releaseGate(server: JournalChild, phase: string): void {
  server.child.send({ command: "release", gate: `instance-${phase}` });
}
