import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createShareClipboard } from "../../../src/features/clipboard/share-text.ts";

function windowWith(clipboard: unknown, exec: (command: string) => boolean): Window {
  const doc = document.implementation.createHTMLDocument("t");
  doc.execCommand = exec;
  return { document: doc, navigator: { clipboard } } as unknown as Window;
}

test("text is written with the async clipboard when there is one", async () => {
  const written: string[] = [];
  const clipboard = createShareClipboard(windowWith({ writeText: (t: string) => { written.push(t); return Promise.resolve(); } }, () => false));
  assert.equal(await clipboard.copyText("https://example.test/?doc=1"), true);
  assert.deepEqual(written, ["https://example.test/?doc=1"]);
});

test("a refused async write falls back to selecting a hidden field", async () => {
  const commands: string[] = [];
  const clipboard = createShareClipboard(windowWith({ writeText: () => Promise.reject(new Error("denied")) }, (c) => { commands.push(c); return true; }));
  assert.equal(await clipboard.copyText("x"), true);
  assert.deepEqual(commands, ["copy"]);
});

test("without an async clipboard the fallback answers false when the copy fails or throws", async () => {
  assert.equal(await createShareClipboard(windowWith(undefined, () => false)).copyText("x"), false);
  assert.equal(await createShareClipboard(windowWith(undefined, () => { throw new Error("no"); })).copyText("x"), false);
});
