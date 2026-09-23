/* Readers on the document model (#85, step 3 of docs/DOCUMENT-MODEL.md §10).
 *
 * doc-model.test.mjs proves the model's readers agree with the HTML readers
 * on CANONICAL HTML — toHtml's own output. The app's stored cells are not
 * canonical: they keep whatever nesting the browser and the sanitiser gave
 * them (<em><strong> as often as <strong><em>, a comment split around a
 * bold word, two <strong>s side by side). A reader only moves onto the
 * model if it gives what it gave before for THOSE cells, so every check
 * here runs over stored-shaped HTML (_stored-cells.mjs): the demo document,
 * hand-written non-canonical cells, and seeded random cells built the
 * way editing builds them — each run wrapped on its own, its marks in a
 * random order — then sanitised, as every cell is on blur and on load.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cellOf, toDocxRuns, toPlainText } from "../js/04c-doc-model.js";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { htmlToPlainText, htmlToRuns } from "../js/14-export.js";
import { prompterSceneHtml, trimPrompterCell } from "../js/20-teleprompter.js";
import { STORED } from "./_stored-cells.mjs";

test("plain text: the model reads every stored cell as htmlToPlainText does", () => {
  for (const html of STORED) assert.equal(toPlainText(cellOf(html)), htmlToPlainText(html), html);
});

test("plain text: where the model reads differently, by design (D7, §3)", () => {
  /* a video card has no place in a script cell: its label is not script */
  const card = sanitizeHtml('see <a class="video-embed-card" href="https://youtu.be/x">x</a>');
  assert.match(htmlToPlainText(card), /Watch video/);
  assert.equal(toPlainText(cellOf(card)), "see");
  /* a line feed inside a text node shows as a space (white-space: normal) */
  assert.equal(htmlToPlainText("a\nb"), "a\nb");
  assert.equal(toPlainText(cellOf("a\nb")), "a b");
  /* a zero-width space is a caret spot, never content */
  assert.equal(toPlainText(cellOf("a\u200Bb")), "ab");
});

/* Word and the PDF writer draw a run's text in its format; two neighbouring
   runs in the same format draw exactly as one. */
function coalesce(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    const same = last && r.text !== "\n" && last.text !== "\n" &&
      ["b", "i", "u", "s", "mark", "href"].every((k) => (last[k] || null) === (r[k] || null));
    if (same) last.text += r.text; else out.push(Object.assign({}, r));
  }
  return out;
}

test("docx/pdf runs: the same text in the same formats as htmlToRuns, for every stored cell", () => {
  let merged = 0;
  for (const html of STORED) {
    const before = htmlToRuns(html);
    const after = toDocxRuns(cellOf(html));
    /* the only difference: neighbours in one format that the stored HTML
       kept in separate elements (<strong>a</strong><strong>b</strong>)
       can come out as one run */
    assert.deepEqual(coalesce(after), coalesce(before), html);
    assert.ok(after.length <= before.length, html);
    if (after.length !== before.length) merged++;
  }
  assert.ok(merged > 0, "the random cells do exercise neighbouring same-format elements");
});

/* ---- the teleprompter ----

   What the prompter drew before it read the model: the stored HTML with
   its blank ends cut off by a regex, sanitised, and every text node split
   into <span class="w"> words. Kept here verbatim as the reference the
   model's rendering is compared with. */
function oldPrompterScene(html) {
  const trimmed = (html || "").replace(/^(\s|<br\s*\/?>)+|(\s|<br\s*\/?>)+$/g, "");
  if (!trimmed.trim()) return null;
  const body = inertBody(sanitizeHtml(trimmed));
  (function wrap(node) {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === 3) {
        const frag = document.createDocumentFragment();
        child.nodeValue.split(/(\s+)/).forEach((part) => {
          if (part === "") return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          const span = document.createElement("span");
          span.className = "w";
          span.textContent = part;
          frag.appendChild(span);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1 && child.tagName !== "BR") {
        wrap(child);
      }
    });
  })(body);
  return body.innerHTML;
}

function newPrompterScene(html) {
  const cell = trimPrompterCell(cellOf(html));
  return cell.length ? prompterSceneHtml(cell).html : null;
}

/* What a scene LOOKS like, independent of how its elements nest: each word
   with everything that styles it (the elements around it, by what they
   are, sorted), the space and line breaks between words, in order. Two
   words in a row with no space between and the same styling read as one
   ("a" "b" from <strong>a</strong><strong>b</strong>). Leading and trailing
   space and line breaks are left out: CSS collapses the space, and the
   breaks are the trim, compared on its own below. */
function looks(html) {
  if (html === null) return [];
  const body = inertBody(html);
  const out = [];
  function ctx(el) {
    const c = [];
    for (let e = el.parentNode; e && e !== body; e = e.parentNode) {
      if (e.classList.contains("tag-anchor")) c.push("tag:" + e.getAttribute("data-tag-cat") + ":" + e.getAttribute("data-tag-name"));
      else if (e.classList.contains("cmt-anchor")) c.push("cmt:" + e.getAttribute("data-cmt"));
      else if (e.classList.contains("broll-key")) c.push("broll:" + e.getAttribute("data-broll-id"));
      else if (e.tagName === "A") c.push("a:" + e.getAttribute("href"));
      else c.push(e.tagName);
    }
    return c.sort().join(",");
  }
  (function walk(node) {
    Array.from(node.childNodes).forEach((n) => {
      if (n.nodeType === 3) { out.push({ gap: n.nodeValue.replace(/\s+/g, " ") }); return; }
      if (n.tagName === "BR") { out.push({ gap: "\n" }); return; }
      if (n.classList.contains("w")) {
        const last = out[out.length - 1];
        const w = { word: n.textContent, ctx: ctx(n) };
        if (last && last.word !== undefined && last.ctx === w.ctx) last.word += w.word;
        else out.push(w);
        return;
      }
      walk(n);
    });
  })(body);
  /* neighbouring gaps are one gap; blank ends go */
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (t.gap !== undefined && last && last.gap !== undefined) last.gap = (last.gap + t.gap).replace(/ +/g, " ");
    else merged.push(t);
  }
  while (merged.length && merged[0].gap !== undefined) merged.shift();
  while (merged.length && merged[merged.length - 1].gap !== undefined) merged.pop();
  return merged;
}

const wordCount = (html) => (html === null ? 0 : inertBody(html).querySelectorAll(".w").length);

test("teleprompter: every stored scene looks as it did, word for word and style for style", () => {
  let joined = 0;
  for (const html of STORED) {
    const before = oldPrompterScene(html), after = newPrompterScene(html);
    assert.deepEqual(looks(after), looks(before), html);
    assert.ok(wordCount(after) <= wordCount(before), html);
    if (wordCount(after) < wordCount(before)) joined++;
    /* the count scene mode steps by is the spans on screen */
    if (after !== null) assert.equal(prompterSceneHtml(trimPrompterCell(cellOf(html))).words, wordCount(after));
  }
  assert.ok(joined > 0, "the random cells do exercise a word split between two same-format elements");
});

test("teleprompter: where the model draws differently", () => {
  /* a word the markup kept in two bold elements is one word to follow */
  assert.equal(newPrompterScene("<strong>bo</strong><strong>ld</strong>"),
    '<strong><span class="w">bold</span></strong>');
  /* a word half in bold is still two, as it always was */
  assert.equal(wordCount(newPrompterScene("<strong>bo</strong>ld")), 2);
  /* a line break at the very start is trimmed wherever it sits, not only
     outside the formatting */
  assert.equal(newPrompterScene("<strong><br>x</strong>"), '<strong><span class="w">x</span></strong>');
  assert.equal(oldPrompterScene("<strong><br>x</strong>"), '<strong><br><span class="w">x</span></strong>');
  /* markup with no words in it is no paragraph at all */
  assert.equal(newPrompterScene("<strong></strong>"), null);
  /* a no-break space is kept, as the regex over "&nbsp;" kept it */
  assert.equal(newPrompterScene("&nbsp;x"), '&nbsp;<span class="w">x</span>');
});
