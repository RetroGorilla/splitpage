import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { parseProjectFileState } = await import("../js/18-local-files.js");

after(closeApp);

const DOC = JSON.stringify(S.state);

const SHELL_HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>';

const SHELL_TAIL = "</body></html>";

const STATE_SCRIPT = '<script id="state-data" type="application/json">' + DOC.replace(/</g, "\\u003c") + "</script>";

const DISTINCT = 100;

const PARAGRAPHS = 500;

const ATTRIBUTES = 400;

const SHAPES = {
  "distinct formatting tags then many paragraphs": () => {
    let tail = "<p>";
    for (let i = 0; i < DISTINCT; i++) tail += "<b id=i" + i + ">";
    return tail + "<p>x".repeat(PARAGRAPHS);
  },
  "one formatting tag with many attributes then many paragraphs": () => {
    let attrs = "";
    for (let i = 0; i < ATTRIBUTES; i++) attrs += " a" + i;
    return "<p><b" + attrs + ">" + "<p>x".repeat(PARAGRAPHS);
  }
};

function file(markup) {
  return new File([markup], "crafted.html", { lastModified: 1 });
}

function weight(doc) {
  let n = 0;
  doc.querySelectorAll("*").forEach((el) => { n += 1 + el.attributes.length; });
  return n;
}

async function parsedWithCount(markup) {
  const proto = window.DOMParser.prototype;
  const original = proto.parseFromString;
  let largest = 0;
  proto.parseFromString = function (text, type) {
    const doc = original.call(this, text, type);
    largest = Math.max(largest, weight(doc));
    return doc;
  };
  try {
    const parsed = await parseProjectFileState(file(markup));
    return { parsed, elements: largest };
  } finally {
    proto.parseFromString = original;
  }
}

for (const [name, shape] of Object.entries(SHAPES)) {
  test("opening a crafted .html file bounds the parse like a paste: " + name, async () => {
    const markup = SHELL_HEAD + STATE_SCRIPT + shape() + SHELL_TAIL;
    const { parsed, elements } = await parsedWithCount(markup);
    assert.ok(parsed && parsed.state, "the embedded state still opens");
    assert.equal(parsed.kind, "html");
    assert.ok(elements < markup.length, "parsed " + elements + " elements and attributes from " + markup.length + " characters");
  });
}

test("an ordinary saved .html file opens to the same state with its element count unchanged", async () => {
  const markup = SHELL_HEAD + '<main id="app"><p>one <b>two</b></p><ul><li>a</li><li>b</li></ul></main>' + STATE_SCRIPT + SHELL_TAIL;
  const plain = new window.DOMParser().parseFromString(markup, "text/html");
  const { parsed, elements } = await parsedWithCount(markup);
  assert.equal(parsed.kind, "html");
  assert.equal(JSON.stringify(parsed.state), JSON.stringify((await parseProjectFileState(file(markup))).state));
  assert.ok(elements <= weight(plain) + 2);
});
