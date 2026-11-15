import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import * as Y from "yjs";
import { LifetimeHistory, canonicalLifetimeSource } from "./workload.ts";
import { lifetimeSize, lifetimeTyped } from "./counts.ts";

const tape: unknown[] = [];
const original = { insert: Y.Text.prototype.insert, delete: Y.Text.prototype.delete, insertEmbed: Y.Text.prototype.insertEmbed };
let capture = false;
function address(text: Y.Text) {
  const parent = text._item?.parent;
  assert.ok(parent instanceof Y.Map);
  const head = parent.get("head") as { b?: string } | undefined;
  return { owner: String(head?.b ?? parent.get("beat")), field: head ? "audioText" : "visualText" };
}
Y.Text.prototype.insert = function (index, text, attributes) {
  if (capture) tape.push({ kind: "insert", writer: this.doc?.clientID, target: address(this), index, text, attributes: attributes ?? {} });
  original.insert.call(this, index, text, attributes);
};
Y.Text.prototype.delete = function (index, count) {
  if (capture) tape.push({ kind: "delete", writer: this.doc?.clientID, target: address(this), index, count });
  original.delete.call(this, index, count);
};
Y.Text.prototype.insertEmbed = function (index, value, attributes) {
  if (capture) tape.push({ kind: "embed", writer: this.doc?.clientID, target: address(this), index, value, attributes: attributes ?? {} });
  original.insertEmbed.call(this, index, value, attributes);
};
const results = [];
try {
  for (const writers of [2, 6]) {
    const history = new LifetimeHistory(writers);
    let step = 0, typing = null;
    history.onStep = () => {
      step++;
      capture = writers === 2 && step < 36;
      if (step === 36) typing = { ...lifetimeSize(history.master), typedCharacters: lifetimeTyped(history.operations),
        operations: { ...history.operations }, encoded: Buffer.from(Y.encodeStateAsUpdate(history.master.doc)).toString("base64") };
    };
    try {
      history.appendBlock();
      assert.ok(typing);
      results.push({ writers, typing, full: { ...lifetimeSize(history.master), typedCharacters: lifetimeTyped(history.operations),
        operations: { ...history.operations }, encodedBytes: Y.encodeStateAsUpdate(history.master.doc).length } });
    } finally { history.destroy(); capture = false; }
  }
} finally { Object.assign(Y.Text.prototype, original); }
process.stdout.write(JSON.stringify({ source: canonicalLifetimeSource(), tape, results }));
