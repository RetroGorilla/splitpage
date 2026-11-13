import assert from "node:assert/strict";
import { createMonitoredSharedDocument, validatedFixture, deliveryReplica } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { readSharedStatus, readSharedStatusNotices } from "../../../src/adapters/collab/status.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { operation, ref } from "./executor-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedContentRef, SharedTextAddress, SharedOperation, SharedMarkValue } from "../../../src/core/collab/operations.ts";
import type { SharedMarkedCharacter } from "../../../src/adapters/collab/mark-record.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import { IdentityBook } from "../../collab/checker.ts";
import type { ScriptOracle, OracleRow } from "../../collab/checker.ts";
import type { SeedBeat } from "../../collab/oracles/seed-beat.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

export class Stage1ExecutorHarness {
  readonly a = createMonitoredSharedDocument();
  readonly b = createMonitoredSharedDocument();
  readonly c = createMonitoredSharedDocument();
  readonly book = new IdentityBook();
  readonly queue = new DeliveryQueue<Uint8Array>(bytes => bytes.slice(), bytes => String(bytes.length));
  readonly seed: readonly SeedBeat[];
  joined = false;
  private serial = 0;
  constructor(seed: readonly SeedBeat[], fields: Record<string, unknown> = {}) {
    this.seed = seed;
    const base = createMonitoredSharedDocument();
    try {
      collabState(base).doc.clientID = 10;
      hydrateSharedDocument(base, validatedFixture({ ...fields, rows: seed.map(row => ({ id: row.id, audioText: row.text })) }));
      let index = 0;
      for (const row of seed) for (const char of this.characters(base, row.id)) this.book.bind("s" + ++index, char.identity);
      for (const [client, handle] of [this.a, this.b, this.c].entries()) {
        collabState(handle).doc.clientID = client + 1;
        if (handle !== this.c) assert.equal(applySharedUpdate(handle, encodeSharedState(base)).ok, true);
        registerSharedTextOperationHandlers(handle);
      }
    } finally { destroySharedDocument(base); }
    this.queue.addReplica("A", deliveryReplica(this.a)); this.queue.addReplica("B", deliveryReplica(this.b));
  }
  handle(writer: "A" | "B"): SharedDocumentHandle { return writer === "A" ? this.a : this.b; }
  target(row: string): SharedTextAddress { return { owner: ref(row), segment: ref("b:" + row), field: "audioText" }; }
  characters(handle: SharedDocumentHandle, row: string): SharedMarkedCharacter[] {
    const result = readSharedMarkCharacters(handle, this.target(row)); assert.ok(result); return result;
  }
  range(writer: "A" | "B", row: string, from: number, to: number): SharedContentRef {
    const result = captureSharedTextRange(this.handle(writer), this.target(row), from, to); assert.ok(result); return result;
  }
  point(writer: "A" | "B", row: string, offset: number, affinity: "before" | "after" = "before"): SharedContentRef {
    const anchor = createSharedAnchor(this.handle(writer), this.target(row), offset, affinity); assert.ok(anchor); return anchor;
  }
  offset(writer: "A" | "B", anchor: SharedContentRef): number {
    const result = resolveSharedAnchor(this.handle(writer), anchor); assert.notEqual(result, "gone");
    if (result === "gone") throw new Error("Missing fixture anchor"); return result.offset;
  }
  command(writer: "A" | "B", input: Record<string, unknown>): SharedOperation {
    return operation({ ...input, id: writer + ":" + ++this.serial, by: writer === "A" ? "Alice" : "Bob" });
  }
  execute(writer: "A" | "B", operations: readonly SharedOperation[], names: readonly string[] = []): void {
    const handle = this.handle(writer), before = new Set(this.seed.flatMap(row => this.characters(handle, row.id).map(char => JSON.stringify(char.identity))));
    assert.deepEqual(executeSharedOperations(handle, operations), { ok: true });
    const added = this.seed.flatMap(row => this.characters(handle, row.id)).filter(char => !before.has(JSON.stringify(char.identity)));
    assert.equal(added.length, names.length);
    added.forEach((char, index) => { const name = names[index]; assert.ok(name); this.book.bind(name, char.identity); });
  }
  insertion(writer: "A" | "B", row: string, anchor: SharedContentRef, text: string, marks: readonly SharedMarkValue[] = []): SharedOperation {
    return this.command(writer, { kind: "text-insert", target: this.target(row), at: { left: anchor, right: null, affinity: "after" }, content: [{ value: text, marks }] });
  }
  deletion(writer: "A" | "B", row: string, range: SharedContentRef): SharedOperation {
    return this.command(writer, { kind: "text-delete", target: this.target(row), observed: [range] });
  }
  mark(writer: "A" | "B", row: string, range: SharedContentRef, mark: SharedMarkValue): SharedOperation {
    return this.command(writer, { kind: "mark", target: this.target(row), observed: [range], mark });
  }
  join(): void { if (!this.joined) { this.queue.lateJoin("C", deliveryReplica(this.c), "A", encodeSharedState(this.a)); this.joined = true; } }
  check(order: DeliveryOrder, expected: ScriptOracle, caret?: { row: string; anchor: SharedContentRef }, status = false): void {
    this.queue.flush(order); this.join();
    const outputs = [this.a, this.b, this.c].map(handle => {
      const rows: OracleRow[] = this.seed.map(row => {
        const target = this.target(row.id), prep = createSharedPreparation(handle), text = prep.view.text(["segments", target.segment, "text"]); assert.ok(text);
        const records = text.records; prep.close();
        const characters = this.characters(handle, row.id).map(char => {
          const marks: Record<string, string | boolean | readonly string[]> = {};
          for (const kind of ["b", "i", "u", "s", "hl", "dir", "cue"] as const) if (char.marks.some(group => group.kind === kind)) marks[kind] = true;
          const tags = char.marks.filter(group => group.kind === "tag").map(group => {
            assert.equal(group.values.length, 1); const value = group.values[0]; assert.equal(typeof value, "string");
            const ranges = records.filter(record => group.additions.some(addition => addition.record === record.identity));
            return { value: value as string, size: Math.max(...ranges.map(range => (range.to ?? 0) - (range.from ?? 0))) };
          }).sort((a, b) => b.size - a.size || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
          if (tags[0]) { marks.tag = tags[0].value; if (tags.length > 1) marks.innerTags = tags.slice(1).map(tag => tag.value); }
          for (const group of char.marks.filter(group => group.kind === "comment")) for (const value of group.values) marks["c:" + value] = true;
          const hrefs = [...new Set(char.marks.filter(group => group.kind === "link").flatMap(group => group.values))];
          if (hrefs.length) { assert.equal(hrefs.length, 1); const href = hrefs[0]; assert.equal(typeof href, "string"); marks.href = href as string; }
          return [this.book.notation(char.identity), char.value, marks] as const;
        });
        return status ? { id: row.id, characters, status: readSharedStatus(handle, { scope: "beat", record: ref(row.id) }) } : { id: row.id, characters };
      });
      const carets: Record<string, { beat: string; offset: number }> = {};
      if (caret) { const resolved = resolveSharedAnchor(handle, caret.anchor); assert.notEqual(resolved, "gone"); if (resolved === "gone") throw new Error("Gone caret"); carets.A = { beat: caret.row, offset: resolved.offset }; }
      return status ? { rows, carets, recovery: [], notices: readSharedStatusNotices(handle, { scope: "beat", record: ref(this.seed[0]?.id ?? "") }) } : { rows, carets, recovery: [] };
    });
    assertReplicasAgree("Stage 1 executor intent", [{ order: "D1", replica: "A", output: expected }, ...outputs.map((output, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output }))]);
  }
  destroy(): void { this.queue.destroy(); for (const handle of [this.a, this.b, this.c]) destroySharedDocument(handle); }
}
