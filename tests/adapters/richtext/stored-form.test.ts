import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterWith, fakePorts } from "./fakes.ts";

const SHA = "c3".repeat(32);
const KEPT = `class="comment-img" data-blob="${SHA}" data-w="4" data-h="3" data-mime="image/png"`;
const STORED = `<img ${KEPT}>`;

const rt = adapterWith(fakePorts());

function attributeNames(html: string): string[] {
  return Array.from(rt.inertBody(html).querySelectorAll("*"), (el) => Array.from(el.attributes, (a) => a.name)).flat();
}

test("event handlers on a stored picture are dropped, however they are capitalised", () => {
  const handlers = [
    'onerror="alert(1)"', "ONLOAD='alert(2)'", "OnClick=alert(3)", 'oNmOuSeOvEr="x()"', 'onFocus=""', "onanimationstart=y",
    'ONPOINTERDOWN="z"', 'onBeforeToggle="t"'
  ];
  for (const h of handlers) {
    assert.equal(rt.storedHtmlFromDom(`<img ${h} ${KEPT}>`), STORED, h);
    assert.equal(rt.storedHtmlFromDom(`<img ${KEPT} ${h}>`), STORED, h);
  }
  const all = `a<img ${handlers.join(" ")} ${KEPT}>b`;
  assert.ok(attributeNames(all).some((n) => n.startsWith("on")));
  const out = rt.storedHtmlFromDom(all);
  assert.equal(out, "a" + STORED + "b");
  assert.deepEqual(attributeNames(out).filter((n) => n.startsWith("on")), []);
});

test("every attribute but the five a stored picture carries is dropped, and those keep their order and values", () => {
  const others = [
    'src="blob:https://splitpage.test/1"', 'src="javascript:alert(1)"', 'srcset="x.png 1x"', 'alt="Image unavailable"',
    'title="t"', 'style="background:url(x)"', 'width="4"', 'height="3"', 'id="i"', 'data-blob-state="missing"',
    'contenteditable="true"', 'draggable="true"', 'loading="lazy"', 'crossorigin="anonymous"', 'referrerpolicy="no-referrer"',
    'usemap="#m"', "ismap", 'tabindex="0"', 'name="n"', 'data-x="1"', 'xmlns="http://www.w3.org/1999/xhtml"'
  ];
  for (const o of others) {
    assert.equal(rt.storedHtmlFromDom(`<img ${o} ${KEPT}>`), STORED, o);
  }
  const reordered = `<img data-mime="image/png" alt="x" data-h="3" class="comment-img x" ONERROR="y" data-blob="${SHA}" data-w="4">`;
  assert.equal(rt.storedHtmlFromDom(reordered),
    `<img data-mime="image/png" data-h="3" class="comment-img x" data-blob="${SHA}" data-w="4">`);
});

test("each stored picture is cleaned wherever it sits, and nothing else is touched", () => {
  const html = `<span class="cmt-anchor" data-cmt="c1">x<img onerror="a" ${KEPT} alt="1"></span>` +
    `<strong><img src="blob:https://splitpage.test/2" ${KEPT} onload="b"></strong><img data-blob="${SHA}" onclick="c">`;
  assert.equal(rt.storedHtmlFromDom(html),
    `<span class="cmt-anchor" data-cmt="c1">x${STORED}</span><strong>${STORED}</strong><img data-blob="${SHA}">`);
});
