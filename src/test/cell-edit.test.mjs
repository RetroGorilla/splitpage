import { domToPos } from "../features/common/cell-dom.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { posToDom } from "../features/common/cell-dom.ts";
import { cellLength, fromHtml, toHtml } from "../js/04c-doc-model.js";

const tag = (name, inner) => `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">${inner || name}</span>`;
const broll = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>';

function cellFrom(html) {
  const el = document.createElement("div");
  el.className = "cell-editable";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const FIXTURES = [
  "plain text",
  "one<br>two<br><br>",
  "a <strong>bold <em>both</em></strong> c",
  "pick the " + tag("Mug", "red mug") + " up",
  tag("Lamp") + " at the start",
  "end " + tag("Lamp"),
  "intro<br>" + broll + " drone shot",
  broll,
  '<span class="cmt-anchor" data-cmt="c1">quoted <mark>words</mark></span> after',
  "<div>para one</div><div><br></div><div>three</div>",
  "caret​spot​",
  ""
];

test("every model position survives the round trip through the DOM", () => {
  for (const html of FIXTURES) {
    const el = cellFrom(html);
    const n = cellLength(fromHtml(html));
    for (let pos = 0; pos <= n; pos++) {
      const pt = posToDom(el, pos);
      const back = domToPos(el, pt.node, pt.offset);
      const inTag = fromHtml(html).length && (() => {
        let p = 0;
        for (const r of fromHtml(html)) {
          const len = r.atom ? 1 : r.text.length;
          if (!r.atom && r.marks.tag && pos > p && pos < p + len) return [p, p + len];
          p += len;
        }
        return null;
      })();
      if (inTag) assert.ok(back === inTag[1] || back === inTag[0], JSON.stringify({ html, pos, back }));
      else assert.equal(back, pos, JSON.stringify({ html, pos }));
    }
    el.remove();
  }
});

test("a text point counts what the model counts", () => {
  const el = cellFrom("ab<strong>cd</strong><br>ef");
  const strongText = el.querySelector("strong").firstChild;
  assert.equal(domToPos(el, strongText, 1), 3);
  assert.equal(domToPos(el, el.lastChild, 2), 7);
  assert.equal(domToPos(el, el, 0), 0);
  assert.equal(domToPos(el, el, el.childNodes.length), 7);
  const br = el.querySelector("br");
  assert.equal(domToPos(el, el, Array.prototype.indexOf.call(el.childNodes, br)), 4);
  el.remove();
});

test("a b-roll key is one position; a point inside its letters is before or after it", () => {
  const el = cellFrom("x" + broll + "y");
  const keyText = el.querySelector(".broll-key").firstChild;
  assert.equal(domToPos(el, keyText, 0), 1);
  assert.equal(domToPos(el, keyText, 3), 2);
  assert.equal(cellLength(fromHtml(el.innerHTML)), 3);
  el.remove();
});

test("positions agree with the canonical HTML the model writes", () => {
  for (const html of FIXTURES) {
    const canon = toHtml(fromHtml(html));
    const a = cellFrom(html), b = cellFrom(canon);
    assert.equal(domToPos(a, a, a.childNodes.length), domToPos(b, b, b.childNodes.length), html);
    a.remove(); b.remove();
  }
});
