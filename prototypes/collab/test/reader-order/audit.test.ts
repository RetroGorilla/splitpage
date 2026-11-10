import assert from "node:assert/strict";
import { test } from "node:test";
import { readerOrderChanges, validateReaderOrderChanges } from "../../src/readers/source-audit.ts";

test("reader source audit keeps the evidence commit and rejects missing, duplicate or changed declarations", () => {
  validateReaderOrderChanges();
  assert.equal(readerOrderChanges().baseHead, "8efcff798f7d92ab890207d414ec2f416b69f695");
  for (const defect of ["missing", "duplicate", "before", "after", "original", "base"] as const) {
    const value = structuredClone(readerOrderChanges()), first = value.files[0]; assert.ok(first);
    if (defect === "missing") value.files.pop();
    if (defect === "duplicate") value.files.push(first);
    if (defect === "before") first.before = "0".repeat(64);
    if (defect === "after") first.after = "0".repeat(64);
    if (defect === "original") first.original = "changed";
    if (defect === "base") value.baseHead = "0".repeat(40);
    assert.throws(() => validateReaderOrderChanges(value), defect);
  }
});
