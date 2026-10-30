import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToRuns } from "../../../src/adapters/formats/html-runs.ts";

const { document } = globalThis;

const body = (html) => {
  const el = document.createElement("div");
  el.innerHTML = String(html);
  return el;
};
const runs = (html) => htmlToRuns(html, body);
const FLAGS = { b: false, i: false, u: false, s: false, mark: false, href: null };
const flags = (over) => Object.assign({}, FLAGS, over);

test("plain text is one run with no formatting", () => {
  assert.deepEqual(runs("hello"), [{ text: "hello", ...FLAGS }]);
  assert.deepEqual(runs(""), []);
});

test("each format tag sets its own flag on the text inside", () => {
  const cases = [
    ["strong", { b: true }], ["b", { b: true }],
    ["em", { i: true }], ["i", { i: true }],
    ["u", { u: true }],
    ["s", { s: true }], ["strike", { s: true }], ["del", { s: true }],
    ["mark", { mark: true }]
  ];
  for (const [tag, over] of cases) {
    assert.deepEqual(runs(`<${tag}>x</${tag}>`), [{ text: "x", ...flags(over) }], tag);
  }
});

test("a format reaches everything nested inside it, and only that", () => {
  const cases = [["strong", "b"], ["em", "i"], ["u", "u"], ["s", "s"], ["mark", "mark"]];
  for (const [tag, flag] of cases) {
    assert.deepEqual(runs(`a<${tag}>b<span>c</span><sup>d</sup></${tag}>e`), [
      { text: "a", ...FLAGS },
      { text: "b", ...flags({ [flag]: true }) },
      { text: "c", ...flags({ [flag]: true }) },
      { text: "d", ...flags({ [flag]: true }) },
      { text: "e", ...FLAGS }
    ], tag);
  }
});

test("formats stack", () => {
  assert.deepEqual(runs("<b><i><u><s><mark>x</mark></s></u></i></b>"), [
    { text: "x", ...flags({ b: true, i: true, u: true, s: true, mark: true }) }
  ]);
  assert.deepEqual(runs("<s><u>x</u></s>"), [{ text: "x", ...flags({ s: true, u: true }) }]);
  assert.deepEqual(runs("<b><b>x</b></b>"), [{ text: "x", ...flags({ b: true }) }]);
});

test("a break is its own run and carries no formatting", () => {
  assert.deepEqual(runs("a<br>b"), [{ text: "a", ...FLAGS }, { text: "\n" }, { text: "b", ...FLAGS }]);
  assert.deepEqual(runs("<b>a<br>b</b>"), [{ text: "a", ...flags({ b: true }) }, { text: "\n" }, { text: "b", ...flags({ b: true }) }]);
});

test("non-breaking spaces become spaces, every one of them", () => {
  assert.deepEqual(runs("a&nbsp;b&nbsp;c"), [{ text: "a b c", ...FLAGS }]);
});

test("a link's address is kept on its text and inherited by what is inside it", () => {
  assert.deepEqual(runs('<a href="https://x.test/">link</a>'), [{ text: "link", ...flags({ href: "https://x.test/" }) }]);
  assert.deepEqual(runs('<a href="u"><b>bold</b> plain</a>'), [
    { text: "bold", ...flags({ b: true, href: "u" }) },
    { text: " plain", ...flags({ href: "u" }) }
  ]);
  assert.deepEqual(runs('<a href="u">x</a> y'), [{ text: "x", ...flags({ href: "u" }) }, { text: " y", ...FLAGS }]);
});

test("an anchor with no address has none, and does not drop the one it sits in", () => {
  assert.deepEqual(runs("<a>x</a>"), [{ text: "x", ...FLAGS }]);
  assert.deepEqual(runs('<a href="">x</a>'), [{ text: "x", ...FLAGS }]);
  const nested = () => {
    const outer = document.createElement("a");
    outer.setAttribute("href", "outer");
    const inner = document.createElement("a");
    inner.appendChild(document.createTextNode("x"));
    outer.appendChild(inner);
    const root = document.createElement("div");
    root.appendChild(outer);
    return root;
  };
  assert.deepEqual(htmlToRuns("", nested), [{ text: "x", ...flags({ href: "outer" }) }]);
});

test("an href on a tag that is not a link is ignored", () => {
  assert.deepEqual(runs('<span href="u">x</span>'), [{ text: "x", ...FLAGS }]);
});

test("an empty text node makes no run", () => {
  const root = () => {
    const el = document.createElement("div");
    el.appendChild(document.createTextNode(""));
    el.appendChild(document.createTextNode("x"));
    el.appendChild(document.createTextNode(""));
    return el;
  };
  assert.deepEqual(htmlToRuns("", root), [{ text: "x", ...FLAGS }]);
});

test("the body is built from the markup given", () => {
  const seen = [];
  htmlToRuns("<b>x</b>", (html) => { seen.push(html); return body(html); });
  assert.deepEqual(seen, ["<b>x</b>"]);
});
