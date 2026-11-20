import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate, writeSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import type { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { StateFirstProvider } from "../../../../src/adapters/collab/native/state-first-provider.ts";
import { beatField } from "./record-harness.ts";
import { openRelayFixture, relayFrameType, seedRelaySession } from "./relay-harness.ts";

type Session = ReturnType<typeof openNativeSession>;

const TAG = "t:prop:lamp";
const WRITER = "pair-writer";

function written(result: { kind: string }): void { assert.equal(result.kind, "written"); }

function range(session: Session, beat: string, from: number, to = from, cell: "narration" | "visual" = "narration") {
  const result = session.commands.anchorText({ beat, cell }, from, to);
  assert(result.kind === "anchored", JSON.stringify(result));
  return result.range;
}

function raw(session: Session): Y.Text {
  const text = session.ydoc.getMap<Y.Text>("relay-test").get("text");
  assert(text);
  return text;
}

function editor(session: Session, native: boolean) {
  const manager = native ? undefined : new Y.UndoManager(raw(session), { captureTimeout: 0, trackedOrigins: new Set([WRITER]) });
  let created = "";
  return {
    get created() { return created; },
    close() { manager?.destroy(); },
    undo() { if (manager) assert(manager.undo()); else written(session.commands.undo()); },
    redo() { if (manager) assert(manager.redo()); else written(session.commands.redo()); },
    mark(from: number, to: number, key: string, value: true | string | null) {
      session.ydoc.transact(() => raw(session).format(from, to - from, { [key]: value }), WRITER);
    },
    tag(beat: string, end: number) {
      written(session.commands.formatText(range(session, beat, 0, end), { kind: "tag", id: TAG, on: true }));
    },
    type() { session.ydoc.transact(() => raw(session).insert(4, "X", {}), WRITER); },
    split() {
      const outcome = session.commands.splitRow(range(session, "R", 2));
      assert(outcome.kind === "written", JSON.stringify(outcome));
      created = outcome.created;
    },
    typeInSplit(cell: "narration" | "visual", at: number) {
      written(session.commands.typeText(range(session, created, at, at, cell), "X", {}));
    },
    setSplitField() { written(session.commands.setField(beatField(created, "status"), "ready")); }
  };
}

type Command = (writer: ReturnType<typeof editor>) => void;
type Pair = {
  name: string; prep?: Command[]; first: Command; second: Command; text?: string; marks?: string[];
  native?: true; split?: true; hidden?: true; visual?: string; status?: string;
};

const undo: Command = writer => writer.undo();
const redo: Command = writer => writer.redo();
const bold: Command = writer => writer.mark(0, 4, "b", true);
const italic: Command = writer => writer.mark(0, 4, "i", true);
const prefix: Command = writer => writer.mark(0, 2, "b", true);
const tag: Command = writer => writer.mark(0, 4, "t:T1", true);
const untag: Command = writer => writer.mark(0, 4, "t:T1", null);
const nativeTag: Command = writer => writer.tag("R", 4);
const split: Command = writer => writer.split();
const type: Command = writer => writer.type();
const all = (mark: string) => [mark, mark, mark, mark];

const pairs: Pair[] = [
  { name: "tag then undo | redo", prep: [tag], first: undo, second: redo, marks: all("t:T1") },
  { name: "bold then undo | redo", prep: [bold], first: undo, second: redo, marks: all("b") },
  { name: "bold and italic then undo | redo", prep: [bold, italic], first: undo, second: redo, marks: all("b+i") },
  { name: "prefix bold then undo | redo", prep: [prefix], first: undo, second: redo, marks: ["b", "b", "", ""] },
  { name: "native tag then undo | redo", prep: [nativeTag], first: undo, second: redo, marks: all("t:" + TAG), native: true },
  { name: "bold | italic", first: bold, second: italic, marks: all("b+i") },
  { name: "red | blue", first: w => w.mark(0, 4, "color", "red"), second: w => w.mark(0, 4, "color", "blue"), marks: all("color=blue") },
  { name: "bold first letter | bold first two", first: w => w.mark(0, 1, "b", true), second: prefix, marks: ["b", "b", "", ""] },
  { name: "type | bold new letter", first: type, second: w => w.mark(4, 5, "b", true), text: "wordX", marks: ["", "", "", "", "b"] },
  { name: "tag | untag", first: tag, second: untag },
  { name: "untag | tag again", prep: [tag], first: untag, second: tag, marks: all("t:T1") },
  { name: "split | type in new visual", first: split, second: w => w.typeInSplit("visual", 0), native: true, split: true, visual: "X" },
  { name: "split | field on new beat", first: split, second: w => w.setSplitField(), native: true, split: true, status: "ready" },
  { name: "split | type in new narration", first: split, second: w => w.typeInSplit("narration", 1), native: true, split: true, text: "worXd" },
  { name: "split | tag new narration", first: split, second: w => w.tag(w.created, 2), native: true, split: true, marks: ["", "", "t:" + TAG, "t:" + TAG] },
  { name: "split tagged row | type", prep: [nativeTag], first: split, second: w => w.typeInSplit("narration", 1), native: true, split: true,
    text: "worXd", marks: ["t:" + TAG, "t:" + TAG, "t:" + TAG, "", "t:" + TAG] },
  { name: "split | undo split", first: split, second: undo, native: true, hidden: true },
  { name: "split online then undo | redo", prep: [split], first: undo, second: redo, native: true, split: true },
  { name: "split tagged row online then undo | redo", prep: [nativeTag, split], first: undo, second: redo, native: true, split: true, marks: all("t:" + TAG) },
  { name: "tag and undo online then redo | undo", prep: [tag, undo], first: redo, second: undo },
  { name: "tag and untag online then undo | redo", prep: [tag, untag], first: undo, second: redo },
  { name: "type then undo | redo", prep: [type], first: undo, second: redo, text: "wordX" }
];

function seed(native: boolean) {
  const session = seedRelaySession();
  if (!native) {
    const text = new Y.Text();
    session.ydoc.getMap("relay-test").set("text", text);
    text.insert(0, "word");
  }
  const state = session.encodeState();
  session.close();
  return state;
}

function narration(session: Session): Y.Text {
  const segment = session.ydoc.getMap<Y.Map<unknown>>("segments").values().next().value;
  const text = segment?.get("text");
  assert(text instanceof Y.Text);
  return text;
}

function letters(text: Y.Text) {
  return (text.toDelta() as NativeDeltaItem[]).flatMap(({ insert, attributes }) => {
    if (typeof insert !== "string") return [];
    const marks = Object.entries(attributes ?? {}).filter(([, value]) => value != null)
      .map(([key, value]) => value === true ? nativeMarkName(key) : `${key}=${String(value)}`).sort().join("+");
    return [...insert].map(letter => ({ letter, marks }));
  });
}

function checkPair(pair: Pair, session: Session, created: string) {
  const text = pair.text ?? "word";
  const actual = letters(pair.native ? narration(session) : raw(session));
  assert.equal(actual.map(unit => unit.letter).join(""), text);
  assert.deepEqual(actual.map(unit => unit.marks), pair.marks ?? [...text].map(() => ""));
  if (!pair.native) return;
  const rows = session.document().rows;
  assert.deepEqual(rows.map(row => row.id), pair.split ? ["R", created] : ["R"]);
  if (pair.split) {
    assert.equal(rows[1]?.audioText?.replace(/<[^>]*>/g, ""), text.slice(2));
    assert.equal(rows[1]?.visualText, pair.visual ?? "");
    assert.equal(rows[1]?.status, pair.status);
  }
  if (pair.hidden) {
    assert.equal(session.ydoc.getMap("beats").has(created), false);
    assert.equal(session.ydoc.getMap("visuals").has(created), false);
  }
}

for (const pair of pairs) {
  test(`E13 pair keeps its expected marks across a drop: ${pair.name}`, { timeout: 15_000 }, async t => {
    await runPair(t, pair, false);
  });
}

test("native undo in a dead socket precedes redo issued on the next connection before its state reply", { timeout: 15_000 }, async t => {
  await runPair(t, { name: "reconnect order", prep: [nativeTag], first: undo, second: redo, marks: all("t:" + TAG), native: true }, true);
});

async function runPair(t: TestContext, pair: Pair, early: boolean) {
  const state = seed(pair.native === true);
  const kit = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const { signals } = kit;
  const bridge = kit.bridge();
  const writer = kit.copy(await bridge.listen()), reader = kit.copy();
  await signals.until(() => (writer.relay.status().firstSyncDone && reader.relay.status().firstSyncDone) || undefined);
  const first = bridge.links[0];
  assert(first);
  await signals.until(() => first.sent.includes(messageYjsSyncStep2) || undefined);
  const commands = editor(writer.session, pair.native === true);
  t.after(commands.close);
  for (const prepare of pair.prep ?? []) prepare(commands);
  const fence = writer.session.ydoc.getText("fence");
  fence.insert(0, "before");
  await signals.until(() => reader.session.ydoc.getText("fence").toString() === "before" &&
    writer.relay.status().pendingChangeCount === 0 || undefined);

  first.upload = (frame, forward) => {
    if (relayFrameType(frame) === messageYjsUpdate) first.dropped.push(frame);
    else forward();
  };
  pair.first(commands);
  await signals.until(() => first.dropped.length || undefined);
  assert.equal(writer.relay.status().connected, true);

  let heldRequest: (() => void) | undefined;
  if (early) bridge.configure = link => {
    link.download = (frame, forward) => {
      if (relayFrameType(frame) === messageYjsSyncStep1) heldRequest = forward;
      else forward();
    };
  };
  first.cut();
  await signals.until(() => !writer.relay.status().connected || undefined);
  const release = early ? await signals.until(() => heldRequest) : undefined;
  pair.second(commands);
  if (!early) {
    assert.equal(writer.relay.status().connected, false);
    assert.equal(writer.relay.status().firstSyncDone, true);
    assert.equal(writer.relay.status().pendingChangeCount, 1);
  }
  release?.();

  const resumed = await signals.until(() => bridge.links[1]?.sent.includes(messageYjsSyncStep2) ? bridge.links[1] : undefined);
  assert.deepEqual(resumed.sent, [messageYjsSyncStep1, messageYjsSyncStep2]);
  fence.insert(6, " after");
  await signals.until(() => reader.session.ydoc.getText("fence").toString() === "before after" || undefined);
  const late = kit.copy();
  await signals.until(() => late.relay.status().firstSyncDone || undefined);
  for (const session of [writer.session, reader.session, late.session]) checkPair(pair, session, commands.created);
}

test("steady undo and redo reach a live peer in command order", { timeout: 12_000 }, async t => {
  const state = seed(true);
  const { copy, signals } = await openRelayFixture(t, { async onLoadDocument() { return state; } });
  const writer = copy(), reader = copy();
  await signals.until(() => (writer.relay.status().firstSyncDone && reader.relay.status().firstSyncDone) || undefined);
  const commands = editor(writer.session, true);
  async function expectMarks(expected: string) {
    await signals.until(() => letters(narration(reader.session)).map(unit => unit.marks).join(",") === all(expected).join(",") || undefined);
  }
  nativeTag(commands);
  await expectMarks("t:" + TAG);
  undo(commands);
  await expectMarks("");
  redo(commands);
  await expectMarks("t:" + TAG);
});

test("a write after the reply is encoded goes next and a provider-origin echo is suppressed", { timeout: 12_000 }, async t => {
  const kit = await openRelayFixture(t);
  const bridge = kit.bridge(), address = await bridge.listen();
  const reader = kit.copy(), writer = kit.copy(address);
  const receive = HocuspocusProvider.prototype.onMessage;
  const providers = new Map<Y.Doc, HocuspocusProvider>();
  t.mock.method(HocuspocusProvider.prototype, "onMessage", function (this: HocuspocusProvider, event: MessageEvent) {
    providers.set(this.document, this);
    receive.call(this, event);
  });
  const send = HocuspocusProviderWebsocket.prototype.send;
  let wrote = false;
  t.mock.method(HocuspocusProviderWebsocket.prototype, "send", function (this: HocuspocusProviderWebsocket, frame: Uint8Array) {
    if (!wrote && this.url === address && relayFrameType(Buffer.from(frame)) === messageYjsSyncStep2) {
      wrote = true;
      const writerProvider = providers.get(writer.session.ydoc);
      assert(writerProvider);
      writerProvider.documentUpdateHandler(writer.session.encodeState(), writerProvider);
      writer.session.ydoc.getText("callback-write").insert(0, "after reply");
    }
    send.call(this, frame);
  });
  await kit.signals.until(() => reader.session.ydoc.getText("callback-write").toString() === "after reply" || undefined);
  assert.deepEqual(bridge.links[0]?.sent, [messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate]);
});

test("an interrupted reply releases its temporary write buffer", t => {
  const document = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: "ws://127.0.0.1", autoConnect: false });
  const provider = new StateFirstProvider({ name: "buffer", document, websocketProvider: socket }, () => undefined);
  t.after(() => { provider.destroy(); socket.destroy(); document.destroy(); });
  const failure = new Error("interrupted reply");
  t.mock.method(HocuspocusProvider.prototype, "onMessage", () => { throw failure; });
  const encoder = createEncoder();
  writeVarString(encoder, "buffer");
  writeVarUint(encoder, MessageType.Sync);
  writeSyncStep1(encoder, document);
  assert.throws(() => provider.onMessage(new MessageEvent("message", { data: toUint8Array(encoder).buffer })), failure);
  assert.equal(Reflect.get(provider, "duringReply"), null);
});
