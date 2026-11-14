import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, operation, ref } from "../../adapters/collab/executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";
import { recoveryPanelPorts } from "../../../src/bootstrap/wiring/recovery-panel.ts";
import { createRecoveryPanel } from "../../../src/features/recovery-panel/mount.ts";
import { startRecoveryPanelActions } from "../../../src/features/recovery-panel/actions.ts";
import type { RecoveryPanelPorts } from "../../../src/features/recovery-panel/ports.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { htmlToPlainText } from "../../../src/bootstrap/plain-text.ts";
import { fakeNotices } from "../fakes.ts";

export function send(handle: SharedDocumentHandle, ...ops: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}

export function fixture(source: Record<string, unknown> = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] }, copies = 2) {
  const set = replicas(copies, source), runtime = createFlowLoadRuntime();
  for (const handle of [set.a, set.b, ...(copies === 3 ? [set.c] : [])]) registerSharedOperationFamilies(handle, runtime);
  return set;
}

export const removeBeat = { kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1"],
  observed: [flowBaseReference("R1", "audioText", 0, 4)], boundaries: ["R1"], components: [], gallery: [], at: 0 };

export function mark(handle: SharedDocumentHandle, id: string, from: number, to: number, tag: string): void {
  const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
  const record = prepareSharedMarkRecord(handle, target, id, from, to, { type: "add", mark: { kind: "tag", id, value: tag } });
  assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, target, id, record), { ok: true });
}

export function fragment(handle: SharedDocumentHandle): void {
  transactSharedDocument(handle, "local-command", () => {
    const segment = collabState(handle).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map); segment.set("head", null);
  });
}

export function page(handle: SharedDocumentHandle, name = "Bob") {
  let serial = 0;
  const undo = sharedUndoOwner(handle, () => ({ id: "reverse" + ++serial, by: name }), () => 0, error => { throw error; });
  const h = sharedHarness(adapterReplica(handle, undo)), notices = fakeNotices(), registry = createActionRegistry();
  const host = document.body.appendChild(document.createElement("div")), listeners = new Set<() => void>();
  const state = { shared: true, author: true, parts: true, badIdentity: false };
  const ports: RecoveryPanelPorts = recoveryPanelPorts({ host, session: { current: () => state.shared ? h.session : null,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    document: { current: () => h.session.read(doc => doc) }, text: { htmlToPlainText },
    parts: () => state.parts ? { handle, author: { next: () => state.author ? { id: state.badIdentity ? " " : "action" + ++serial, by: name } : null } } : null,
    run: h.session.run, notices: notices.notices });
  const panel = createRecoveryPanel(ports), off = startRecoveryPanelActions({ registry, current: () => panel, session: ports.session });
  const open = () => { assert.equal(registry.invoke("recovery", "command-menu").kind, "ran"); };
  return { h, undo, notices, registry, state, ports, panel, host, open,
    mode: () => { for (const listener of listeners) listener(); },
    close: () => { off(); panel.dispose(); h.session.dispose(); host.remove(); } };
}

export function rows(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>("article")].map(row => ({ kind: row.dataset.recoveryKind,
    label: row.querySelector("h3")?.textContent, by: row.querySelector("p")?.textContent, text: row.querySelector("pre")?.textContent,
    actions: [...row.querySelectorAll("button")].map(button => button.textContent) }));
}

export function click(host: HTMLElement, kind: string, label: string): void {
  const row = host.querySelector('[data-recovery-kind="' + kind + '"]'); assert.ok(row);
  const button = [...row.querySelectorAll("button")].find(button => button.textContent === label); assert.ok(button); button.click();
}
