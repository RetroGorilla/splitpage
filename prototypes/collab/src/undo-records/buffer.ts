import * as Y from "yjs";
import { DeliveryQueue } from "../delivery.ts";
import type { ReplicaName } from "../delivery.ts";
import { EditableBeatBuffer } from "../editing-buffer.ts";
import type { SyntheticEditEvent } from "../editing-buffer.ts";
import { IdentityBook, checkModel } from "../model.ts";
import type { ScriptOracle } from "../model.ts";
import { readReplica } from "../reader.ts";
import { SchemaReplica } from "../schema.ts";
import type { SeedBeat } from "../schema.ts";
import { CommandHistory } from "./history.ts";
import { contentAt, resolveIdentity, selectionOf } from "./identity.ts";
import type { SelectionRecord, StoredContent } from "./identity.ts";

export class RecordingBeatBuffer extends EditableBeatBuffer {
  readonly commands: CommandHistory;
  private pendingSelection: SelectionRecord | null = null;

  constructor(editor: SchemaReplica, record?: (line: string) => void) {
    super(editor, "M1", editor, record);
    // why: the inherited constructor still builds a library undo manager; it is destroyed unused, so only records undo.
    this.undoManager.destroy();
    this.commands = new CommandHistory(editor);
  }

  override dispatch(event: SyntheticEditEvent): void {
    if (!this.dirty && this.painted && (event.type === "compositionstart" || event.type === "beforeinput")) {
      const [from, to] = event.type === "beforeinput" ? event.selection ?? [event.from, event.to] : [event.from, event.to];
      const start = this.painted.positions[from];
      const end = this.painted.positions[to];
      if (!start || !end) throw new Error("Command selection outside painted text");
      this.pendingSelection = selectionOf({ position: start, ...(from === to ? {} : { selectionEnd: end }) });
    }
    super.dispatch(event);
  }

  override commit(names: readonly string[], operationOrder: "insert-first" | "delete-first" = "insert-first"): void {
    const painted = this.painted;
    if (!painted || !this.dirty) {
      super.commit(names, operationOrder);
      return;
    }
    const edit = this.plan();
    const deleted: StoredContent[] = [];
    for (const id of painted.identities.slice(edit.from, edit.to)) {
      const at = resolveIdentity(this.editor.doc, id);
      if (at?.live) deleted.push({ id, ...contentAt(at.type, at.index) });
    }
    super.commit(names, operationOrder);
    const inserted = names.map(name => this.editor.identities.identity(name));
    this.commands.record({ label: "native edit", parts: [{ kind: "sequence", inserted, deleted }], ...(this.pendingSelection ? { selection: this.pendingSelection } : {}) });
    this.pendingSelection = null;
  }

  override undo(): void {
    if (this.dirty) throw new Error("Undo needs a committed buffer");
    const outcome = this.commands.undo();
    for (const [original, restored] of outcome.restored) {
      const notation = this.editor.identities.notation(original);
      if (!notation.startsWith("?")) this.editor.identities.bind(`${notation}*`, restored);
    }
    if (outcome.selection) this.caret = outcome.selection;
    this.painted = null;
    this.history.push(`undo command record ${outcome.label ?? "none"} effective=${String(outcome.effective)}; restored identities reanchor the selection`);
  }
}

export class RecordBufferHarness {
  readonly identities = new IdentityBook();
  readonly alice: RecordingBeatBuffer;
  readonly bob: RecordingBeatBuffer;
  readonly queue: DeliveryQueue;
  readonly sessions = new Map<ReplicaName, RecordingBeatBuffer>();
  private readonly timeline: string[] = [];

  constructor(beats: readonly SeedBeat[]) {
    const seed = new SchemaReplica("B", 10, this.identities);
    try {
      seed.seed(beats);
      const initial = Y.encodeStateAsUpdate(seed.doc);
      this.alice = this.createSession(1, initial);
      this.bob = this.createSession(2, initial);
    } finally {
      seed.destroy();
    }
    this.sessions.set("A", this.alice);
    this.sessions.set("B", this.bob);
    this.queue = new DeliveryQueue({ A: this.alice.network, B: this.bob.network }, (name, update) => {
      const session = this.sessions.get(name);
      if (!session) throw new Error(`Missing buffer session ${name}`);
      session.receive(update);
    }, line => this.timeline.push(`queue ${line}`));
  }

  private createSession(client: number, initial: Uint8Array): RecordingBeatBuffer {
    const editor = new SchemaReplica("B", client, this.identities);
    Y.applyUpdate(editor.doc, initial, "seed");
    return new RecordingBeatBuffer(editor, line => { this.timeline.push(`${client === 1 ? "A" : client === 2 ? "B" : "C"} ${line}`); });
  }

  lateJoin(): void {
    const session = this.createSession(3, Y.encodeStateAsUpdate(this.bob.network.doc));
    this.sessions.set("C", session);
    this.queue.addReplica("C", session.network);
    this.queue.history.push("late-C full state from B; no paint, identity cache or command history transferred");
  }

  check(oracle: ScriptOracle): void {
    if (!this.alice.caret) throw new Error("Alice has no caret");
    const anchors = new Map([["A", this.alice.caret]]);
    for (const [name, session] of this.sessions) checkModel(readReplica(session.editor.doc, "B", this.identities, anchors), oracle, this.identities, `${name}.E`);
  }

  history(): string[] {
    return [...this.timeline];
  }

  destroy(): void {
    this.queue.destroy();
    for (const session of this.sessions.values()) {
      session.destroy();
      session.editor.destroy();
    }
  }
}
