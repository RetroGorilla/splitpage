import assert from "node:assert/strict";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { NativeReplica, nativeMarkName } from "../native/variant.ts";
import type { NativeDeltaItem } from "../native/variant.ts";
import { compareCodeUnits } from "../readers/order.ts";
import { openLink } from "./link.ts";
import { openCopy, openRelay, readSyncFrame, until } from "./relay.ts";
import { StateFirstProvider } from "./state-first.ts";
import { pressUndo } from "./trace.ts";

const tag = "t:T1";
const undo = (target: Editor) => target.undo();
const redo = (target: Editor) => target.redo();
const bold = (target: Editor) => target.mark(0, 4, { b: true });
const italic = (target: Editor) => target.mark(0, 4, { i: true });
const markTag = (target: Editor) => target.mark(0, 4, { [tag]: true });
const untag = (target: Editor) => target.mark(0, 4, { [tag]: null });
const split = (target: Editor) => target.native.split("R", 2, "S", { status: "todo" });
const type = (target: Editor) => target.type("X");

type Command = (target: Editor) => void;
type Scenario = {
  label: string; prep: Command[]; first: Command; second: Command; text: string; marks?: string[];
  native?: true; rows?: "R" | "R,S"; visual?: string; status?: string; hiddenCreated?: true;
};
type Editor = ReturnType<typeof editor>;
type Schedule = "ordered" | "queued" | "queue-only" | "early" | "wrapped" | "wrapped-early";

export const pairs: Scenario[] = [
  { label: "tag then undo | redo", prep: [markTag], first: undo, second: redo, text: "word", marks: ["t:T1", "t:T1", "t:T1", "t:T1"] },
  { label: "bold then undo | redo", prep: [bold], first: undo, second: redo, text: "word", marks: ["b", "b", "b", "b"] },
  { label: "bold then italic then undo | redo", prep: [bold, italic], first: undo, second: redo, text: "word", marks: ["b+i", "b+i", "b+i", "b+i"] },
  { label: "partial bold [0,2] then undo | redo", prep: [target => target.mark(0, 2, { b: true })], first: undo, second: redo, text: "word", marks: ["b", "b", "", ""] },
  { label: "chosen narration tag then undo | redo", prep: [markTag], first: undo, second: redo, text: "word", native: true, rows: "R", marks: ["t:T1", "t:T1", "t:T1", "t:T1"] },
  { label: "bold | italic", prep: [], first: bold, second: italic, text: "word", marks: ["b+i", "b+i", "b+i", "b+i"] },
  { label: "red | blue", prep: [], first: target => target.mark(0, 4, { color: "red" }), second: target => target.mark(0, 4, { color: "blue" }), text: "word", marks: Array<string>(4).fill("color=blue") },
  { label: "bold [0,1] | bold [0,2]", prep: [], first: target => target.mark(0, 1, { b: true }), second: target => target.mark(0, 2, { b: true }), text: "word", marks: ["b", "b", "", ""] },
  { label: "type | bold over it", prep: [], first: type, second: target => target.mark(4, 5, { b: true }), text: "wordX", marks: ["", "", "", "", "b"] },
  { label: "tag | untag", prep: [], first: markTag, second: untag, text: "word", marks: ["", "", "", ""] },
  { label: "untag | tag again", prep: [markTag], first: untag, second: markTag, text: "word", marks: Array<string>(4).fill(tag) },
  { label: "split | type in new visual", prep: [], first: split, second: target => target.native.splice("S", "visualText", 0, 0, [{ text: "X", marks: {} }]), text: "word", native: true, rows: "R,S", visual: "X" },
  { label: "split | field on new beat", prep: [], first: split, second: target => target.native.setField("S", "status", "ready"), text: "word", native: true, rows: "R,S", status: "ready" },
  { label: "split | type in new narration", prep: [], first: split, second: target => target.native.splice("S", "audioText", 1, 1, [{ text: "X", marks: {} }]), text: "worXd", native: true, rows: "R,S" },
  { label: "split | tag new narration", prep: [], first: split, second: target => target.native.format("S", "audioText", 0, 2, { [tag]: true }), text: "word", native: true, rows: "R,S", marks: ["", "", tag, tag] },
  { label: "split tagged row | type", prep: [markTag], first: split, second: target => target.native.splice("S", "audioText", 1, 1, [{ text: "X", marks: {} }]), text: "worXd", native: true, rows: "R,S", marks: [tag, tag, tag, "", tag] },
  { label: "split | undo split", prep: [], first: split, second: undo, text: "word", native: true, rows: "R", hiddenCreated: true },
  { label: "split online then undo | redo, plain", prep: [split], first: undo, second: redo, text: "word", native: true, rows: "R,S" },
  { label: "split online then undo | redo, tagged", prep: [markTag, split], first: undo, second: redo, text: "word", native: true, rows: "R,S", marks: Array<string>(4).fill(tag) },
  { label: "tag and undo online then redo | undo", prep: [markTag, undo], first: redo, second: undo, text: "word", marks: ["", "", "", ""] },
  { label: "tag and untag online then undo | redo", prep: [markTag, untag], first: undo, second: redo, text: "word", marks: ["", "", "", ""] },
  { label: "type then undo | redo", prep: [type], first: undo, second: redo, text: "wordX", marks: ["", "", "", "", ""] }
];

function rawText(doc: Y.Doc) {
  const text = doc.getMap<Y.Text>("cells").get("main");
  assert(text instanceof Y.Text);
  return text;
}

function editor(useNative: boolean, state: Uint8Array) {
  const native = useNative ? new NativeReplica(2, 0, "chosen") : undefined;
  const doc = native?.doc ?? new Y.Doc();
  Y.applyUpdate(doc, state);
  const scope = native?.undo ?? new Y.UndoManager(rawText(doc), { captureTimeout: 0, trackedOrigins: new Set(["writer"]) });
  return {
    doc,
    get native() { assert(native); return native; },
    undo() { if (native) assert.equal(native.undoStep(), "undone"); else pressUndo(scope); },
    redo() { if (native) assert.equal(native.redoStep(), "undone"); else assert(scope.redo()); },
    mark(from: number, to: number, marks: Record<string, true | string | null>) {
      if (native) native.format("R", "audioText", from, to, marks as Record<string, true | null>);
      else doc.transact(() => rawText(doc).format(from, to - from, marks), "writer");
    },
    type(value: string) { doc.transact(() => rawText(doc).insert(4, value, {}), "writer"); },
    close() { if (native) native.destroy(); else { scope.destroy(); doc.destroy(); } }
  };
}

function seed(useNative: boolean) {
  const replica = new NativeReplica(900, 0, "chosen");
  try {
    if (useNative) replica.hydrate({ rows: [{ id: "R", audioText: "word", visualText: "", status: "todo" }] });
    else {
      const text = new Y.Text();
      replica.doc.getMap<Y.Text>("cells").set("main", text);
      replica.doc.getMap<Y.Text>("cells").set("note", new Y.Text());
      text.insert(0, "word");
    }
    return Y.encodeStateAsUpdate(replica.doc);
  } finally { replica.destroy(); }
}

function units(text: Y.Text) {
  return (text.toDelta() as NativeDeltaItem[]).flatMap(({ insert, attributes }) => {
    const marks = Object.entries(attributes ?? {}).filter(([, value]) => value != null)
      .map(([key, value]) => value === true ? nativeMarkName(key) : `${key}=${String(value)}`).sort().join("+");
    return (typeof insert === "string" ? [...insert] : [insert]).map(value => ({ value, marks }));
  });
}

function snapshot(doc: Y.Doc, useNative: boolean) {
  const ordered = <T>(map: Y.Map<T>) => [...map].sort(([a], [b]) => compareCodeUnits(a, b));
  const segment = useNative ? doc.getMap<Y.Map<unknown>>("segments").get("seg-b-R")?.get("text") : rawText(doc);
  assert(segment instanceof Y.Text);
  const narration = units(segment);
  const boundaries = narration.flatMap(({ value }, index) => typeof value === "object" ? [[index, value]] : []);
  const letters = narration.filter(({ value }) => typeof value === "string");
  const records = useNative ? ordered(doc.getMap<Y.Map<unknown>>("beats")).map(([id, record]) => [id, ordered(record)] as const) : [];
  const visuals = useNative ? ordered(doc.getMap<Y.Text>("visuals")).map(([id, text]) => [id, units(text)] as const) : [];
  return {
    content: { text: letters.map(part => part.value).join(""), boundaries, records,
      cells: visuals.map(([id, spans]) => [id, spans.map(part => part.value).join("")]),
      order: useNative ? doc.getArray<string>("order").toArray() : [],
      note: useNative ? "" : doc.getMap<Y.Text>("cells").get("note")?.toString() },
    marks: letters.map(part => part.marks), visualMarks: visuals
  };
}

function checkContent(scenario: Scenario, current: ReturnType<typeof snapshot>) {
  assert.equal(current.content.text, scenario.text);
  if (!scenario.native) return;
  const { boundaries, cells, records, order } = current.content;
  assert.deepEqual(order, ["seg-b-R"]);
  if (scenario.rows === "R,S") assert.deepEqual(boundaries, [[2, { b: "S" }]]);
  else assert.deepEqual(boundaries, []);
  const splitCreated = scenario.rows === "R,S" || scenario.hiddenCreated === true;
  assert.deepEqual(cells, splitCreated ? [["R", ""], ["S", scenario.visual ?? ""]] : [["R", ""]]);
  assert.deepEqual(records.map(([id, entries]) => [id, new Map(entries).get("status")]),
    splitCreated ? [["R", "todo"], ["S", scenario.hiddenCreated ? undefined : scenario.status ?? "todo"]] : [["R", "todo"]]);
}

class NoOfflineQueueProbe extends HocuspocusProvider {
  override documentUpdateHandler(update: Uint8Array, origin: unknown) {
    if (this.configuration.websocketProvider.status === WebSocketStatus.Connected) super.documentUpdateHandler(update, origin);
  }
}

export async function runPair(scenario: Scenario, schedule: Schedule, latency = 0) {
  const useNative = scenario.native === true;
  const state = seed(useNative);
  let serverDoc: Y.Doc | undefined;
  const wires: { type: number; bytes: number; at: number }[] = [];
  let handled = 0;
  const relay = await openRelay({
    async onLoadDocument() { return state; },
    async afterLoadDocument({ document }) { serverDoc = document; },
    async beforeSync({ type, payload, connection }) {
      if (new URL(connection.request.url).searchParams.has("writer")) wires.push({ type, bytes: payload.length, at: performance.now() });
    },
    async afterHandleMessage({ connection, update }) {
      if (new URL(connection.request.url).searchParams.has("writer") && readSyncFrame(update)?.type === messageYjsSyncStep2) handled++;
    }
  });
  try {
    const link = await openLink(relay.address.port);
    try {
      const target = editor(useNative, state);
      const reader = openCopy(relay.webSocketURL, 1);
      const early = schedule === "early" || schedule === "wrapped-early";
      const Provider = schedule.startsWith("wrapped") ? StateFirstProvider : schedule === "queue-only" || early ? NoOfflineQueueProbe : HocuspocusProvider;
      let onOpen = () => {};
      let editAt = 0, peerAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const writer = openCopy(`${link.url}/?writer`, 2, {}, target.doc, { Provider, onOpen: () => onOpen() });
      try {
        reader.doc.on("afterTransaction", () => {
          if (latency && editAt && !peerAt && reader.doc.getMap<Y.Text>("cells").get("note")?.toString() === "!") peerAt = performance.now();
        });
        reader.connect(); writer.connect();
        await settled();
        for (const prepare of scenario.prep) { prepare(target); await settled(); }
        let wireStart = wires.length, bytesStart = link.bytes.upload;
        if (schedule === "ordered") {
          scenario.first(target);
          await settled();
          scenario.second(target);
          await settled();
        } else {
          const release = link.hold("upload");
          scenario.first(target);
          link.cut(); release();
          await until(() => writer.closeEvents.length > 0 && writer.status() === "disconnected", "cut between the pair");
          writer.socket.disconnect();
          wireStart = wires.length;
          bytesStart = link.bytes.upload;
          const replace = () => { editAt = performance.now(); scenario.second(target); };
          if (early) {
            onOpen = () => {
              if (latency) timer = setTimeout(link.hold("download"), latency);
              onOpen = () => {};
              replace();
            };
          } else replace();
          const replies = handled;
          writer.connect();
          await until(() => handled > replies, "writer state reply handled");
        }
        const late = openCopy(relay.webSocketURL, 4);
        try {
          late.connect();
          await until(() => late.provider.synced && !late.provider.hasUnsyncedChanges, "late pair reader");
          const current = snapshot(late.doc, useNative);
          await until(() => !!serverDoc && [serverDoc, writer.doc, reader.doc].every(doc =>
            JSON.stringify(snapshot(doc, useNative)) === JSON.stringify(current)), "paired contents on every copy");
          checkContent(scenario, current);
          if (schedule === "ordered") assert.deepEqual(current.marks, scenario.marks ?? [...scenario.text].map(() => ""));
          if (latency) assert(peerAt >= editAt && editAt > 0);
          const frames = wires.slice(wireStart).filter(frame => frame.type === messageYjsSyncStep2 || frame.type === messageYjsUpdate);
          if (schedule.startsWith("wrapped") || schedule === "queue-only") assert.deepEqual(frames.map(frame => frame.type), [messageYjsSyncStep2]);
          if (schedule === "queued" || schedule === "early") assert.deepEqual(frames.map(frame => frame.type), [messageYjsUpdate, messageYjsSyncStep2]);
          return { current, frames: frames.map(({ type, bytes }) => [type, bytes]), upload: link.bytes.upload - bytesStart,
            latency: peerAt ? peerAt - editAt : null };
        } finally { late.close(); }
      } finally { clearTimeout(timer); writer.close(); reader.close(); target.close(); }
      async function settled() {
        await until(() => [writer, reader].every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "ordered positive status");
        const local = snapshot(writer.doc, useNative);
        await until(() => JSON.stringify(snapshot(reader.doc, useNative)) === JSON.stringify(local), "ordered peer applies the command");
      }
    } finally { await link.close(); }
  } finally { await relay.destroy(); }
}

export async function measureFirstTrip(schedule: "early" | "wrapped-early", delayMs: number) {
  return runPair({ label: "independent first-trip typing", prep: [markTag], first: undo, text: "word",
    second: target => { target.doc.getMap<Y.Text>("cells").get("note")?.insert(0, "!"); } }, schedule, delayMs);
}
