import { test } from "node:test";
import assert from "node:assert/strict";
import { existingTarget, isAbort, pickTarget, writeToHandle } from "../../../src/adapters/files/file-target.ts";
import type { FileHandle, FileWritable } from "../../../src/adapters/files/file-target.ts";

interface Fake extends FileHandle {
  readonly log: string[];
}

function fakeHandle(name: string, opts: { closeAnswer?: unknown; stat?: number | Error; failAt?: string } = {}): Fake {
  const log: string[] = [];
  const writable: FileWritable = {
    write: async (body) => {
      log.push("write:" + String(body));
      if (opts.failAt === "write") throw new Error("disk full");
    },
    close: async () => {
      log.push("close");
      if (opts.failAt === "close") throw new Error("disk full");
      return opts.closeAnswer;
    }
  };
  return {
    name: name,
    log: log,
    createWritable: async () => {
      log.push("createWritable");
      return writable;
    },
    getFile: async () => {
      log.push("getFile");
      if (opts.stat instanceof Error) throw opts.stat;
      return { lastModified: opts.stat === undefined ? 42 : opts.stat };
    }
  };
}

const abort = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

test("a write takes the timestamp the close answers and reads nothing after it", async () => {
  const h = fakeHandle("a.md", { closeAnswer: { lastModified: 7 } });
  assert.deepEqual(await writeToHandle(h, "body"), { lastModified: 7 });
  assert.deepEqual(h.log, ["createWritable", "write:body", "close"]);
});

test("a close that answers no timestamp is followed by one read of the file", async () => {
  const h = fakeHandle("a.md", { closeAnswer: undefined, stat: 99 });
  assert.deepEqual(await writeToHandle(h, "body"), { lastModified: 99 });
  assert.deepEqual(h.log, ["createWritable", "write:body", "close", "getFile"]);
  const odd = fakeHandle("b.md", { closeAnswer: { lastModified: "soon" }, stat: 5 });
  assert.deepEqual(await writeToHandle(odd, "x"), { lastModified: 5 });
});

test("a read that fails after a good write leaves the timestamp unknown, not the write failed", async () => {
  const h = fakeHandle("a.md", { stat: new Error("gone") });
  assert.deepEqual(await writeToHandle(h, "body"), { lastModified: null });
});

test("a failure at write or close rejects and reads nothing", async () => {
  for (const at of ["write", "close"]) {
    const h = fakeHandle("a.md", { failAt: at });
    await assert.rejects(writeToHandle(h, "body"), /disk full/);
    assert.equal(h.log.includes("getFile"), false, at);
  }
});

test("the desktop dialog is asked first; nothing chosen is cancelled", async () => {
  const chosen = fakeHandle("d.md");
  let browserAsked = false;
  const browser = async (): Promise<Fake> => { browserAsked = true; return fakeHandle("b.md"); };
  assert.deepEqual(await pickTarget({ desktop: async () => chosen, browser: browser }), { kind: "handle", handle: chosen, picked: true });
  assert.deepEqual(await pickTarget({ desktop: async () => null, browser: browser }), { kind: "cancelled" });
  assert.equal(browserAsked, false);
});

test("the browser picker gives a picked handle; an abort is cancelled and other errors pass through", async () => {
  const chosen = fakeHandle("b.md");
  assert.deepEqual(await pickTarget({ desktop: null, browser: async () => chosen }), { kind: "handle", handle: chosen, picked: true });
  assert.deepEqual(await pickTarget({ desktop: null, browser: async () => { throw abort(); } }), { kind: "cancelled" });
  await assert.rejects(pickTarget({ desktop: null, browser: async () => { throw new Error("denied"); } }), /denied/);
  await assert.rejects(pickTarget({ desktop: async () => { throw new Error("ipc"); }, browser: null }), /ipc/);
});

test("with no dialog the target is a download", async () => {
  assert.deepEqual(await pickTarget({ desktop: null, browser: null }), { kind: "download" });
});

test("an existing handle is a target that was not picked", () => {
  const h = fakeHandle("a.md");
  assert.deepEqual(existingTarget(h), { kind: "handle", handle: h, picked: false });
  assert.equal(Object.isFrozen(existingTarget(h)), true);
});

test("only an AbortError counts as an abort", () => {
  assert.equal(isAbort(abort()), true);
  assert.equal(isAbort(new Error("AbortError")), false);
  assert.equal(isAbort(null), false);
  assert.equal(isAbort("AbortError"), false);
});
