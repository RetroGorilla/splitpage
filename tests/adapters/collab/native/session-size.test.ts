import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { createNativeHeading, renameNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionOptions, NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSizeOptions } from "../../../../src/adapters/collab/native/size.ts";
import { replaceNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { createRichText } from "../../../../src/adapters/richtext/richtext.ts";
import type { Run } from "../../../../src/core/text/runs.ts";
import { cells } from "./helpers.ts";
import { AT, beatField, commentInput, replyInput } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;
type Options = Partial<NativeSessionOptions>;

const conversion = { cells, creation: "seed", at: AT, by: "Alice" };
const ids = { id: (prefix: string) => prefix + "-test", docId: () => "test" };
const images = { known: () => null, fromDataUrl: () => null };
const { sanitize } = createRichText({ DOMParser, images, ids });
const full = { kind: "refused", reason: "full" };

function open(source: NativeSessionSource, options: Options = {}): Session {
  return openNativeSession(source, { actor: "Alice", sanitize, ...options });
}

function fromRows(rows: Readonly<Record<string, string>>, options: Options = {}): Session {
  return open({ kind: "document", document: structureScript(rows), conversion }, options);
}

function fromState(state: Uint8Array, options: Options = {}): Session {
  return open({ kind: "state", state }, options);
}

function anchor(session: Session, from: number, to = from, beat = "A", cell: "narration" | "name" = "narration") {
  const result = session.commands.anchorText({ beat, cell }, from, to);
  assert(result.kind === "anchored", JSON.stringify(result));
  return result.range;
}

function bytes(session: Session): Uint8Array {
  return Y.encodeStateAsUpdate(session.ydoc);
}

function assertUnwritten(session: Session, run: () => unknown, expected: unknown, transactionAllowed = false): void {
  const before = bytes(session);
  let transactions = 0;
  const count = () => { transactions++; };
  session.ydoc.on("beforeTransaction", count);
  try {
    assert.deepEqual(run(), expected);
  } finally {
    session.ydoc.off("beforeTransaction", count);
  }
  if (!transactionAllowed) assert.equal(transactions, 0);
  assert.deepEqual(bytes(session), before);
}

function withEncoderSpy(script: string, args: readonly string[] = []): string {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as actual from "yjs";
    let docs = 0, encodes = 0;
    mock.module("yjs", { namedExports: { ...actual,
      Doc: class extends actual.Doc { constructor(...args) { super(...args); docs++; } },
      encodeStateAsUpdate: (...args) => { encodes++; return actual.encodeStateAsUpdate(...args); }
    } });
    const { openNativeSession } = await import("./src/adapters/collab/native/session.ts");
    const open = (source, options = {}) => openNativeSession(source, { actor: "Alice", sanitize: html => html, ...options });
    ${script}
  `, ...args], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function recoveryClock() {
  let now = 0;
  const pending = new Map<() => void, number>();
  return {
    now: () => now,
    pending,
    scheduleRecovery(run: () => void, delay: number) {
      pending.set(run, now + delay);
      return () => { pending.delete(run); };
    },
    advance(to: number, runTimers = true) {
      now = to;
      if (runTimers) for (const [run, due] of [...pending]) {
        if (due > now || !pending.delete(run)) continue;
        run();
      }
    }
  };
}

test("default limits are 12 MB warning, 15 MB refusal and 105% ceiling", t => {
  const session = open({ kind: "empty" }), custom = open({ kind: "empty" }, { sizeLimit: 5000 });
  t.after(() => { session.close(); custom.close(); });
  assert.equal(session.size, "ok");
  assert.deepEqual(session.sizeLimits, { limit: 15_000_000, warning: 12_000_000 });
  assert.deepEqual(custom.sizeLimits, { limit: 5000, warning: 5000 });

  const seed = fromRows({ A: "alpha" });
  const state = bytes(seed), limit = Math.floor(state.byteLength / 1.05);
  const below = fromState(state, { sizeLimit: limit + 1 }), above = fromState(state, { sizeLimit: limit });
  const at = fromState(state, { sizeLimit: state.byteLength / 2, sizeCeilingRatio: 2 });
  t.after(() => { seed.close(); below.close(); above.close(); at.close(); });
  assert.equal(below.size, "full");
  assert.equal(below.commands.deleteText(anchor(below, 0, 1)).kind, "written");
  for (const capped of [at, above]) {
    assertUnwritten(capped, () => capped.commands.deleteText(anchor(capped, 0, 1)),
      { kind: "recovery", reason: "full", runs: [] });
  }
});

test("invalid size options reject before the Y.Doc constructor runs", () => {
  withEncoderSpy(`
    for (const sizeLimit of [0, -1, NaN, Infinity]) {
      assert.throws(() => open({ kind: "empty" }, { sizeLimit }), RangeError);
    }
    for (const sizeWarning of [-1, 1001, NaN, Infinity]) {
      assert.throws(() => open({ kind: "empty" }, { sizeLimit: 1000, sizeWarning }), RangeError);
    }
    for (const sizeMinimumStep of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => open({ kind: "empty" }, { sizeMinimumStep }), RangeError);
    }
    for (const sizeCeilingRatio of [0.99, 1, NaN, Infinity, Number.MAX_VALUE]) {
      assert.throws(() => open({ kind: "empty" }, { sizeCeilingRatio }), RangeError);
    }
    assert.equal(docs, 0);
    open({ kind: "empty" }).close();
    assert.equal(docs, 1);
  `);
});

test("open classifies the real encoded bytes at exact warning and limit boundaries", t => {
  const seed = fromRows({ A: "a".repeat(200) });
  const state = bytes(seed), exact = state.byteLength;
  const ok = fromState(state, { sizeWarning: exact + 1, sizeLimit: exact + 100 });
  const warning = fromState(state, { sizeWarning: exact, sizeLimit: exact + 1 });
  const full = fromState(state, { sizeWarning: exact - 100, sizeLimit: exact });
  const converted = fromRows({ A: "a".repeat(200) }, { sizeWarning: exact - 20, sizeLimit: exact + 100 });
  t.after(() => { seed.close(); ok.close(); warning.close(); full.close(); converted.close(); });
  assert.deepEqual([ok.size, warning.size, full.size, converted.size], ["ok", "warning", "full", "warning"]);
});

test("1,000 keystrokes below warning never encode and typing 120 bytes under a line stays within the update-byte step budget", t => {
  const seed = fromRows({ A: "a" });
  t.after(seed.close);
  const counts = withEncoderSpy(`
    const state = Uint8Array.from(Buffer.from(process.argv[1], "base64"));
    const exact = state.byteLength, step = 256, typed = 1000;
    const run = async options => {
      encodes = 0;
      const session = open({ kind: "state", state }, options);
      assert.equal(encodes, 1);
      let crossing = 0, updateBytes = 0;
      session.ydoc.on("update", update => { updateBytes += update.byteLength; });
      session.subscribe(event => {
        if (event.kind === "size") crossing = actual.encodeStateAsUpdate(session.ydoc).byteLength;
      });
      for (let i = 0; i < typed; i++) {
        const at = session.commands.anchorText({ beat: "A", cell: "narration" }, i + 1);
        assert.equal(at.kind, "anchored");
        assert.equal(session.commands.typeText(at.range, "x", {}).kind, "written");
        await Promise.resolve();
      }
      const count = encodes - 1;
      session.close();
      await Promise.resolve();
      return { count, crossing, updateBytes };
    };
    const far = await run({});
    const near = await run({ sizeWarning: exact + 120, sizeMinimumStep: step });
    assert.equal(far.count, 0);
    assert.equal(far.crossing, 0);
    assert(near.crossing >= exact + 120 && near.crossing <= exact + 120 + step, JSON.stringify(near));
    assert(near.count <= Math.ceil(near.updateBytes / step) + 1, JSON.stringify(near));
    process.stdout.write(JSON.stringify({ far: far.count, near: near.count, updateBytes: near.updateBytes,
      crossing: near.crossing - exact - 120 }));
  `, [Buffer.from(bytes(seed)).toString("base64")]);
  t.diagnostic(counts);
});

test("growth rechecks at half the distance to the next line and accumulates all update lengths", () => {
  withEncoderSpy(`
    const doc = new actual.Doc();
    const state = actual.encodeStateAsUpdate(doc), exact = state.byteLength;
    let now = 0;
    const session = open({ kind: "state", state }, { sizeWarning: exact + 200, sizeLimit: 2000, sizeMinimumStep: 1, now: () => now });
    const text = session.ydoc.getText("probe");
    let grown = 0, count = 0;
    session.ydoc.on("update", update => { grown += update.byteLength; count++; });
    now = 2000;
    while (grown < 100) {
      assert.equal(encodes, 1);
      text.insert(text.length, "a");
    }
    assert(count > 1);
    assert.equal(encodes, 2);
    assert.equal(session.size, "ok");
    session.close();
    doc.destroy();
  `);
});

test("the recheck floor throttles growth near a line and growth stops triggering encodes above the ceiling", () => {
  withEncoderSpy(`
    const source = { kind: "empty" };
    const near = open(source, { sizeWarning: 3, sizeLimit: 1000, sizeMinimumStep: 64, now: () => 0 });
    const text = near.ydoc.getText("probe");
    let grown = 0;
    near.ydoc.on("update", update => { grown += update.byteLength; });
    while (grown < 64) {
      assert.equal(encodes, 1);
      text.insert(text.length, "x");
    }
    assert.equal(encodes, 2);
    near.close();
    const capped = open(source, { sizeLimit: 1, sizeMinimumStep: 1, now: () => 0 });
    capped.ydoc.getText("probe").insert(0, "a".repeat(100));
    assert.equal(encodes, 3);
    capped.close();
  `);
});

test("the default recheck step measures at exactly 64 KiB of update bytes", () => {
  withEncoderSpy(`
    function packet(size) {
      const doc = new actual.Doc();
      doc.clientID = 1;
      const padding = 64000;
      const probe = doc.getText("probe");
      probe.insert(0, "x".repeat(padding));
      const encoded = actual.encodeStateAsUpdate(doc);
      doc.destroy();
      const writer = new actual.Doc();
      writer.clientID = 1;
      writer.getText("probe").insert(0, "x".repeat(padding + size - encoded.byteLength));
      const update = actual.encodeStateAsUpdate(writer);
      writer.destroy();
      assert.equal(update.byteLength, size);
      return update;
    }
    const options = { sizeWarning: 3, sizeLimit: 1000000, now: () => 0 };
    const below = open({ kind: "empty" }, options);
    const at = open({ kind: "empty" }, options);
    const start = encodes;
    actual.applyUpdate(below.ydoc, packet(65535));
    assert.equal(encodes, start);
    actual.applyUpdate(at.ydoc, packet(65536));
    assert.equal(encodes, start + 1);
    below.close();
    at.close();
  `);
});

test("a retained middle deletion can grow encoded state by more bytes than its update", async t => {
  const seed = fromRows({ A: "a".repeat(800) });
  const state = bytes(seed), warning = state.byteLength + 1, step = 16;
  const session = fromState(state, { sizeWarning: warning, sizeMinimumStep: step });
  t.after(() => { seed.close(); session.close(); });
  let updateBytes = 0;
  session.ydoc.on("update", update => { updateBytes += update.byteLength; });
  assert.equal(session.commands.deleteText(anchor(session, 400, 401)).kind, "written");
  await Promise.resolve();
  const exact = bytes(session).byteLength;
  assert(updateBytes > 0 && updateBytes < step);
  assert(exact > warning + step);
  assert.equal(session.size, "ok");
  t.diagnostic(JSON.stringify({ updateBytes, exactGrowth: exact - state.byteLength, warningOvershoot: exact - warning, step }));
});

test("pending peer bytes can exceed the step until integration emits the update that triggers measurement", async t => {
  const seed = fromRows({ A: "a" }), state = bytes(seed), step = 128;
  const warning = state.byteLength + 400, limit = warning + 500;
  const writer = fromState(state), reader = fromState(state, { sizeWarning: warning, sizeLimit: limit, sizeMinimumStep: step });
  t.after(() => { seed.close(); writer.close(); reader.close(); });
  let received = 0;
  reader.ydoc.on("update", () => { received++; });
  const updates: Uint8Array[] = [];
  writer.ydoc.on("update", update => { updates.push(update); });
  assert.equal(writer.commands.typeText(anchor(writer, 1), "x", {}).kind, "written");
  assert.equal(writer.commands.typeText(anchor(writer, 2), "z".repeat(1200), {}).kind, "written");
  const [first, second] = updates;
  assert(first && second);
  Y.applyUpdate(reader.ydoc, second);
  await Promise.resolve();
  assert.equal(received, 0);
  assert(bytes(reader).byteLength > limit + step);
  assert.equal(reader.size, "ok");
  Y.applyUpdate(reader.ydoc, first);
  await Promise.resolve();
  assert.equal(received, 1);
  assert.equal(reader.size, "full");
  assert.deepEqual(bytes(reader), bytes(writer));
});

test("every adding command refuses in its own shape without transactions or byte changes", t => {
  const seed = fromRows({ A: "alpha", B: "beta" });
  assert.equal(seed.commands.createHeading(anchor(seed, 0), "H1", "Scene 1").kind, "written");
  assert.equal(seed.commands.createHeading(anchor(seed, 0, 0, "B"), "H2", "Scene 2").kind, "written");
  assert.equal(seed.commands.removeHeading("H2").kind, "written");
  const first = seed.commands.createComment(commentInput("a1")), second = seed.commands.createComment(commentInput("a2"));
  assert(first.kind === "written" && second.kind === "written");
  assert.equal(seed.commands.resolveComment({ comment: first.created }, { by: "Alice", at: AT }).kind, "written");
  const fresh = fromState(bytes(seed)), state = bytes(fresh);
  const session = fromState(state, { sizeLimit: state.byteLength });
  t.after(() => { seed.close(); fresh.close(); session.close(); });
  const range = anchor(session, 0, 2), caret = anchor(session, 0), name = anchor(session, 0, 2, "H1", "name");
  const runs = [{ text: "hello", marks: { b: true } }] as const;
  const c = session.commands;
  assert.equal(session.size, "full");
  assertUnwritten(session, () => c.typeText(caret, "x", { i: true }), {
    kind: "recovery", reason: "full", runs: [{ text: "x", marks: { i: true } }]
  });
  assertUnwritten(session, () => c.replaceText(range, runs), { kind: "recovery", reason: "full", runs });
  const embed = [{ atom: "image", text: "", marks: {}, ref: { sha256: "a".repeat(64) } }] as const;
  assertUnwritten(session, () => c.replaceText(range, embed), { kind: "recovery", reason: "full", runs: embed });
  assertUnwritten(session, () => c.formatText(range, { kind: "plain", mark: "b", on: true }), full);
  assertUnwritten(session, () => c.splitRow(caret), full);
  assertUnwritten(session, () => c.joinRow("B", "A", " "), full);
  assertUnwritten(session, () => c.createHeading(caret, "H3", "Scene 3"), full);
  assertUnwritten(session, () => c.renameHeading(name, "Renamed"), full);
  assertUnwritten(session, () => c.restoreHeading("H2"), full);
  assertUnwritten(session, () => c.moveBlocks([{ kind: "beat", id: "B" }], { kind: "beat", id: "A" }), full);
  assertUnwritten(session, () => c.setField(beatField("A", "status"), "ready"), full);
  assertUnwritten(session, () => c.createComment(commentInput("a3")), full);
  assertUnwritten(session, () => c.createReply(second.created, replyInput("reply")), full);
  assertUnwritten(session, () => c.setCommentBody({ comment: second.created }, "edited"), full);
  assertUnwritten(session, () => c.resolveComment({ comment: second.created }, { by: "Alice", at: AT }), full);
  assertUnwritten(session, () => c.reopenComment({ comment: first.created }), full);
  assertUnwritten(session, () => c.typeText(range, 0 as unknown as string, {}), { kind: "recovery", reason: "full", runs: [] });
  assertUnwritten(session, () => c.renameHeading(name, 0 as unknown as string), full);
});

test("a replace run length getter can only reenter as busy, even when the outer write is full", t => {
  const seed = fromRows({ A: "alpha" }), state = bytes(seed);
  const session = fromState(state, { sizeLimit: state.byteLength });
  t.after(() => { seed.close(); session.close(); });
  const range = anchor(session, 0, 1);
  const direct = openNativeScript(session.ydoc);
  t.after(direct.close);
  let inner: unknown, throughDirect: unknown;
  const runs = new Proxy([{ text: "x", marks: {} }], {
    get(target, property, receiver): unknown {
      if (property === "length") {
        inner = session.commands.setField(beatField("A", "status"), "ready");
        throughDirect = setNativeField(direct, beatField("A", "note"), "nested");
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assertUnwritten(session, () => {
    const result = session.commands.replaceText(range, runs);
    assert.deepEqual(inner, { kind: "refused", reason: "busy" });
    assert.deepEqual(throughDirect, { kind: "refused", reason: "busy" });
    return result;
  }, { kind: "recovery", reason: "full", runs });
});

test("direct replace, create and rename hold the document guard while copying their arguments", t => {
  const session = fromRows({ A: "alpha" });
  const caret = anchor(session, 0);
  assert.equal(session.commands.createHeading(caret, "H1", "Scene").kind, "written");
  const name = anchor(session, 0, 1, "H1", "name");
  const direct = openNativeScript(session.ydoc), another = openNativeScript(session.ydoc);
  t.after(() => { another.close(); direct.close(); session.close(); });
  const nested: unknown[] = [], order: string[] = [];
  const reenter = () => {
    order.push("getter");
    nested.push(setNativeField(another, beatField("A", "note"), "nested"));
  };
  session.ydoc.on("beforeTransaction", () => { order.push("transaction"); });
  const runs = new Proxy([{ text: "", marks: {} }], {
    get(target, property, receiver): unknown {
      if (property === "length") reenter();
      return Reflect.get(target, property, receiver);
    }
  });
  assertUnwritten(session, () => replaceNativeText(direct, caret, runs), { kind: "unchanged" }, true);
  assertUnwritten(session, () => createNativeHeading(direct, {
    ...caret, get target() { reenter(); return caret.target; }
  }, "H1", "Scene"), { kind: "refused", reason: "missing" }, true);
  assertUnwritten(session, () => renameNativeHeading(direct, {
    ...name, get target() { reenter(); return name.target; }
  }, "S"), { kind: "unchanged" }, true);
  assert.equal(order[0], "transaction");
  assert(nested.length >= 3);
  for (const result of nested) assert.deepEqual(result, { kind: "refused", reason: "busy" });
});

test("non-iterable replacement input throws without changing encoded state", t => {
  const seed = fromRows({ A: "alpha" }), state = bytes(seed);
  const full = fromState(state, { sizeLimit: state.byteLength });
  const nonIterable = { 0: { text: "x", marks: {} }, length: 1 } as unknown as readonly Run[];
  t.after(() => { full.close(); seed.close(); });
  for (const session of [seed, full]) {
    const before = bytes(session);
    assert.throws(() => session.commands.replaceText(anchor(session, 0), nonIterable), TypeError);
    assert.deepEqual(bytes(session), before);
  }
});

test("removals, zero-text runs, undo, redo and export work at full below the ceiling", t => {
  const seed = fromRows({ A: "alpha", B: "beta", C: "gamma" });
  assert.equal(seed.commands.createHeading(anchor(seed, 0), "H1", "Scene 1").kind, "written");
  assert.equal(seed.commands.joinRow("B", "A", " ").kind, "written");
  assert.equal(seed.commands.setField(beatField("A", "note"), "keep").kind, "written");
  const comment = seed.commands.createComment(commentInput("a1"));
  assert(comment.kind === "written");
  const fresh = fromState(bytes(seed)), state = bytes(fresh);
  const session = fromState(state, { sizeLimit: state.byteLength, sizeCeilingRatio: 2 });
  t.after(() => { seed.close(); fresh.close(); session.close(); });
  const c = session.commands;
  const caret = anchor(session, 0);
  assert.equal(session.size, "full");
  assert.equal(session.document().rows.length, 2);
  assert.deepEqual(session.encodeState(), state);
  assertUnwritten(session, () => c.replaceText(caret, []), { kind: "unchanged" }, true);
  assert.equal(c.deleteText(anchor(session, 0, 1)).kind, "written");
  assert.equal(c.typeText(anchor(session, 0, 1), "", {}).kind, "written");
  assert.equal(c.replaceText(anchor(session, 0, 1), [{ text: "", marks: {} }]).kind, "written");
  assert.equal(c.renameHeading(anchor(session, 0, 2, "H1", "name"), "").kind, "written");
  assert.equal(c.unjoinRow("B").kind, "written");
  assert.equal(c.clearField(beatField("A", "note")).kind, "written");
  assert.equal(c.removeComment({ comment: comment.created }).kind, "written");
  assert.equal(c.removeHeading("H1").kind, "written");
  assert.equal(c.removeRows(["C"]).kind, "written");
  const after = session.document();
  assert.deepEqual(after.rows.map(row => row.id), ["A", "B"]);
  assert.equal(after.rows[0]?.audioText, "ha");
  assert.equal(after.rows[0]?.note, undefined);
  assert.equal(after.comments.length, 0);
  assert.deepEqual(after.sections ?? [], []);
  assert.equal(c.undo().kind, "written");
  assert.deepEqual(session.document().rows.map(row => row.id), ["A", "B", "C"]);
  assert.equal(c.redo().kind, "written");
  assert.deepEqual(session.document().rows.map(row => row.id), ["A", "B"]);
});

test("100 undo and redo cycles stop growing at the ceiling and each refused press leaves bytes identical", async t => {
  const seed = fromRows({ A: "a" }), state = bytes(seed), ceilingRatio = 2.5, step = 64;
  const limit = state.byteLength + 500, ceiling = limit * ceilingRatio;
  const session = fromState(state, { sizeLimit: limit, sizeCeilingRatio: ceilingRatio, sizeMinimumStep: step });
  t.after(() => { seed.close(); session.close(); });
  const c = session.commands;
  assert.equal(c.typeText(anchor(session, 1), "a".repeat(1000), {}).kind, "written");
  await Promise.resolve();
  assert.equal(session.size, "full");
  let refused = 0, largestPress = 0;
  for (let i = 0; i < 100; i++) for (const press of [c.undo, c.redo]) {
    const before = bytes(session);
    const outcome = press(), after = bytes(session);
    if (outcome.kind === "refused") {
      assert.deepEqual(outcome, full);
      assert.deepEqual(after, before);
      assert(before.byteLength >= ceiling);
      refused++;
    } else {
      assert.equal(outcome.kind, "written");
      assert.equal(refused, 0);
      largestPress = Math.max(largestPress, after.byteLength - before.byteLength);
    }
  }
  assert(refused > 190);
  assert(bytes(session).byteLength <= ceiling + step + largestPress);
  const range = anchor(session, 0, 1);
  for (const run of [
    () => c.unjoinRow("A"), () => c.removeRows(["A"]), () => c.removeHeading("H1"),
    () => c.clearField(beatField("A", "note")), () => c.removeComment({ comment: "c" }), () => c.renameHeading(range, ""),
    () => c.setField(beatField("A", "status"), "ready")
  ]) assertUnwritten(session, run, full);
  for (const run of [() => c.deleteText(range), () => c.typeText(range, "", {}), () => c.replaceText(range, [])]) {
    assertUnwritten(session, run, { kind: "recovery", reason: "full", runs: [] });
  }
  assert.equal(session.document().rows.length, 1);
  assert.deepEqual(session.encodeState(), bytes(session));
});

test("busy, queued callback errors and both closed states take precedence over full", async t => {
  const seed = fromRows({ A: "alpha" }), state = bytes(seed);
  const session = fromState(state, { sizeLimit: state.byteLength });
  t.after(() => { seed.close(); session.close(); });
  const run = () => session.commands.setField(beatField("A", "status"), "ready");
  session.ydoc.transact(() => assertUnwritten(session, run, { kind: "refused", reason: "busy" }));
  await Promise.resolve();
  const failure = new Error("schedule failed");
  const schedule = t.mock.method(globalThis, "queueMicrotask", () => { throw failure; });
  assert.equal(session.commands.deleteText(anchor(session, 0, 1)).kind, "written");
  schedule.mock.restore();
  const before = bytes(session);
  assert.throws(run, failure);
  assert.deepEqual(bytes(session), before);
  session.close();
  assertUnwritten(session, run, { kind: "refused", reason: "closed" });
  await Promise.resolve();

  const destroyed = fromState(state, { sizeLimit: state.byteLength });
  t.after(destroyed.close);
  destroyed.ydoc.destroy();
  const openReader = t.mock.method(NativeScriptReader.prototype, "isClosed", () => false);
  assertUnwritten(destroyed, () => destroyed.commands.setField(beatField("A", "status"), "ready"), { kind: "refused", reason: "closed" });
  openReader.mock.restore();
  const closeReader = t.mock.method(NativeScriptReader.prototype, "isClosed", () => true);
  const readerClosed = fromState(state, { sizeLimit: state.byteLength });
  t.after(readerClosed.close);
  assertUnwritten(readerClosed, () => readerClosed.commands.setField(beatField("A", "status"), "ready"), { kind: "refused", reason: "closed" });
  closeReader.mock.restore();
});

test("merged copies retain both edits, enter full together and refuse further additions", async t => {
  const seed = fromRows({ A: "a", B: "b" }), state = bytes(seed);
  const options: NativeSizeOptions = { sizeWarning: state.byteLength + 400, sizeLimit: state.byteLength + 1000, sizeMinimumStep: 64, sizeCeilingRatio: 3 };
  const a = fromState(state, options), b = fromState(state, options);
  t.after(() => { seed.close(); a.close(); b.close(); });
  assert.equal(a.commands.typeText(anchor(a, 1), "x".repeat(700), {}).kind, "written");
  assert.equal(b.commands.typeText(anchor(b, 1, 1, "B"), "y".repeat(700), {}).kind, "written");
  await Promise.resolve();
  assert.equal(a.size, "warning");
  assert.equal(b.size, "warning");
  const aState = bytes(a), bState = bytes(b);
  Y.applyUpdate(a.ydoc, bState);
  Y.applyUpdate(b.ydoc, aState);
  await Promise.resolve();
  assert.deepEqual(a.document(), b.document());
  assert.deepEqual(bytes(a), bytes(b));
  assert.equal(a.document().rows[0]?.audioText, "a" + "x".repeat(700));
  assert.equal(a.document().rows[1]?.audioText, "b" + "y".repeat(700));
  for (const session of [a, b]) {
    assert.equal(session.size, "full");
    assertUnwritten(session, () => session.commands.setField(beatField("A", "status"), "ready"), full);
  }
});

test("editor narration obeys full admission while the peer ingress path applies and tracks updates", async t => {
  const seed = fromRows({ A: "a" }), state = bytes(seed);
  const reader = fromState(state, { sizeLimit: state.byteLength, sizeMinimumStep: 64 });
  const writer = fromState(state);
  t.after(() => { seed.close(); reader.close(); writer.close(); });
  assert.equal(reader.size, "full");
  const caret = reader.narrationCaret("A", 1);
  assert(caret);
  assertUnwritten(reader, () => reader.commands.typeText(anchor(reader, caret.offset, caret.offset, caret.beat), "x", {}),
    { kind: "recovery", reason: "full", runs: [{ text: "x", marks: {} }] });

  assert.equal(writer.commands.typeText(anchor(writer, 1), "y".repeat(600), {}).kind, "written");
  const release = reader.holdIngress();
  assertUnwritten(reader, () => applyNativePeerUpdate(reader, bytes(writer)), false);
  release();
  assert.equal(applyNativePeerUpdate(reader, bytes(writer)), true);
  await Promise.resolve();
  assert.deepEqual(bytes(reader), bytes(writer));
  assert.equal(reader.document().rows[0]?.audioText, "a" + "y".repeat(600));
  assertUnwritten(reader, reader.commands.undo, full);
});

test("size events run outside transactions, coalesce crossed lines and follow reentrant changed events", async t => {
  const seed = fromRows({ A: "a" }), state = bytes(seed), base = state.byteLength;
  const options = { sizeWarning: base + 100, sizeLimit: base + 300, sizeMinimumStep: 64 };
  const session = fromState(state, options);
  t.after(() => { seed.close(); session.close(); });
  const events: string[] = [];
  const tasks: (() => void)[] = [];
  const queued = t.mock.method(globalThis, "queueMicrotask", (callback: () => void) => { tasks.push(callback); });
  session.subscribe(change => {
    if (change.kind === "changed") {
      events.push("changed");
      if (events.length === 1) session.commands.typeText(anchor(session, 1), "x".repeat(500), {});
    } else if (change.kind === "size") {
      events.push(change.state);
      assert.equal(session.size, change.state);
      events.push(session.commands.anchorText({ beat: "A", cell: "narration" }, 0).kind);
    }
  });
  assert.equal(session.commands.typeText(anchor(session, 1), "y".repeat(120), {}).kind, "written");
  session.ydoc.getMap("probe").set("another update", true);
  assert.deepEqual(events, []);
  assert.equal(session.size, "ok");
  assert.equal(tasks.length, 1);
  tasks.shift()?.();
  assert.deepEqual(events, ["changed"]);
  tasks.shift()?.();
  assert.deepEqual(events, ["changed", "changed", "full", "anchored"]);
  assert.equal(session.size, "full");
  assert.equal(tasks.length, 0);
  session.ydoc.getMap("probe").set("write", true);
  tasks.shift()?.();
  assert.deepEqual(events, ["changed", "changed", "full", "anchored", "changed"]);
  queued.mock.restore();
  await Promise.resolve();
});

test("20 peer deletes inside two seconds trigger at most one recovery encode", t => {
  const seed = fromRows({ A: "a".repeat(1500) });
  t.after(seed.close);
  const counts = withEncoderSpy(`
    const state = Uint8Array.from(Buffer.from(process.argv[1], "base64"));
    let now = 0;
    mock.method(Date, "now", () => now);
    const writer = open({ kind: "state", state });
    const reader = open({ kind: "state", state }, { sizeLimit: state.byteLength - 100, sizeCeilingRatio: 2 });
    const target = { beat: "A", cell: "narration" };
    writer.ydoc.on("update", update => actual.applyUpdate(reader.ydoc, update));
    const start = encodes;
    for (let i = 0; i < 20; i++) {
      now = 2000 + 99 * i;
      const range = writer.commands.anchorText(target, i, i + 1).range;
      assert.equal(writer.commands.deleteText(range).kind, "written");
    }
    assert.equal(encodes - start, 1);
    now = 3999;
    const ask = () => reader.commands.setField({ kind: "beat", id: "A", field: "status" }, "ready");
    assert.equal(ask().reason, "full");
    assert.equal(encodes - start, 1);
    now = 4000;
    assert.equal(ask().reason, "full");
    assert.equal(encodes - start, 2);
    now = 6000;
    assert.equal(ask().reason, "full");
    assert.equal(encodes - start, 2);
    process.stdout.write("1 encode during 20 deletes");
    writer.close();
    reader.close();
  `, [Buffer.from(bytes(seed)).toString("base64")]);
  t.diagnostic(counts);
});

test("sparse peer growth at warning never encodes, then one deletion enables one recovery encode", () => {
  withEncoderSpy(`
    let now = 0, armed = 0, canceled = 0;
    const writer = new actual.Doc();
    const text = writer.getText("probe");
    text.insert(0, "x".repeat(256));
    const state = actual.encodeStateAsUpdate(writer);
    const reader = open({ kind: "state", state }, {
      sizeWarning: state.byteLength, now: () => now,
      scheduleRecovery: () => { armed++; return () => { canceled++; }; }
    });
    assert.equal(reader.size, "warning");
    writer.on("update", update => actual.applyUpdate(reader.ydoc, update));
    const start = encodes;
    for (let i = 0; i < 20; i++) {
      now += 2100;
      text.insert(text.length, "y");
    }
    assert.equal(encodes, start);
    assert.equal(armed, 0);
    text.delete(0, 1);
    assert.equal(encodes, start + 1);
    now += 1999;
    text.delete(0, 1);
    assert.equal(encodes, start + 1);
    assert.equal(armed, 1);
    for (let i = 0; i < 20; i++) {
      now += 2100;
      text.insert(text.length, "y");
    }
    assert.equal(encodes, start + 2);
    assert.equal(armed, 1);
    assert.equal(canceled, 1);
    reader.close();
    writer.destroy();
  `);
});

for (const startingSize of ["warning", "full"] as const) {
  test(`one timer publishes idle recovery from ${startingSize} after a peer deletion`, async t => {
    const seed = fromRows({ A: "a" }), state = bytes(seed), base = state.byteLength;
    const clock = recoveryClock();
    const writer = fromState(state);
    const reader = fromState(state, {
      ...clock, sizeWarning: base + 200, sizeLimit: base + (startingSize === "full" ? 500 : 2000),
      sizeMinimumStep: 64, sizeCeilingRatio: 4
    });
    t.after(() => { reader.close(); writer.close(); seed.close(); });
    writer.ydoc.on("update", update => Y.applyUpdate(reader.ydoc, update));
    const events: string[] = [];
    reader.subscribe(event => { events.push(event.kind === "size" ? event.state : event.kind); });
    assert.equal(writer.commands.typeText(anchor(writer, 1), "x".repeat(600), {}).kind, "written");
    await Promise.resolve();
    assert.deepEqual(events, ["changed", startingSize]);
    clock.advance(1999);
    assert.equal(writer.commands.deleteText(anchor(writer, 1, 301)).kind, "written");
    assert.equal(writer.commands.deleteText(anchor(writer, 1, 301)).kind, "written");
    await Promise.resolve();
    assert(bytes(reader).byteLength < reader.sizeLimits.warning);
    assert.deepEqual(events, ["changed", startingSize, "changed"]);
    assert.deepEqual([...clock.pending.values()], [2000]);
    clock.advance(2000, false);
    if (startingSize === "warning") {
      const at = anchor(reader, 0);
      assertUnwritten(reader, () => reader.commands.formatText(at, { kind: "plain", mark: "b", on: true }),
        { kind: "unchanged" }, true);
      await Promise.resolve();
      assert.equal(reader.size, "warning");
      assert.deepEqual([...clock.pending.values()], [2000]);
    }
    clock.advance(2000);
    await Promise.resolve();
    assert.equal(reader.size, "ok");
    assert.deepEqual(events, ["changed", startingSize, "changed", "ok"]);
    assert.equal(clock.pending.size, 0);
  });
}

test("closing clears the pending recovery timer", async t => {
  const seed = fromRows({ A: "a".repeat(800) }), state = bytes(seed);
  const clock = recoveryClock();
  const writer = fromState(state), reader = fromState(state, { ...clock, sizeWarning: state.byteLength });
  t.after(() => { writer.close(); seed.close(); reader.close(); });
  writer.ydoc.on("update", update => Y.applyUpdate(reader.ydoc, update));
  const events: string[] = [];
  reader.subscribe(event => { events.push(event.kind); });
  clock.advance(1999);
  assert.equal(writer.commands.deleteText(anchor(writer, 0, 800)).kind, "written");
  assert.deepEqual([...clock.pending.values()], [2000]);
  reader.close();
  await Promise.resolve();
  assert.deepEqual(events, ["changed", "closed"]);
  assert.equal(clock.pending.size, 0);
  clock.advance(2000);
  await Promise.resolve();
  assert.deepEqual(events, ["changed", "closed"]);
});

test("peer removals recover to warning then ok while the removing copy stays full until reopened from its bytes", async t => {
  const seed = fromRows({ A: "a", B: "b" }), state = bytes(seed), base = state.byteLength;
  const clock = recoveryClock();
  const options = { ...clock, sizeWarning: base + 300, sizeLimit: base + 900, sizeMinimumStep: 64, sizeCeilingRatio: 3 };
  const writer = fromState(state, options), reader = fromState(state, options);
  t.after(() => { seed.close(); writer.close(); reader.close(); });
  const events: string[] = [];
  reader.subscribe(change => { if (change.kind === "size") events.push(change.state); });
  assert.equal(writer.commands.typeText(anchor(writer, 1), "x".repeat(600), {}).kind, "written");
  assert.equal(writer.commands.typeText(anchor(writer, 1, 1, "B"), "y".repeat(600), {}).kind, "written");
  Y.applyUpdate(reader.ydoc, bytes(writer));
  await Promise.resolve();
  assert.deepEqual(events, ["full"]);
  assert.equal(writer.size, "full");
  assert.equal(reader.size, "full");

  clock.advance(1999);
  assert.equal(writer.commands.deleteText(anchor(writer, 1, 601)).kind, "written");
  Y.applyUpdate(reader.ydoc, bytes(writer));
  await Promise.resolve();
  assert(bytes(reader).byteLength < options.sizeLimit);
  assertUnwritten(reader, () => reader.commands.setField(beatField("A", "status"), "ready"), full);
  clock.advance(2000, false);
  assertUnwritten(reader, () => reader.commands.formatText(anchor(reader, 0), { kind: "plain", mark: "b", on: true }),
    { kind: "unchanged" }, true);
  await Promise.resolve();
  assert.deepEqual(events, ["full", "warning"]);
  assert.equal(reader.size, "warning");
  assert.equal(writer.size, "full");

  clock.advance(4000, false);
  assert.equal(writer.commands.deleteText(anchor(writer, 1, 601, "B")).kind, "written");
  Y.applyUpdate(reader.ydoc, bytes(writer));
  assert(bytes(reader).byteLength < options.sizeWarning);
  await Promise.resolve();
  assert.deepEqual(events, ["full", "warning", "ok"]);
  assert.equal(reader.size, "ok");
  assert(bytes(writer).byteLength >= options.sizeLimit);
  assert.equal(writer.size, "full");
  const reopened = fromState(bytes(writer), options);
  t.after(reopened.close);
  assert(bytes(reopened).byteLength < options.sizeWarning);
  assert.equal(reopened.size, "ok");
  assert.deepEqual(reopened.document(), writer.document());
});
