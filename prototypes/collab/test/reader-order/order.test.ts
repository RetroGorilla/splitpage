import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as ts from "typescript";
import { compareCodeUnits } from "../../src/readers/order.ts";
import { ReplicaHarness } from "../../src/delivery.ts";
import { addComment, addReply } from "../../src/marks/commands.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { ReaderConvergence } from "../reader-convergence.ts";
import { legacyReplyReader } from "./legacy.ts";

test("UTF-16 comparison is total and transitive on distinct canonical, surrogate and ASCII keys", () => {
  const ordered = ["", "\u0000", "E", "e\u0301", "\u00e9", "\ud800", "\ud834\udf06"];
  for (let a = 0; a < ordered.length; a++) for (let b = 0; b < ordered.length; b++) {
    const left = ordered[a], right = ordered[b]; assert.ok(left !== undefined && right !== undefined);
    assert.equal(compareCodeUnits(left, right), Math.sign(a - b));
  }
  assert.deepEqual([...ordered].reverse().sort(compareCodeUnits), ordered);
});

test("shared-state source never uses locale collation", () => {
  const root = new URL("../../src/", import.meta.url), violations: string[] = [];
  for (const path of readdirSync(root, { recursive: true })) if (typeof path === "string" && path.endsWith(".ts")) {
    const source = ts.createSourceFile(path, readFileSync(new URL(path.replaceAll("\\", "/"), root), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && (node.name.text === "localeCompare"
        || node.name.text === "Collator" && ts.isIdentifier(node.expression) && node.expression.text === "Intl")) violations.push(path);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: equal-time canonical reply ids have literal code-unit order on every delivery and late join`, () => {
  const h = new ReplicaHarness(candidate, [{ id: "R1", text: "" }]), guard = new ReaderConvergence(h, ["D1", "D2", "D3", "dup", "rev", "late-C"]);
  try {
    addComment(h.alice, "C1", "R1", 0, 0, "Alice"); h.queue.flush("D2");
    addReply(h.alice, "\u00e9", "C1", "Alice", 0); addReply(h.bob, "e\u0301", "C1", "Bob", 0); h.queue.flush("rev");
    h.lateJoin(h.alice); guard.check("canonical replies");
    for (const replica of h.replicas) {
      const model = readStructure(replica.doc, candidate, h.identities), comments = model.records?.comments as Record<string, { replies: { id: string }[] }>;
      assert.deepEqual(comments.C1?.replies.map(reply => reply.id), ["e\u0301", "\u00e9"]);
    }
    assert.throws(() => guard.check("old canonical comparator", new Map(), legacyReplyReader), /full output or no-throw check failed/);
  } finally { h.destroy(); }
});

test("the general guard rejects locale collation even in an ordinary history with no replies", () => {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]), guard = new ReaderConvergence(h, ["D1", "rev", "dup", "late-C"]);
  try {
    h.alice.insert("R1", 1, "X", ["a1"]); h.queue.flush("D1");
    guard.check("ordinary history");
    assert.throws(() => guard.check("ordinary history old comparator", new Map(), legacyReplyReader), /full output or no-throw check failed/);
  } finally { h.destroy(); }
});
