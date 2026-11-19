import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import "../../../../src/test/_dom.mjs";
import { scriptCellOf } from "../../../../src/bootstrap/richtext.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import type { Run } from "../../../../src/core/text/runs.ts";
import { convertToNativeScript } from "../../../../src/adapters/collab/native/convert.ts";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";

export type Delivery = "forward" | "reverse" | "twice";

export const fixtures = (JSON.parse(readFileSync(new URL("../../../collab/fixtures/projection-reference.json", import.meta.url), "utf8")) as {
  fixtures: { name: string; document: DocumentShape }[];
}).fixtures;

export function fixture(name: string): DocumentShape {
  const found = fixtures.find(item => item.name === name);
  assert.ok(found, name);
  return migrateRows(structuredClone(found.document));
}

export function cells(html: string): readonly Run[] {
  return scriptCellOf(html);
}

export function convertedScript(document: DocumentShape, clientID = 1): NativeScript {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const script = openNativeScript(doc);
  convertToNativeScript(script, document, { cells, creation: "creation-1", at: "2026-11-19T00:00:00Z", by: "converter" });
  return script;
}

export function joinedScript(from: NativeScript, clientID: number): NativeScript {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const script = openNativeScript(doc);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc), "remote");
  return script;
}

export function shown(script: NativeScript, reader = script.reader): string[] {
  const outline = reader.outline().map(entry => entry.kind === "heading" ? `# ${entry.name}` : (() => {
    const row = reader.row(entry.id);
    return row ? `${row.id}: ${row.audioText} / ${row.visualText}` : `${entry.id}: missing`;
  })());
  return [...outline, ...reader.unplaced().map(span => `unplaced ${span.segment} ${span.reason} ${span.length}`)];
}

export function freshlyShown(script: NativeScript): string[] {
  const reader = new NativeScriptReader(script.roots);
  try { return shown(script, reader); } finally { reader.close(); }
}

export class ScriptNet {
  private readonly logs = new Map<NativeScript, Uint8Array[]>();
  private readonly read = new Map<string, number>();
  readonly scripts: NativeScript[];

  constructor(scripts: NativeScript[]) {
    this.scripts = scripts;
    for (const script of scripts) {
      const log: Uint8Array[] = [];
      this.logs.set(script, log);
      script.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") log.push(update); });
    }
  }

  deliver(from: NativeScript, to: NativeScript, order: Delivery = "forward"): void {
    const key = `${from.doc.clientID}>${to.doc.clientID}`, log = this.logs.get(from) ?? [], updates = log.slice(this.read.get(key) ?? 0);
    this.read.set(key, log.length);
    const sequence = order === "reverse" ? [...updates].reverse() : order === "twice" ? [...updates, ...updates] : updates;
    for (const update of sequence) Y.applyUpdate(to.doc, update, "remote");
    to.reader.refresh();
  }

  settle(order: Delivery = "forward"): void {
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (const from of this.scripts) for (const to of this.scripts) {
        if (from === to || (this.logs.get(from)?.length ?? 0) === (this.read.get(`${from.doc.clientID}>${to.doc.clientID}`) ?? 0)) continue;
        this.deliver(from, to, order); moved = true;
      }
      if (!moved) return;
    }
    throw new Error("The copies never settled");
  }

  agree(): string[] {
    const first = this.scripts[0];
    assert.ok(first);
    const late = joinedScript(first, 900 + this.scripts.length), expected = shown(first);
    for (const script of [...this.scripts, late]) {
      assert.deepEqual(shown(script), expected, `copy ${script.doc.clientID} reads differently`);
      assert.deepEqual(freshlyShown(script), expected, `a fresh reader of copy ${script.doc.clientID} reads differently`);
    }
    return expected;
  }
}
