import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, freemem } from "node:os";
import { join } from "node:path";
import "./fixtures/write-script-print-fixtures.mjs";
import "./fixtures/write-list-print-fixtures.mjs";
import { inspectPrintedFixtures } from "./fixtures/inspect-script-print.mjs";

test("printed PDF pages obey the layout rules and reject each deliberate break", {timeout:120000}, async (context) => {
  assert.ok(freemem() >= 4 * 1024 ** 3, "Printed PDF checks require at least 4 GB free RAM");
  const originalFetch = globalThis.fetch;
  let remainingEmptyLists = 2;
  let emptyLists = 0;
  context.mock.method(globalThis, "fetch", (...args) => {
    if (String(args[0]).endsWith("/json/list") && remainingEmptyLists > 0) {
      remainingEmptyLists--;
      emptyLists++;
      return Promise.resolve(new globalThis.Response("[]"));
    }
    return originalFetch(...args);
  });
  const out = mkdtempSync(join(tmpdir(), "splitpage-print-layout-"));
  const script = await inspectPrintedFixtures({out:join(out, "script"), lists:false});
  remainingEmptyLists = 2;
  const lists = await inspectPrintedFixtures({out:join(out, "lists"), lists:true, probes:true});
  assert.equal(script.fixtures + lists.fixtures, 18);
  assert.equal(script.checks + lists.checks, 267);
  assert.equal(lists.records.filter((record) => record.startsWith("probe ")).length, 11);
  assert.equal(emptyLists, 4);
  rmSync(out, {recursive:true, force:true});
});
