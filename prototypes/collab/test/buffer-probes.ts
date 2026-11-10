import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { BufferHarness } from "../src/buffer-harness.ts";
import { BufferMappingError } from "../src/editing-buffer.ts";
import type { BufferMechanism } from "../src/editing-buffer.ts";
import type { DeliveryOrder } from "../src/delivery.ts";
import { readReplica } from "../src/reader.ts";
import type { SchemaCandidate, SchemaReplica } from "../src/schema.ts";
import { mapValue } from "../src/schema.ts";
import { bufferOracles } from "./buffer-oracles.ts";
import { stageTrace } from "./buffer-runner.ts";

export interface BufferProbeEvidence {
  trace: string;
  mechanism: BufferMechanism;
  candidate: SchemaCandidate;
  order: DeliveryOrder;
  status: "PASS" | "FAIL";
  shows: string;
  difference: string | null;
  history: string[];
  observed: unknown;
}

export function observeBuffers(harness: BufferHarness): unknown {
  const anchors = harness.alice.caret ? new Map([["A", harness.alice.caret]]) : new Map();
  const summary = (replica: SchemaReplica): unknown => {
    const model = readReplica(replica.doc, replica.candidate, harness.identities, anchors);
    const row = (value: typeof model.rows[number]): unknown => ({
      id: value.id,
      text: value.characters.map(character => character.value).join(""),
      identities: value.characters.map(character => `${character.notation}(${character.identity?.client}:${character.identity?.clock})`),
      marks: value.characters.filter(character => Object.keys(character.marks).length > 0).map(character => [character.notation, character.marks])
    });
    return { rows: model.rows.map(row), carets: model.carets, recovery: model.recovery.map(entry => ({ row: row(entry.row), by: entry.by, edited: entry.edited })) };
  };
  return Object.fromEntries([...harness.sessions].map(([name, session]) => [name, {
    E: summary(session.editor),
    ...(session.editor === session.network ? {} : { N: summary(session.network) }),
    native: session.nativeValue,
    dirty: session.dirty,
    heldBytes: session.heldBytes,
    transportPending: harness.queue.pending.filter(message => message.to === name).length
  }]));
}

function evidence(harness: BufferHarness, trace: string, mechanism: BufferMechanism, candidate: SchemaCandidate, order: DeliveryOrder, shows: string, check: () => void): BufferProbeEvidence {
  let difference: string | null = null;
  try {
    check();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    difference = error.message;
  }
  return { trace, mechanism, candidate, order, status: difference ? "FAIL" : "PASS", shows, difference, history: harness.history(), observed: observeBuffers(harness) };
}

export function probeAmbiguousDiff(candidate: SchemaCandidate, mechanism: BufferMechanism): BufferProbeEvidence {
  const harness = new BufferHarness(candidate, mechanism, bufferOracles.T03.seed);
  try {
    stageTrace(harness, "T03", "D3");
    harness.alice.targetEvidence = false;
    return evidence(harness, "T03-no-target-ranges", mechanism, candidate, "D3", "Strings alone cannot identify which repeated word was deleted; the native buffer remains recoverable.", () => harness.alice.commit([]));
  } finally {
    harness.destroy();
  }
}

export function probeQueueBound(candidate: SchemaCandidate, mechanism: "M1" | "M3"): BufferProbeEvidence {
  const harness = new BufferHarness(candidate, mechanism, bufferOracles.T04.seed);
  try {
    harness.alice.paint("R1", 2);
    harness.alice.dispatch({ type: "compositionstart", from: 2, to: 2 });
    harness.alice.dispatch({ type: "compositionupdate", data: "x" });
    harness.bob.editor.insert("R1", 0, "Z", ["b1"]);
    harness.bob.editor.deleteIdentities(["s4"]);
    const first = harness.queue.pending[0];
    const second = harness.queue.pending[1];
    if (!first || !second) throw new Error("Queue-bound probe needs two distinct updates");
    harness.alice.queueLimitBytes = first.update.length;
    harness.queue.deliver(first.id);
    return evidence(harness, "T04-long-composition", mechanism, candidate, "D3", "A held composition fills the bounded queue. The overflow update stays in the transport; M3 also retains it in N. This path stops at the bound.", () => harness.queue.deliver(second.id));
  } finally {
    harness.destroy();
  }
}

function reconcileFromCurrentReplica(replica: SchemaReplica, desired: string, names: readonly string[]): void {
  const characters = replica.characters().filter(character => character.beat === "R1");
  const current = characters.map(character => character.value).join("");
  let prefix = 0;
  while (prefix < Math.min(current.length, desired.length) && current[prefix] === desired[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(current.length, desired.length) - prefix && current[current.length - suffix - 1] === desired[desired.length - suffix - 1]) suffix++;
  replica.doc.transact(() => {
    replica.deleteIdentities(characters.slice(prefix, current.length - suffix).map(character => replica.identities.notation(character.identity)));
    replica.insert("R1", prefix, desired.slice(prefix, desired.length - suffix), names.slice(prefix, desired.length - suffix));
  }, replica.localOrigin);
}

export function probeRecapturedBase(candidate: SchemaCandidate, mechanism: BufferMechanism, trace: "T02" | "T04"): BufferProbeEvidence {
  if (trace === "T04" && mechanism !== "M2") throw new Error("The controlled M1/M3 gate freezes E during composition; T02 tests their pre-buffer stale paint");
  const harness = new BufferHarness(candidate, mechanism, bufferOracles[trace].seed);
  try {
    if (trace === "T02") {
      harness.alice.paint("R1", 2);
      harness.alice.paintHeld = true;
      harness.bob.editor.insert("R1", 0, "X", ["b1"]);
      harness.queue.deliverFrom("B", "D3");
      harness.alice.history.push("wrong input handler captures replica Xab as the base for native abc");
      reconcileFromCurrentReplica(harness.alice.editor, "abc", ["x1", "x2", "a1"]);
    } else {
      stageTrace(harness, "T04", "D3");
      harness.alice.history.push("wrong composition input handler captures replica Zabc as the base for native abxycd");
      reconcileFromCurrentReplica(harness.alice.editor, "abxycd", ["x1", "x2", "a1", "a2", "x3", "x4"]);
    }
    const { text, start } = harness.alice.editor.locate("R1");
    harness.alice.caret = { position: Y.createRelativePositionFromTypeIndex(text, start + (trace === "T02" ? 3 : 4), -1) };
    harness.queue.flush("D3");
    return evidence(harness, `${trace}-recaptured-base`, mechanism, candidate, "D3", "Reconciliation against a replica base newer than the paint deletes Bob's character and replaces retained identities.", () => harness.check(bufferOracles[trace].expected));
  } finally {
    harness.destroy();
  }
}

export function probeDeleteFirst(candidate: SchemaCandidate, mechanism: BufferMechanism, order: "D1" | "D3"): BufferProbeEvidence {
  const harness = new BufferHarness(candidate, mechanism, bufferOracles["T01 composition"].seed);
  try {
    stageTrace(harness, "T01 composition", order);
    harness.alice.composing = false;
    harness.alice.commit(["a1"], "delete-first");
    harness.queue.flush(order);
    return evidence(harness, "T01-composition-delete-first", mechanism, candidate, order, "Deleting the observed range before inserting beta changes the CRDT gap: aXβd instead of aβXd unless M2 already integrated X.", () => harness.check(bufferOracles["T01 composition"].expected));
  } finally {
    harness.destroy();
  }
}

export function probeMissingRecovery(candidate: SchemaCandidate): BufferProbeEvidence {
  const harness = new BufferHarness(candidate, "M2", bufferOracles["T04 removed"].seed);
  try {
    stageTrace(harness, "T04 removed", "D3");
    return evidence(harness, "T04-removed-no-recovery-mapping", "M2", candidate, "D3", "Mapping only into active beats has no insertion target. An explicit recovery destination is required; the native buffer is retained.", () => {
      const removed = mapValue(mapValue(harness.alice.editor.doc.getMap("beats").get("R1")).get("removals")).size > 0;
      if (removed) throw new BufferMappingError("Painted target R1 is removed; active-only mapping has no destination");
      harness.alice.commit(["a1", "a2"]);
    });
  } finally {
    harness.destroy();
  }
}

function NoSocket(): never {
  throw new Error("The provider probe must not open a socket");
}

function providerFrame(update: Uint8Array): Uint8Array {
  const frame = [5, 112, 114, 111, 98, 101, 0, 2];
  let length = update.length;
  while (length > 127) {
    frame.push((length & 127) | 128);
    length >>>= 7;
  }
  frame.push(length);
  return Uint8Array.from([...frame, ...update]);
}

export function probeProviderBypass(candidate: SchemaCandidate): BufferProbeEvidence {
  const harness = new BufferHarness(candidate, "M1", bufferOracles.T04.seed);
  const socket = new HocuspocusProviderWebsocket({ url: "ws://unused.invalid", autoConnect: false, WebSocketPolyfill: NoSocket });
  let provider: HocuspocusProvider | null = null;
  try {
    provider = new HocuspocusProvider({ name: "probe", document: harness.alice.editor.doc, awareness: null, websocketProvider: socket });
    harness.alice.paint("R1", 2);
    harness.alice.dispatch({ type: "compositionstart", from: 2, to: 2 });
    harness.alice.dispatch({ type: "compositionupdate", data: "xy" });
    harness.bob.editor.insert("R1", 0, "Z", ["b1"]);
    harness.bob.editor.deleteIdentities(["s4"]);
    const stateBefore = Y.encodeStateVector(harness.alice.editor.doc).join(",");
    const inbound = harness.queue.pending.filter(message => message.from === "B");
    for (const message of inbound) provider.onMessage(new MessageEvent("message", { data: providerFrame(message.update).buffer }));
    harness.alice.history.push("actual HocuspocusProvider.onMessage applied sync updates directly to dirty E; M1 receive gate was never called");
    const result = evidence(harness, "T04-provider-bypass", "M1", candidate, "D3", "Pinned provider inbound sync bypasses M1 deferral. This is a deferral-invariant failure; paint-identity mapping can still preserve the T04 content.", () => {
      if (Y.encodeStateVector(harness.alice.editor.doc).join(",") !== stateBefore) throw new Error("M1 deferral violated: provider changed E while composing, held queue is empty");
    });
    harness.alice.dispatch({ type: "compositionend", names: ["a1", "a2"] });
    harness.queue.flush("D3");
    harness.check(bufferOracles.T04.expected);
    result.history.push("T04 content oracle still PASS after identity-mapped commit; deferral alone was not provided");
    return result;
  } finally {
    provider?.destroy();
    socket.destroy();
    harness.destroy();
  }
}
