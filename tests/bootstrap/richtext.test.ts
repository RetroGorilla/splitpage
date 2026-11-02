import { dom } from "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { storedImageMarkup } from "../../src/core/document/text-policy.ts";
import * as legacy from "../../src/bootstrap/richtext.ts";
import { has, intern, recordFor, setBackend } from "../../src/adapters/storage/02c-blobs.ts";
import { readFileSync } from "node:fs";
import { image } from "../../src/test/golden-helpers.mjs";

type Put = { sha: string; interned: boolean; bytes: number };

function recordingBackend(puts: Put[]) {
  return {
    name: "recorder",
    persistent: true,
    get: () => Promise.resolve(null),
    put: (sha: string, bytes: Uint8Array) => {
      puts.push({ sha, interned: has(sha), bytes: bytes.length });
      return Promise.resolve();
    },
    missing: (shas: string[]) => Promise.resolve(shas.slice())
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("consumers import richtext functions directly from their owners", () => {
  const imports = [
    ["src/bootstrap/plain-text.ts", 'import { inertBody } from "./richtext.ts";'],
    ["src/bootstrap/wiring/ports/text.ts", 'import { buildVideoCardEl } from "../../richtext.ts";'],
    ["src/features/tags/production-tags.ts", 'import { cappedText, codePointPrefix, escapeHtml, safeId as safeIdFrom } from "../../core/document/text-policy.ts";'],
    ["src/bootstrap/wiring/ports/text.ts", 'import { cellOf, fromHtml, htmlToMarkdown, inertBody, cleanPastedCell, sanitizeHtml, storedHtmlFromDom } from "../../richtext.ts";'],
    ["src/bootstrap/wiring/editor.ts", 'import { sanitizeHtml, storedHtmlFromDom } from "../richtext.ts";'],
    ["src/bootstrap/wiring/comments.ts", 'import { storedImageHtml } from "../../core/document/text-policy.ts";'],
    ["src/bootstrap/wiring/broll.ts", 'import { ensureTrailingCaretSpot } from "../../features/common/dom.ts";']
  ] as const;
  for (const [file, declaration] of imports) {
    const source = readFileSync(new URL("../../" + file, import.meta.url), "utf8");
    assert.ok(source.includes(declaration), file + ": direct owner import");
    assert.equal(source.includes("04-richtext.js"), false, file);
  }
});

test("it parses with the page's DOMParser, into a document of its own", () => {
  const body = legacy.inertBody("<b>x</b>");
  assert.ok(body.ownerDocument instanceof dom.window.Document);
  assert.notEqual(body.ownerDocument, dom.window.document);
  assert.notEqual(legacy.inertBody("").ownerDocument, body.ownerDocument);
});

test("a pasted picture is interned in the registry at once, then queued for persistence", async () => {
  const pic = image("png", 23, 17);
  const puts: Put[] = [];
  setBackend(recordingBackend(puts));
  try {
    assert.equal(has(pic.sha256), false);
    assert.equal(legacy.sanitizeHtml(`a<img src="${pic.dataUrl}">b`), "a" + storedImageMarkup(pic.record) + "b");
    assert.deepEqual(recordFor(pic.sha256), pic.record);
    assert.deepEqual(puts, []);
    await tick();
    await tick();
    assert.deepEqual(puts, [{ sha: pic.sha256, interned: true, bytes: pic.bytes.length }]);
  } finally {
    setBackend(null);
  }
});

test("a data-blob the registry holds is written with the registry's record, not its own attributes", () => {
  const held = image("gif", 6, 4);
  intern(held.bytes);
  assert.equal(legacy.sanitizeHtml(`<img data-blob="${held.sha256}" data-w="999" data-h="1" data-mime="image/png">`), storedImageMarkup(held.record));
  assert.deepEqual(legacy.imageRefOf(legacy.inertBody(`<img data-blob="${held.sha256}">`).firstElementChild as Element), held.record);
});

test("ids the sanitiser mints for anchors and b-roll keys are the identity adapter's", () => {
  const out = legacy.sanitizeHtml('<span class="cmt-anchor">a</span><span class="broll-key">B-roll:</span>');
  assert.match(out, /^<span class="cmt-anchor" data-cmt="c[0-9a-z]{8,15}">a<\/span><span class="broll-key" data-broll-id="bs[0-9a-z]{8,15}" contenteditable="false">B-roll:<\/span>$/);
});

test("cellOf keeps what it read, while fromHtml decodes afresh", () => {
  const html = "<b>bold</b> plain";
  assert.equal(legacy.cellOf(html), legacy.cellOf(html));
  assert.notEqual(legacy.fromHtml(html), legacy.fromHtml(html));
  assert.deepEqual(legacy.fromHtml(html), legacy.cellOf(html));
});

test("buildVideoCardEl and videoCardHtml give the same card", () => {
  const href = "https://vimeo.com/123";
  assert.equal(legacy.buildVideoCardEl(href).outerHTML, legacy.videoCardHtml(href));
  assert.equal(legacy.sanitizeHtml(legacy.videoCardHtml(href)), legacy.videoCardHtml(href));
});
