import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NativeReplicaInvoke } from "../../../../shared/native-replica.d.ts";
import { desktopFixture } from "./desktop-local-store-fixture.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { STORE_OPTIONS, STORED, seedSession, stored, typeAt } from "./local-store-fixture.ts";

const runWriter = promisify(execFile);
const interruptedWriter = fileURLToPath(new URL("./interrupt-desktop-write.ts", import.meta.url));

function commands(t: TestContext) {
  const session = seedSession({ A: "start" });
  t.after(() => session.close());
  const initial = session.encodeState();
  const frames: Uint8Array[] = [];
  session.ydoc.on("update", bytes => frames.push(bytes));
  typeAt(session, 0, "A");
  const throughA = session.encodeState();
  typeAt(session, 1, "B");
  typeAt(session, 2, "C");
  const [a, b, c] = frames;
  assert.ok(a && b && c);
  return { initial, a, b, c, throughA };
}

async function claim(invoke: NativeReplicaInvoke, name: string) {
  const opened = await invoke(["open", name]);
  assert.equal(opened.kind, "opened");
  const { lease } = opened;
  return {
    write: (generation: number, bytes: Uint8Array, checkpoint = false) => invoke(["write", name, lease, generation, checkpoint, bytes]),
    close: () => invoke(["close", name, lease])
  };
}

async function expectCopy(test: Awaited<ReturnType<typeof desktopFixture>>, name: string, generation: number, text: string) {
  const replica = await test.restart().store.open(name, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  try {
    assert.equal(replica.generation, generation);
    assert.equal(replica.session.document().rows[0]?.audioText, text);
  } finally { replica.session.close(); await replica.closed; }
}

function logAt(directory: string, name: string): string {
  return join(directory, "native-replicas", createHash("sha256").update(name).digest("hex"), "updates");
}

for (const fault of [
  ["append:write", "before"], ["append:write", "partial"], ["append:write", "after"],
  ["append:sync", "before"], ["append:sync", "after"]
] as const) {
  test(`append interruption ${fault.join(" ")} preserves acknowledged edits on restart`, async t => {
    const fixture = await desktopFixture(t), updates = commands(t);
    const writer = await claim(fixture.first.invoke, "append-fault");
    assert.deepEqual(await writer.write(1, updates.initial), STORED);
    assert.deepEqual(await writer.write(2, updates.a), STORED);
    const [phase, point] = fault;
    let reached = false;
    fixture.intercept(phase, async (perform, partial) => {
      reached = true;
      if (point === "after") await perform();
      if (point === "partial") { assert.ok(partial); await partial(); }
      throw new Error("injected append interruption");
    });
    assert.deepEqual(await writer.write(3, updates.b), { kind: "failed", reason: "io" });
    assert.equal(reached, true);
    assert.deepEqual(await writer.close(), STORED);
    await expectCopy(fixture, "append-fault", 2, "Astart");
  });
}

test("a desktop receipt remains pending until append fsync returns", { timeout: 5000 }, async t => {
  const { store, intercept } = await desktopFixture(t);
  const opened = await store.open("flush-gate", STORE_OPTIONS);
  assert.equal(opened.kind, "opened");
  const entered = eventResult<undefined>(), allow = eventResult<undefined>();
  intercept("append:sync", async perform => {
    entered.resolve(undefined);
    await allow.promise;
    await perform();
  });
  const seen: number[] = [];
  opened.subscribe(receipt => { if (receipt.kind === "stored") seen.push(receipt.generation); });
  const held = opened.session.ydoc.getText("first");
  held.insert(0, "first");
  const flushed = opened.flush();
  try {
    const outcome = await Promise.race([entered.promise.then(() => "entered"), flushed.then(() => "acknowledged")]);
    assert.equal(outcome, "entered");
    assert.deepEqual(seen, []);
  } finally { allow.resolve(undefined); }
  assert.deepEqual(await flushed, stored(1));
  assert.deepEqual(seen, [1]);
  opened.session.close();
  await opened.closed;
});

for (const point of ["append", "checkpoint"] as const) {
  test(`reopen syncs the interrupted ${point} before its recovered generation is stored`, { timeout: 15000 }, async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "interrupted";
    const writer = await claim(fixture.first.invoke, name);
    assert.deepEqual(await writer.write(1, updates.initial, point === "append"), STORED);
    assert.deepEqual(await writer.close(), STORED);
    const bytes = point === "append" ? updates.a : updates.throughA;
    await runWriter(process.execPath, [interruptedWriter, fixture.directory, name, point, Buffer.from(bytes).toString("base64")], { timeout: 10000 });

    const entered = eventResult<undefined>(), allow = eventResult<undefined>();
    let synced = false;
    fixture.intercept(point === "append" ? "updates:sync" : "checkpoint:sync", async sync => {
      entered.resolve(undefined);
      await allow.promise;
      await sync();
      synced = true;
    });
    const start = fixture.phases.length;
    const receipt = fixture.restart(true).store.open(name, STORE_OPTIONS).then(async opened => {
      assert.equal(opened.kind, "opened");
      try {
        assert.equal(opened.session.document().rows[0]?.audioText, "Astart");
        const result = await opened.flush();
        assert.equal(synced, true);
        const phases = fixture.phases.slice(start);
        assert.ok(phases.includes("checkpoint:sync"));
        assert.ok(phases.includes("updates:sync"));
        assert.ok(phases.includes("native-replicas:dir-sync"));
        assert.ok(phases.includes(createHash("sha256").update(name).digest("hex") + ":dir-sync"));
        return result;
      } finally { opened.session.close(); await opened.closed; }
    });
    try {
      assert.equal(await Promise.race([entered.promise.then(() => "sync"), receipt.then(() => "stored")]), "sync");
    } finally { allow.resolve(undefined); }
    assert.deepEqual(await receipt, stored(2));
  });
}

for (const phase of ["checkpoint:sync", "updates:sync", "native-replicas:dir-sync"] as const) {
  test(`reopen leaves files intact when ${phase} fails before torn tail repair`, async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "open-sync-failure";
    const writer = await claim(fixture.first.invoke, name);
    assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
    assert.deepEqual(await writer.write(2, updates.a), STORED);
    assert.deepEqual(await writer.close(), STORED);
    const log = logAt(fixture.directory, name), checkpoint = join(dirname(log), "checkpoint");
    const snapshot = await readFile(checkpoint);
    const original = await readFile(log);
    const torn = Buffer.concat([original, Buffer.from([1, 2])]);
    await writeFile(log, torn);
    fixture.intercept(phase, async () => { throw new Error("injected recovery sync failure"); });
    const { store } = fixture.restart(true);
    assert.deepEqual(await store.open(name, STORE_OPTIONS), { kind: "failed", reason: "io" });
    assert.deepEqual(await readFile(checkpoint), snapshot);
    assert.deepEqual(await readFile(log), torn);
    const reopened = await store.open(name, STORE_OPTIONS);
    assert.equal(reopened.kind, "opened");
    try {
      assert.deepEqual(await reopened.flush(), stored(2));
      assert.deepEqual(await readFile(log), original);
    } finally { reopened.session.close(); await reopened.closed; }
  });
}

for (const file of ["checkpoint.new", "updates.new"]) {
  for (const [operation, point] of [
    ["write", "before"], ["write", "partial"], ["sync", "before"], ["sync", "after"],
    ["rename", "before"], ["rename", "after"]
  ] as const) {
    test(`checkpoint interruption ${file} ${operation} ${point} preserves the newer tail`, async t => {
      const fixture = await desktopFixture(t), updates = commands(t);
      const writer = await claim(fixture.first.invoke, "checkpoint-fault");
      assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
      assert.deepEqual(await writer.write(2, updates.a), STORED);
      assert.deepEqual(await writer.write(3, updates.b), STORED);
      let reached = false;
      fixture.intercept(`${file}:${operation}`, async (perform, partial) => {
        reached = true;
        if (point === "after") await perform();
        if (point === "partial") { assert.ok(partial); await partial(); }
        throw new Error("injected checkpoint interruption");
      });
      assert.deepEqual(await writer.write(2, updates.throughA, true), { kind: "failed", reason: "io" });
      assert.equal(reached, true);
      assert.deepEqual(await writer.close(), STORED);
      await expectCopy(fixture, "checkpoint-fault", 3, "ABstart");
    });
  }
}

for (const file of ["checkpoint.new", "updates.new"]) {
  test(`a failed directory flush after ${file} rename preserves acknowledged edits`, async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "directory-sync";
    const writer = await claim(fixture.first.invoke, name);
    assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
    assert.deepEqual(await writer.write(2, updates.a), STORED);
    assert.deepEqual(await writer.write(3, updates.b), STORED);
    let reached = false;
    fixture.intercept(`${file}:rename`, async perform => {
      await perform();
      const directory = createHash("sha256").update(name).digest("hex");
      fixture.intercept(`${directory}:dir-sync`, async () => {
        reached = true;
        throw new Error("injected directory sync failure");
      });
    });
    assert.deepEqual(await writer.write(2, updates.throughA, true), { kind: "failed", reason: "io" });
    assert.equal(reached, true);
    assert.deepEqual(await writer.close(), STORED);
    await expectCopy(fixture, name, 3, "ABstart");
  });
}

test("an append waits for a failed rotation directory sync even when the rotated log has a tail", async t => {
  const fixture = await desktopFixture(t), updates = commands(t), name = "rotation-retry";
  const writer = await claim(fixture.first.invoke, name);
  assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
  assert.deepEqual(await writer.write(2, updates.a), STORED);
  assert.deepEqual(await writer.write(3, updates.b), STORED);
  const sync = createHash("sha256").update(name).digest("hex") + ":dir-sync";
  const fail = async () => { throw new Error("injected directory sync failure"); };
  fixture.intercept("updates.new:rename", async perform => {
    await perform();
    fixture.intercept(sync, fail);
  });
  const failure = { kind: "failed", reason: "io" };
  assert.deepEqual(await writer.write(2, updates.throughA, true), failure);
  fixture.intercept(sync, fail);
  assert.deepEqual(await writer.write(4, updates.c), failure);
  assert.deepEqual(await writer.write(4, updates.c), STORED);
  assert.deepEqual(await writer.close(), STORED);
  await expectCopy(fixture, name, 4, "ABCstart");
});

if (process.platform === "win32") {
  for (const file of ["checkpoint", "updates"]) {
    for (const point of ["before", "after"]) {
      test(`Windows ${file} flush failure ${point} sync preserves acknowledged edits`, async t => {
        const fixture = await desktopFixture(t), updates = commands(t), name = "windows-rename";
        const filePath = logAt(fixture.directory, name);
        const writer = await claim(fixture.first.invoke, name);
        assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
        assert.deepEqual(await writer.write(2, updates.a), STORED);
        assert.deepEqual(await writer.write(3, updates.b), STORED);
        const originalLog = await readFile(filePath);
        let reached = false;
        fixture.intercept(`${file}:sync`, async perform => {
          reached = true;
          if (point === "after") await perform();
          throw new Error("injected renamed file sync failure");
        });
        assert.deepEqual(await writer.write(2, updates.throughA, true), { kind: "failed", reason: "io" });
        assert.equal(reached, true);
        if (file === "checkpoint") assert.deepEqual(await readFile(filePath), originalLog);
        assert.deepEqual(await writer.close(), STORED);
        await expectCopy(fixture, name, 3, "ABstart");
      });
    }
  }

  test("Windows acknowledges a newly created log only after its file entry is flushed", async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "windows-create";
    const writer = await claim(fixture.first.invoke, name);
    fixture.intercept("updates:sync", async () => { throw new Error("injected new log sync failure"); });
    assert.deepEqual(await writer.write(1, updates.initial), { kind: "failed", reason: "io" });
    assert.equal((await readFile(logAt(fixture.directory, name))).length, 0);
    assert.deepEqual(await writer.write(1, updates.initial), STORED);
    assert.deepEqual(await writer.close(), STORED);
    await expectCopy(fixture, name, 1, "start");
  });
}

for (const form of ["short header", "short payload"] as const) {
  test(`a torn tail with a ${form} is discarded and the next append survives`, async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "torn";
    const file = logAt(fixture.directory, name);
    const writer = await claim(fixture.first.invoke, name);
    assert.deepEqual(await writer.write(1, updates.initial, true), STORED);
    assert.deepEqual(await writer.write(2, updates.a), STORED);
    const prefix = await readFile(file);
    assert.deepEqual(await writer.write(3, updates.b), STORED);
    assert.deepEqual(await writer.close(), STORED);
    const log = await readFile(file);
    const last = log.subarray(prefix.byteLength);
    assert.ok(last.length > updates.b.length);
    const torn = form === "short header" ? last.subarray(0, 3) : last.subarray(0, last.length - 1);
    await writeFile(file, Buffer.concat([prefix, torn]));
    const reopened = await fixture.restart().store.open(name, STORE_OPTIONS);
    assert.equal(reopened.kind, "opened");
    try {
      assert.equal(reopened.generation, 2);
      assert.equal(reopened.session.document().rows[0]?.audioText, "Astart");
      assert.deepEqual(await readFile(file), prefix);
      typeAt(reopened.session, 1, "C");
      assert.deepEqual(await reopened.flush(), stored(3));
    } finally { reopened.session.close(); await reopened.closed; }
    await expectCopy(fixture, name, 3, "ACstart");
  });
}

for (const fault of ["middle length", "middle payload", "final payload"] as const) {
  test(`a corrupt ${fault} refuses open and preserves every record on disk`, async t => {
    const fixture = await desktopFixture(t), updates = commands(t), name = "damaged";
    const file = logAt(fixture.directory, name);
    const writer = await claim(fixture.first.invoke, name);
    assert.deepEqual(await writer.write(1, updates.initial), STORED);
    const first = await readFile(file);
    assert.deepEqual(await writer.write(2, updates.a), STORED);
    const second = await readFile(file);
    assert.deepEqual(await writer.write(3, updates.b), STORED);
    assert.deepEqual(await writer.close(), STORED);
    const intact = await readFile(file), damaged = Buffer.from(intact);
    const offset = fault === "middle length" ? first.length + 3 : fault === "middle payload" ? second.length - 1 : intact.length - 1;
    damaged.writeUInt8(damaged.readUInt8(offset) ^ 1, offset);
    await writeFile(file, damaged);
    try {
      assert.deepEqual(await fixture.restart().store.open(name, STORE_OPTIONS), { kind: "failed", reason: "io" });
      assert.deepEqual(await readFile(file), damaged);
    } finally { await writeFile(file, intact); }
    await expectCopy(fixture, name, 3, "ABstart");
  });
}

test("a torn v2 journal record is discarded while preserving the previous replica and journal", async t => {
  const fixture = await desktopFixture(t), updates = commands(t), name = "torn-journal";
  const file = logAt(fixture.directory, name);
  const opened = await fixture.first.invoke(["open", name]);
  assert.equal(opened.kind, "opened");
  const { lease } = opened;
  const firstJournal = new TextEncoder().encode('{"version":1,"data":{"through":1,"entries":[]}}');
  const secondJournal = new TextEncoder().encode('{"version":1,"data":{"through":2,"entries":[]}}');
  assert.deepEqual(await fixture.first.invoke(["write", name, lease, 1, true, updates.initial, firstJournal]), STORED);
  assert.deepEqual(await fixture.first.invoke(["write", name, lease, 2, false, updates.a, firstJournal]), STORED);
  const prefix = await readFile(file);
  assert.deepEqual(await fixture.first.invoke(["write", name, lease, 3, false, updates.b, secondJournal]), STORED);
  assert.deepEqual(await fixture.first.invoke(["close", name, lease]), STORED);

  const full = await readFile(file);
  await writeFile(file, full.subarray(0, full.length - 2));
  const reopened = fixture.restart();
  const next = await reopened.invoke(["open", name]);
  assert.equal(next.kind, "opened");
  try {
    assert.deepEqual(await reopened.invoke(["read-journal", name, next.lease]), { kind: "journal", bytes: firstJournal });
    assert.deepEqual(await readFile(file), prefix);
  } finally {
    assert.deepEqual(await reopened.invoke(["close", name, next.lease]), STORED);
  }
});
