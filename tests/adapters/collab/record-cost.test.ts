import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("every record kind prepares create/change/remove without a full-state encode, apart from the formatting monitor", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as actual from "yjs";
    let encodes = 0, monitorEncodes = 0;
    const count = stack => {
      const caller = (stack.split("\n")[2] ?? "").replaceAll("\\", "/");
      if (caller.includes("tests/adapters/collab/helpers.ts:") && /(?:monitorNativeFormatting|observe)/.test(caller)) monitorEncodes++;
      else encodes++;
    };
    mock.module("yjs", { namedExports: { ...actual,
      encodeStateAsUpdate: (...args) => { count(new Error().stack ?? ""); return actual.encodeStateAsUpdate(...args); },
      encodeStateAsUpdateV2: (...args) => { count(new Error().stack ?? ""); return actual.encodeStateAsUpdateV2(...args); }
    } });
    const { executeSharedOperations } = await import("./src/adapters/collab/execute.ts");
    const { operation } = await import("./tests/adapters/collab/executor-support.ts");
    const { recordReplicas, recordExamples, recordKey, createRecord, setRecord, deleteRecord } = await import("./tests/adapters/collab/record-support.ts");
    const run = recordReplicas();
    try {
      assert.ok(encodes > 0); encodes = 0; monitorEncodes = 0;
      const commands = [];
      for (const kind of Object.keys(recordExamples)) {
        const key = recordKey(kind), by = kind === "replies" ? "Bob" : "Alice";
        const fields = { ...recordExamples[kind], ...(kind === "shots" ? { props: [{ id: "t_new", name: "Mug" }] }
          : kind === "gallery" ? { links: [{ href: "https://example.test" }] } : {}) };
        commands.push(createRecord(kind, key, fields, by), setRecord(kind, key, "rank", "2", by), deleteRecord(kind, key, by));
      }
      assert.equal(commands.length, 21);
      assert.deepEqual(executeSharedOperations(run.a, commands.map(operation)), { ok: true });
      assert.deepEqual(executeSharedOperations(run.a, []), { ok: true });
      assert.equal(executeSharedOperations(run.a, [operation(setRecord("people", "missing", "name", "A"))]).ok, false);
      assert.equal(encodes, 0); assert.ok(monitorEncodes > 0);
    } finally { run.close(); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
