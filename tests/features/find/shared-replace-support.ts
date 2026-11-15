import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { cellOf, inertBody, sanitizeHtml } from "../../../src/bootstrap/richtext.ts";
import { findQueryChanged, mountFindEvents, startFind } from "../../../src/features/find/find.ts";
import type { SharedRewritePorts } from "../../../src/application/commands/document-edit.ts";
import type { CommonDocumentSession } from "../../../src/application/session/document-session.ts";
import { sharedRewritePorts } from "../../../src/bootstrap/wiring/ports/shared-rewrites.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { sharedUndoOwner } from "../../../src/bootstrap/wiring/ports/shared-undo.ts";
import { sharedCommandGuard, sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { operation, replicas } from "../../adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import type { fakeNotices } from "../fakes.ts";

export const FIND_ORDERS = ["D1", "rev", "dup"] as const;
export type FindOrder = typeof FIND_ORDERS[number];
export const FIND_AT = "2026-11-14T10:00:00.000Z";
const BAR = '<div id="findbar"><input id="find-input"><input id="replace-input"><span id="find-count"></span><button id="find-next"></button>' +
  '<button id="find-replace"></button><button id="find-replace-all"></button></div><div id="find-tag-row" hidden></div><button id="find-tag"></button>';

interface Reading { readonly read: CommonDocumentSession["read"]; readonly run: CommonDocumentSession["run"]; readonly subscribe: CommonDocumentSession["subscribe"] }
type Notices = ReturnType<typeof fakeNotices>;

export function findSource(cell: string, visual = false): Record<string, unknown> {
  return { schema: 2, docId: "d00000000000000000000000000000000", title: "",
    rows: [{ id: "R1", status: "todo", audioText: visual ? "" : cell, visualText: visual ? cell : "" }, { id: "R2", status: "todo", audioText: "a cup" }],
    comments: [{ id: "C1", author: "Ann", createdAt: FIND_AT, rowId: "R1", field: "audioText", anchorId: "C1", body: "note", quotedText: "cup", resolved: false, resolvedAt: null, resolvedBy: null }],
    productionTags: [{ id: "t_1", cat: "prop", name: "Gaffer tape", status: "needed" }],
    brollShots: [{ id: "S1", name: "Cup", status: "unshot", origin: "list" }] };
}

export function finder(session: Reading, notices: Notices, shared?: () => SharedRewritePorts | null, matchCase = false) {
  (globalThis as unknown as Record<string, unknown>).CSS = window.CSS;
  document.body.innerHTML = BAR;
  const mounted = startFind({
    sharedCommands: sharedCommandGuard(() => !!shared?.(), notices.notices),
    ...shared ? { shared } : {},
    document: { current: () => session.read(doc => doc), read: session.read, onChange: session.subscribe },
    edits: { edit: command => session.run(command).kind === "applied", run: session.run, stamps: bufferStamps("Alice", () => FIND_AT) },
    text: { cellOf, inertBody, sanitizeHtml },
    shotHiding: () => ({ reveal: () => {} }), undo: { breakCoalescing: () => {} }, notices: notices.notices,
    flags: { setFindOpen: () => {} }, options: { matchesCase: () => matchCase }, bulkTag: () => ({ hits: 0, inTags: 0, skipped: 0 }),
    present: { isOpen: () => false, setSearching: () => {}, jump: () => {}, onViewChange: () => () => {} }
  });
  const events = mountFindEvents({ matchesCase: () => matchCase, setMatchCase: () => {} });
  const input = (id: string, value: string) => { (document.getElementById(id) as HTMLInputElement).value = value; };
  const click = (id: string) => { (document.getElementById(id) as HTMLElement).click(); };
  return {
    search: (find: string, put: string) => { input("find-input", find); input("replace-input", put); findQueryChanged(); },
    next: () => click("find-next"),
    replace: () => click("find-replace"),
    replaceAll: () => click("find-replace-all"),
    dispose: () => { events.dispose(); mounted.dispose(); }
  };
}

export function findAct(route: ReturnType<typeof finder>, step: { readonly find: string; readonly put: string; readonly all?: boolean | undefined; readonly nth?: number }) {
  route.search(step.find, step.put);
  if (step.all) { route.replaceAll(); return; }
  for (let next = 0; next < (step.nth ?? 0); next++) route.next();
  route.replace();
}

export function findReplicas(document: Record<string, unknown>) {
  const set = replicas(2, document);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}

export function findCopy(handle: SharedDocumentHandle, name: string, notices: Notices) {
  const author = sharedAuthorPort({ handle: () => handle, name: () => name });
  const owner = sharedUndoOwner(handle, () => author.next(), () => 0, error => { throw error; });
  const harnessed = sharedHarness(adapterReplica(handle, owner), { refused: sharedCommandRefusalNotice(notices.notices) });
  const shared = sharedRewritePorts({ handle: () => handle, author: () => author.next(), stamps: bufferStamps(name, () => FIND_AT), cells: cellOf, readers: bufferReaders });
  return { owner, harness: harnessed, session: harnessed.session, shared };
}

interface FindRowCells { readonly audioText: unknown; readonly visualText: unknown; readonly updatedAt: unknown; readonly updatedBy: unknown }
export function rowCells(row: unknown): FindRowCells {
  const fields = row as Record<string, unknown>;
  return { audioText: fields.audioText, visualText: fields.visualText, updatedAt: fields.updatedAt, updatedBy: fields.updatedBy };
}
export function stampedCells(text: string, visual = false, by: string | null = "Alice"): FindRowCells {
  return { audioText: visual ? "" : text, visualText: visual ? text : "", updatedAt: by ? FIND_AT : "", updatedBy: by };
}
function project(handle: SharedDocumentHandle) {
  return projectSharedDocumentWithRecovery(handle).document.rows.map(rowCells);
}
function late(handle: SharedDocumentHandle) {
  const joiner = createSharedDocument();
  try { assert.equal(applySharedUpdate(joiner, encodeSharedState(handle)).ok, true); return project(joiner); } finally { destroySharedDocument(joiner); }
}
export function agreedRows(label: string, set: ReturnType<typeof findReplicas>, order: FindOrder = "D1") {
  const readings = [set.a, set.b].map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: project(handle) }));
  assertReplicasAgree(label, [...readings, { order: "late-C", replica: "C", output: late(set.a) }]);
  return readings[0]?.output ?? [];
}
export function deliverAll(queue: ReturnType<typeof replicas>["queue"], order: FindOrder) {
  for (let round = 0; round < 100 && queue.pending.length; round++) {
    const pending = [...queue.pending];
    if (order === "rev") pending.reverse();
    for (const message of pending) queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
  assert.equal(queue.pending.length, 0);
}
export function sendAs(handle: SharedDocumentHandle, ...values: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
export function typedAt(offset: number, end = false, id = "typed", value = "X") {
  const at = end ? { left: flowBaseReference("R1", "audioText", offset), right: null, affinity: "after" } : { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" };
  return { kind: "text-insert", id, by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, at, content: [{ value, marks: [] }] };
}
export function deletedAt(from: number, to: number, id = "cut") {
  return { kind: "text-delete", id, by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", from, to)] };
}
export const shownMessages = (notices: Notices) => notices.shown.map(item => [item.message, item.kind]);
