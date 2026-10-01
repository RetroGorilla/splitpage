import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cellOf, toDocxRuns, toMarkdown, toPlainText } from "../js/04c-doc-model.js";
import { htmlToMarkdown, inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { tagsInField } from "../js/07-production-tags.js";
import { htmlToPlainText, htmlToRuns } from "../js/14-export.js";
import { prompterSceneHtml, trimPrompterCell } from "../js/20-teleprompter.js";
import { STORED, tagSpan } from "./_stored-cells.mjs";

test("plain text: the model reads every stored cell as htmlToPlainText does", () => {
  for (const html of STORED) assert.equal(toPlainText(cellOf(html)), htmlToPlainText(html), html);
});

test("plain text: where the model reads differently, by design (D7, §3)", () => {
  const card = sanitizeHtml('see <a class="video-embed-card" href="https://youtu.be/x">x</a>');
  assert.match(htmlToPlainText(card), /Watch video/);
  assert.equal(toPlainText(cellOf(card)), "see");
  assert.equal(htmlToPlainText("a\nb"), "a\nb");
  assert.equal(toPlainText(cellOf("a\nb")), "a b");
  assert.equal(toPlainText(cellOf("a\u200Bb")), "ab");
});

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
    assert.deepEqual(coalesce(after), coalesce(before), html);
    assert.ok(after.length <= before.length, html);
    if (after.length !== before.length) merged++;
  }
  assert.ok(merged > 0, "the random cells do exercise neighbouring same-format elements");
});

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
    if (after !== null) assert.equal(prompterSceneHtml(trimPrompterCell(cellOf(html))).words, wordCount(after));
  }
  assert.ok(joined > 0, "the random cells do exercise a word split between two same-format elements");
});

test("teleprompter: where the model draws differently", () => {
  assert.equal(newPrompterScene("<strong>bo</strong><strong>ld</strong>"),
    '<strong><span class="w">bold</span></strong>');
  assert.equal(wordCount(newPrompterScene("<strong>bo</strong>ld")), 2);
  assert.equal(newPrompterScene("<strong><br>x</strong>"), '<strong><span class="w">x</span></strong>');
  assert.equal(oldPrompterScene("<strong><br>x</strong>"), '<strong><br><span class="w">x</span></strong>');
  assert.equal(newPrompterScene("<strong></strong>"), null);
  assert.equal(newPrompterScene("&nbsp;x"), '&nbsp;<span class="w">x</span>');
});

const MD_MARKUP = /<\/?(?:strong|em|s|u|mark)>|\]\((?:https?|mailto):[^)\s]*\)|\*|~~|\[/g;
const words = (s) => s.replace(/\\([[\]()])/g, "\uE000$1").replace(MD_MARKUP, "").replace(/\uE000/g, "").replace(/[\s\u00a0]/g, "");

test("markdown: every stored cell says the same words as the HTML reader wrote", () => {
  let changed = 0;
  for (const html of STORED) {
    const before = htmlToMarkdown(html), after = toMarkdown(cellOf(html));
    assert.equal(words(after), words(before), html);
    assert.equal(words(after), toPlainText(cellOf(html)).replace(/[\s\u00a0]/g, ""), html);
    if (after !== before) changed++;
  }
  assert.ok(changed > 0, "the random cells do exercise what the HTML walker wrote wrong");
});

test("markdown: a cell htmlToMarkdown wrote without a flaw is written the same", () => {
  for (const html of [
    "plain words", "<strong>bold</strong> and <em>italic</em>", "a <strong><em>both</em></strong> b",
    "<em>x <strong>y</strong></em> z", "line one<br>line two", '<a href="https://e.x/">a <strong>link</strong></a>',
    "the " + tagSpan("prop", "Mug", "mug")
  ]) {
    const clean = sanitizeHtml(html);
    assert.equal(toMarkdown(cellOf(clean)), htmlToMarkdown(clean), html);
  }
});

test("markdown: a link with no href writes its text alone, on both paths (#281)", () => {
  for (const [html, md] of [
    ["see <a>this</a> here", "see this here"],
    ['see <a href="">this</a> here', "see this here"],
    ["<a><strong>bold</strong> (aside)</a>", "**bold** (aside)"]
  ]) {
    assert.equal(htmlToMarkdown(html), md, html);
    assert.equal(toMarkdown(cellOf(html)), md, html);
  }
  assert.equal(htmlToMarkdown('<a href="https://e.x/">li]nk</a>'), "[li\\]nk](https://e.x/)", "a link with an href is unchanged");
});

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const HREFLESS = ["<a>", '<a href="">', '<a target="_blank">'];
function hreflessCase(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const words = ["see", "a (b)", "x]y", "[z", "**", "tail ", " ", "é", "&amp;", "\"q\""];
  function frag(depth, inLink) {
    let html = "", bare = "";
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const k = r();
      if (depth > 2 || k < 0.35) { const w = pick(words); html += w; bare += w; continue; }
      if (k < 0.45) { html += "<br>"; bare += "<br>"; continue; }
      const inner = frag(depth + 1, inLink || k >= 0.75);
      if (k < 0.75) {
        const t = pick(["strong", "em", "s", "u", "mark"]);
        html += "<" + t + ">" + inner.html + "</" + t + ">";
        bare += "<" + t + ">" + inner.bare + "</" + t + ">";
      } else if (inLink) {
        html += inner.html; bare += inner.bare;
      } else if (k < 0.85) {
        html += '<a href="https://e.x/' + i + '">' + inner.html + "</a>";
        bare += '<a href="https://e.x/' + i + '">' + inner.bare + "</a>";
      } else {
        html += pick(HREFLESS) + inner.html + "</a>";
        bare += inner.bare;
      }
    }
    return { html, bare };
  }
  return frag(0, false);
}

test("markdown, seeded: a link with no href writes what its contents alone write, on both paths (#281)", () => {
  const r = seeded(281);
  let hrefless = 0;
  for (let i = 0; i < 600; i++) {
    const { html, bare } = hreflessCase(r);
    if (html !== bare) hrefless++;
    const label = JSON.stringify(html);
    assert.equal(htmlToMarkdown(html), htmlToMarkdown(bare), label);
    assert.equal(toMarkdown(cellOf(html)), toMarkdown(cellOf(bare)), label);
    assert.ok(!/\]\((?:null)?\)/.test(htmlToMarkdown(html)), label);
  }
  assert.ok(hrefless > 200, "the generator does make links with no href: " + hrefless);
});

function oldTagsInField(html) {
  return [...inertBody(html).querySelectorAll(".tag-anchor")].map((el) => ({
    catId: el.getAttribute("data-tag-cat"),
    name: (el.getAttribute("data-tag-name") || "").trim(),
    text: (el.textContent || "").trim()
  })).filter((t) => t.catId && t.name);
}

test("production index: every stored cell has the mentions the span reader found", () => {
  let tagged = 0;
  for (const html of STORED) {
    const before = oldTagsInField(html), after = tagsInField(html);
    assert.deepEqual(after.map((t) => [t.catId, t.name]), before.map((t) => [t.catId, t.name]), html);
    assert.deepEqual(after.map((t) => t.text.replace(/\s+/g, "")), before.map((t) => t.text.replace(/\s+/g, "")), html);
    if (after.length) tagged++;
  }
  assert.ok(tagged > 100, "enough tagged cells: " + tagged);
});
