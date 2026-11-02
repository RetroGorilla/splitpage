import "./_dom.mjs";
import "./_copy-paste-mounted.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { cellFromClipboard } from "../features/clipboard/cell-clipboard.ts";
import { pasteIntoDraft } from "../features/editing/draft-edit.ts";
import { mountDraftEditFeature, stopDraftEditFeature } from "../bootstrap/wiring/draft-edit.ts";
import { fromHtml, sanitizeHtml } from "../bootstrap/richtext.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { toHtml } from "../core/text/html.ts";

before(mountDraftEditFeature);
after(stopDraftEditFeature);

const tracked = "https://example.com/story?keep=%2f+X&utm_source=news&fbclid=abc&gclid=def&mc_eid=e&mc_cid=c&msclkid=m&utm_medium=email&last=2#part";
const cleaned = "https://example.com/story?keep=%2f+X&last=2#part";
const link = (href) => '<a href="' + href.replaceAll("&", "&amp;") + '"><strong>Read this</strong></a>';

function pastedHref(href) {
  return cellFromClipboard(link(href), "Read this").cell[0].marks.href;
}

test("pasting a newsletter link removes only the approved tracking names", () => {
  assert.equal(pastedHref(tracked), cleaned);
  const cell = cellFromClipboard(link(tracked), "Read this").cell;
  assert.equal(cell[0].text, "Read this");
  assert.equal(cell[0].marks.b, true);
  assert.equal(sanitizeHtml(toHtml(cell)), toHtml(cell));
  assert.equal(toHtml(cellFromClipboard(toHtml(cell), "Read this").cell), toHtml(cell));
});

test("non-paste insertion retains tracking hrefs", () => {
  const cell = cellFromClipboard(link(tracked), "Read this", { cleanLinks: false }).cell;
  assert.equal(cell[0].marks.href, tracked);
});

test("pasting signed text links retains their complete query", () => {
  for (const name of ["Signature", "Key-Pair-Id", "Policy", "X-Amz-Signature", "X-Goog-Signature"]) {
    const href = "https://example.com/story?keep=1&utm_source=mail&" + name + "=example#part";
    assert.equal(pastedHref(href), href);
  }
});

test("dropping HTML into a draft retains tracking hrefs", () => {
  const box = document.createElement("div");
  box.className = "cell-editable";
  box.setAttribute("contenteditable", "true");
  document.body.append(box);
  const href = "https://example.com/story?keep=1&utm_source=mail";
  pasteIntoDraft(box, link(href), "Read this", false);
  assert.equal(box.querySelector("a").getAttribute("href"), href);
  box.remove();
});

test("pasting into a comment cleans the incoming link and keeps existing links", () => {
  const box = document.createElement("div");
  box.className = "cell-editable";
  box.setAttribute("contenteditable", "true");
  box.innerHTML = link(tracked);
  document.body.append(box);
  pasteIntoDraft(box, link(tracked), "Read this");
  assert.deepEqual(Array.from(box.querySelectorAll("a"), (a) => a.getAttribute("href")), [tracked, cleaned]);
  box.remove();
});

test("general sanitizing, decoding and document loading retain tracking links", () => {
  const html = sanitizeHtml(link(tracked));
  assert.equal(sanitizeHtml(html), html);
  assert.equal(fromHtml(html)[0].marks.href, tracked);
  const doc = migrateRows({ schema: 2, rows: [{ id: "r1", visualText: html, audioText: html }], comments: [{ id: "c1", body: html, replies: [] }] });
  assert.equal(doc.rows[0].visualText, html);
  assert.equal(doc.rows[0].audioText, html);
  assert.equal(doc.comments[0].body, html);
});

test("untracked links, redirect destinations, paths, values and fragments retain their bytes", () => {
  for (const href of [
    "HTTPS://EXAMPLE.COM:443/utm_path/%7e?b=%2f+X&a=1&a=2#utm_source=x",
    "https://example.com?next=https%3A%2F%2Fshop.example%2F%3Futm_source%3Dmail&ref=utm_source%3Dx",
    "https://example.com/?not_utm_source=x&fbclidx=1&gclid_extra=2&mc_eid_extra=3&msclkid_extra=4",
    "https://example.com/path?",
    "mailto:hello@example.com?utm_source=mail",
    "https://[invalid/?utm_source=x",
    "https://example.com/%ZZ?utm_source=x"
  ]) assert.equal(pastedHref(href), href, href);
});

test("a whole-block link stays linked and existing video extraction keeps its behavior", () => {
  const block = cellFromClipboard('<a href="' + tracked.replaceAll("&", "&amp;") + '"><p>First</p><p>Second</p></a>', "First\nSecond");
  assert.equal(block.cell.filter((run) => run.text.trim()).every((run) => run.marks.href === cleaned), true);
  assert.match(toHtml(block.cell), /First/);
  assert.match(toHtml(block.cell), /Second/);
  const video = "https://youtu.be/abc?utm_source=mail";
  const got = cellFromClipboard('<a href="' + video + '">' + video + '</a>', video);
  assert.deepEqual(got.attach, [{ kind: "video", href: video }]);
  assert.equal(got.cell.length, 0);
});
