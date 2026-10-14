import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { LONG_DEMO } from "../js/_starters.js";

await bootApp();

const { parseProjectFileState } = await import("../js/18-local-files.js");
const { buildPublishHtml } = await import("../js/02-state.js");
const { migrateDocument } = await import("../js/02b-doc-id.js");

after(closeApp);

const SOURCE = JSON.parse(JSON.stringify(LONG_DEMO.state));
SOURCE.rows.push({
  id: "rich-row",
  status: "draft",
  visualText: '<strong>bold</strong> <em>italic</em> <u>under</u> <a href="https://example.com/">link</a> <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lens" contenteditable="false">Lens</span>',
  audioText: "<strong>spoken</strong> line",
  imageRef: null,
  updatedAt: "",
  updatedBy: null
});

const SOURCE_JSON = JSON.stringify(SOURCE);

const EXPORT = buildPublishHtml(SOURCE_JSON);

const SHELL_HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>';

const SHELL_TAIL = "</body></html>";

const STATE_SCRIPT = '<script id="state-data" type="application/json">\n' + SOURCE_JSON.replace(/<\//g, "<\\/") + "\n</script>";

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

function unboundedState(markup) {
  const doc = new window.DOMParser().parseFromString(markup, "text/html");
  return JSON.parse(JSON.stringify(migrateDocument(JSON.parse(doc.getElementById("state-data").textContent), { kind: "file" })));
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
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(parsed.state))), JSON.stringify(unboundedState(markup)), "the opened state equals an unbounded parse of the same file");
    assert.ok(elements < markup.length, "parsed " + elements + " elements and attributes from " + markup.length + " characters");
  });
}

test("an ordinary saved .html file opens to the source data, identical to an unbounded parse", async () => {
  const { parsed, elements } = await parsedWithCount(EXPORT);
  assert.ok(parsed && parsed.state, "the export opens");
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.state.title, SOURCE.title);
  assert.deepEqual(parsed.state.rows.map((row) => row.id), SOURCE.rows.map((row) => row.id));
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(parsed.state))), JSON.stringify(unboundedState(EXPORT)));
  const plain = new window.DOMParser().parseFromString(EXPORT, "text/html");
  assert.ok(elements <= weight(plain) + 2);
});

test("over the bound, the script data keeps its bold and italic (#501)", async () => {
  const markup = SHELL_HEAD + STATE_SCRIPT + SHAPES["distinct formatting tags then many paragraphs"]() + SHELL_TAIL;
  const { parsed } = await parsedWithCount(markup);
  const rich = parsed.state.rows.find((row) => row.id === "rich-row");
  assert.match(rich.visualText, /<strong>bold<\/strong> <em>italic<\/em>/);
  assert.match(rich.audioText, /<strong>spoken<\/strong>/);
});

test("the script data is read from the real script, not from a comment or another script's text", async () => {
  const decoy = JSON.stringify({ title: "Decoy", rows: [] });
  const markup = SHELL_HEAD +
    '<!-- <script id="state-data" type="application/json">' + decoy + "</script> -->" +
    '<script>var shell = \'<script id="state-data" type="application/json">' + decoy + "';</script>" +
    '<div title="<script id=state-data>">x</div>' +
    STATE_SCRIPT + SHELL_TAIL;
  const { parsed } = await parsedWithCount(markup);
  assert.equal(parsed.state.title, SOURCE.title);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(parsed.state))), JSON.stringify(unboundedState(markup)));
});

test("attributes in any order and quoting, and CRLF line ends, still find the script data", async () => {
  const markup = SHELL_HEAD + "<script type=application/json ID='state-data'>\r\n" + SOURCE_JSON.replace(/<\//g, "<\\/") + "\r\n</SCRIPT >" + SHELL_TAIL;
  const { parsed } = await parsedWithCount(markup);
  assert.equal(parsed.state.title, SOURCE.title);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(parsed.state))), JSON.stringify(unboundedState(markup)));
});

test("a file whose script data is not a document is refused as before", async () => {
  const markup = SHELL_HEAD + '<script id="state-data" type="application/json">[1, 2]</script>' + SHELL_TAIL;
  const parsed = await parseProjectFileState(file(markup));
  assert.deepEqual(parsed, { error: "not-splitpage" });
});
