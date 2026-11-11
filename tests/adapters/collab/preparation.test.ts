import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { applySharedMapWrites, createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import type { SharedPreparedWrite } from "../../../src/adapters/collab/prepare.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, encodeSharedStateVector, transactSharedDocument, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { validatedFixture, createMonitoredSharedDocument as createSharedDocument } from "./helpers.ts";
import { agree, execute, operation, ref, replicas } from "./executor-support.ts";

test("prepare overlays created records, replaces descendants, and never exposes writable live values", () => {
  const run = replicas();
  try {
    const overlay = createSharedPreparation(run.a);
    overlay.include([{ kind: "map", path: ["people", "virtual"] }, { kind: "set", path: ["people", "virtual", "old"], value: 1 }]);
    overlay.include([{ kind: "map", path: ["people", "virtual"] }]);
    assert.equal(overlay.view.kind(["people", "virtual", "old"]), "missing");
    assert.deepEqual(overlay.view.keys(["people", "virtual"]), []);
    let prepared = 0;
    registerSharedOperationHandlers(run.a, { "record-create": (command, view) => {
      prepared++;
      assert.equal(view.kind(["people", command.target.record]), "missing");
      const writes: SharedPreparedWrite[] = [{ kind: "map", path: ["people", command.target.record] },
        { kind: "set", path: ["people", command.target.record, "name"], value: command.fields.name }];
      return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
    }, "record-set": (command, view) => {
      prepared++;
      assert.equal(view.kind(["people", command.target.record]), "map");
      assert.equal(view.get(["people", command.target.record, "name"]), "first");
      assert.deepEqual(view.keys(["people", command.target.record]), ["name"]);
      assert.equal(collabState(run.a).roots.people.has(command.target.record), false);
      const title = view.get(["meta", "fileTitle"]); assert.ok(Object.isFrozen(title));
      const writes: SharedPreparedWrite[] = [{ kind: "set", path: ["people", command.target.record, command.field], value: command.clear ? null : command.value }];
      return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
    } });
    execute(run.a, { kind: "record-create", id: "c", by: "A", target: { collection: "people", record: "P" }, fields: { name: "first" } },
      { kind: "record-set", id: "s", by: "A", target: { collection: "people", record: "P" }, field: "name", value: "second" });
    assert.equal(prepared, 2);
    assert.equal((collabState(run.a).roots.people.get("P") as Y.Map<unknown>).get("name"), "second");
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`file-title pair stays atomic across hydration and competing writers ${order}`, () => {
  const run = replicas();
  try {
    const target = { scope: "document" as const, record: ref(String(collabState(run.a).roots.meta.get("docId"))) };
    execute(run.a, { kind: "scalar", id: "a", by: "A", target, field: "fileTitle", value: { titleOrigin: "user", titleVersion: "v2" } });
    execute(run.b, { kind: "scalar", id: "b", by: "B", target, field: "fileTitle", value: { titleOrigin: "file", titleVersion: "v37" } }); run.queue.flush(order);
    agree("atomic pair", order, [run.a, run.b], handle => readSharedScalars(handle, target)?.fileTitle, { titleOrigin: "file", titleVersion: "v37" });
    execute(run.a, { kind: "scalar", id: "c", by: "A", target, field: "fileTitle", value: { titleOrigin: "user", titleVersion: "v3" } });
    execute(run.b, { kind: "scalar", id: "d", by: "B", target, field: "fileTitle", value: { titleVersion: "v38" } }); run.queue.flush(order);
    agree("atomic omitted origin", order, [run.a, run.b], handle => readSharedScalars(handle, target)?.fileTitle, { titleVersion: "v38" });
  } finally { run.close(); }
});

test("scalar calls create no staging document, keep the live client set and use constant reads with unrelated records", () => {
  const counts: number[] = [];
  for (const size of [0, 10000]) {
    const run = replicas();
    try {
      transactSharedDocument(run.a, "hydration", () => { for (let index = 0; index < size; index++) collabState(run.a).roots.people.set(`P${index}`, { name: "person" }); });
      const clients = [...Y.decodeStateVector(encodeSharedStateVector(run.a)).keys()].sort();
      const docGets = mock.method(Y.Doc.prototype, "get"), mapGets = mock.method(Y.Map.prototype, "get");
      try {
        execute(run.a, { kind: "scalar", id: "s", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 4 });
        assert.deepEqual(executeSharedOperations(run.a, []), { ok: true });
        assert.equal(executeSharedOperations(run.a, [operation({ kind: "record-delete", id: "x", by: "A", target: { collection: "people", record: "missing" } })]).ok, false);
        assert.equal(docGets.mock.callCount(), 0);
        counts.push(mapGets.mock.callCount());
      } finally { docGets.mock.restore(); mapGets.mock.restore(); }
      assert.deepEqual([...Y.decodeStateVector(encodeSharedStateVector(run.a)).keys()].sort(), clients);
    } finally { run.close(); }
  }
  assert.deepEqual(counts, [4, 4]);
});

test("no full-state encoder runs during accepted, empty or immediately refused calls", () => {
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
    const { operation, replicas } = await import("./tests/adapters/collab/executor-support.ts");
    const { installTextSeamProbe } = await import("./tests/adapters/collab/text-seam-support.ts");
    const run = replicas(), handle = run.a;
    try {
      assert.ok(encodes > 0);
      encodes = 0; monitorEncodes = 0; installTextSeamProbe(handle);
      const scalar = operation({ kind: "scalar", id: "s", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 4 });
      const status = operation({ kind: "status", id: "t", by: "A", target: { scope: "beat", record: "R1" }, value: "shot", parents: [] });
      const text = operation({ kind: "text-insert", id: "text", by: "A", target: { owner: "R1", segment: "b:R1", field: "audioText" }, at: { left: null, right: "0", affinity: "before" }, content: [{ value: "X", marks: [{ kind: "b", value: true }] }] });
      assert.deepEqual(executeSharedOperations(handle, [scalar, status, text]), { ok: true });
      assert.deepEqual(executeSharedOperations(handle, []), { ok: true });
      assert.equal(executeSharedOperations(handle, [operation({ kind: "record-delete", id: "x", by: "A", target: { collection: "people", record: "missing" } })]).ok, false);
      assert.equal(encodes, 0);
      assert.ok(monitorEncodes > 0);
    } finally { run.close(); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("thirty prepare refusals leave encoded state unchanged; an apply throw escapes as a handler defect", () => {
  const run = replicas();
  try {
    let refused = 0;
    for (const scope of ["document", "beat", "heading"]) for (const field of ["id", "status", "title", "schema", "docId", "rev", "capture", "text", "firstSceneId", "unsupported"]) {
      const record = scope === "document" ? String(collabState(run.a).roots.meta.get("docId")) : scope === "beat" ? "R1" : "H1";
      const before = encodeSharedState(run.a);
      const result = executeSharedOperations(run.a, [operation({ kind: "scalar", id: "good", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 2 }),
        operation({ kind: "scalar", id: "bad", by: "A", target: { scope, record }, field, value: "invalid" })]);
      assert.ok(!result.ok); assert.equal(result.index, 1); assert.equal(result.operation.id, "bad"); assert.deepEqual(encodeSharedState(run.a), before); refused++;
    }
    assert.equal(refused, 30);
    registerSharedOperationHandlers(run.a, { "record-delete": () => ({ ok: true, writes: [], apply: () => { throw new Error("broken apply"); } }) });
    assert.throws(() => execute(run.a, { kind: "record-delete", id: "defect", by: "A", target: { collection: "people", record: "P" } }), /broken apply/);
  } finally { run.close(); }
});

test("hydration and commands share the atomic file-title form; array origins are refused by author and reader", () => {
  const handle = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ titleOrigin: "file", titleVersion: "v37", rows: [] }));
    const target = { scope: "document" as const, record: ref(String(collabState(handle).roots.meta.get("docId"))) };
    assert.deepEqual(readSharedScalars(handle, target)?.fileTitle, { titleOrigin: "file", titleVersion: "v37" });
    assert.equal(collabState(handle).roots.meta.has("titleOrigin"), false); assert.equal(collabState(handle).roots.meta.has("titleVersion"), false);
    const before = encodeSharedState(handle);
    assert.equal(executeSharedOperations(handle, [operation({ kind: "scalar", id: "bad", by: "A", target, field: "fileTitle", value: { titleOrigin: ["file"] } })]).ok, false);
    assert.deepEqual(encodeSharedState(handle), before);
    transactSharedDocument(handle, "remote", () => collabState(handle).roots.meta.set("fileTitle", { titleOrigin: ["file"] }));
    agree("array origin", "rev", [handle], copy => readSharedScalars(copy, target));
    assert.equal(Object.hasOwn(readSharedScalars(handle, target) ?? {}, "fileTitle"), false);
  } finally { destroySharedDocument(handle); }
});

for (const order of deliveryOrders) test(`status ids are unique per writer and cannot be reused locally ${order}`, () => {
  const run = replicas(), target = { scope: "beat" as const, record: ref("R1") };
  try {
    execute(run.a, { kind: "status", id: "same", by: "Alice", target, value: "ready", parents: [] });
    const before = encodeSharedState(run.a);
    assert.equal(executeSharedOperations(run.a, [operation({ kind: "status", id: "same", by: "Alice", target, value: "shot", parents: ["same"] })]).ok, false);
    assert.deepEqual(encodeSharedState(run.a), before);
    execute(run.b, { kind: "status", id: "same", by: "Bob", target, value: "shot", parents: [] }); run.queue.flush(order);
    agree("same operation id", order, [run.a, run.b], handle => ({ value: readSharedStatus(handle, target), heads: readSharedStatusHeads(handle, target) }),
      { value: "todo", heads: ['["1","same"]', '["2","same"]'] });
    assert.equal(collabState(run.a).roots.statusEvents.size, 2);
    const ambiguous = encodeSharedState(run.a);
    assert.equal(executeSharedOperations(run.a, [operation({ kind: "status", id: "ambiguous", by: "Alice", target, value: "shot", parents: ["same"] })]).ok, false);
    assert.deepEqual(encodeSharedState(run.a), ambiguous);
    execute(run.a, { kind: "status", id: "after", by: "Alice", target, value: "shot", parents: readSharedStatusHeads(run.a, target) }); run.queue.flush(order);
    agree("later after id collision", order, [run.a, run.b], handle => readSharedStatus(handle, target), "shot");
  } finally { run.close(); }
});
