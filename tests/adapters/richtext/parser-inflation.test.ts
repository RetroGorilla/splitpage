import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedMarkup } from "../../../src/adapters/richtext/parse-bound.ts";
import { adapterWith, fakePorts } from "./fakes.ts";
import { jsdomParser } from "./jsdom.mjs";

const rt = adapterWith(fakePorts());
const Parser: new () => DOMParser = jsdomParser();

function rawBody(html: string): HTMLElement {
  return new Parser().parseFromString("<!doctype html><body>" + html, "text/html").body;
}

function parsedSize(root: Node): number {
  let size = 0;
  const stack: Node[] = [root];
  while (stack.length) {
    (stack.pop() as Node).childNodes.forEach((child) => {
      if (child.nodeType !== 1) { size += (child as CharacterData).data.length; return; }
      const el = child as Element;
      size += 2 * el.localName.length + 5;
      Array.from(el.attributes).forEach((a) => { size += a.name.length + a.value.length + 4; });
      stack.push(el);
    });
  }
  return size;
}

function words(html: string): string {
  return (rawBody(html).textContent ?? "").replace(/\s+/g, "");
}

function count(html: string, pattern: RegExp): number {
  return Array.from(html.matchAll(pattern)).length;
}

function distinctBold(count: number): string {
  return Array.from({ length: count }, (_, i) => "<b id=" + String(i) + ">").join("");
}

const REOPENED = "<p>" + distinctBold(100) + "<p>x".repeat(1000);

test("a paste the parser reopens bold in, paragraph after paragraph, stays within 14 code units per input code unit plus 4096 and keeps every word (#420)", () => {
  const once = rt.sanitize(REOPENED);
  assert.ok(once.length <= 14 * REOPENED.length + 4096, String(once.length) + " from " + String(REOPENED.length));
  assert.equal(once.replace(/<[^>]*>/g, ""), "x".repeat(1000));
  assert.equal(count(once, /<br>/g), 1001);
  assert.equal(rt.sanitize(once), once);
});

test("the parsed paste is at most 8 code units per input code unit plus 4096, so whatever reads it next is bounded too (#420)", () => {
  const shapes: readonly (readonly [string, string])[] = [
    [REOPENED, "x".repeat(1000)],
    ['<p><a href="https://x.test/' + "h".repeat(2000) + '">x' + "<p>y".repeat(500), "x" + "y".repeat(500)],
    ['<p><b title="' + "t".repeat(2000) + '">x' + "<p>y".repeat(500), "x" + "y".repeat(500)],
    ["<p>" + "<b><i><u><s>".repeat(3) + "<p>x".repeat(2000), "x".repeat(2000)]
  ];
  for (const [html, text] of shapes) {
    const body = rt.inertBody(html);
    assert.ok(parsedSize(body) <= 8 * html.length + 4096, String(parsedSize(body)) + " from " + String(html.length));
    assert.ok(body.innerHTML.length <= 8 * html.length + 4096, String(body.innerHTML.length) + " from " + String(html.length));
    assert.equal(words(body.innerHTML), text);
  }
});

test("a long link the parser reopens in every paragraph keeps its words and a line break per paragraph (#420)", () => {
  const html = '<p><a href="https://x.test/' + "h".repeat(2000) + '">x' + "<p>y".repeat(500);
  const once = rt.sanitize(html);
  assert.ok(once.length <= 14 * html.length + 4096, String(once.length));
  assert.equal(once, "x<br>" + "y<br>".repeat(500));
});

test("formatting reopened across a few paragraphs is kept in each of them, as before (#420)", () => {
  assert.equal(rt.sanitize("<b>one<p>two<p>three</b>"), "<strong>onetwo<br></strong><strong>three</strong><br>");
  assert.equal(rt.sanitize("<p><i>a<p>b<p>c"), "<em>a</em><br><em>b</em><br><em>c</em><br>");
});

function tagsIn(html: string): number {
  return html.split("<").length - 1;
}

function onReopenEdge(entries: number, body: (lines: number) => string, short: number): string {
  for (let lines = 0; lines < 4000; lines++) {
    const html = body(lines);
    const bound = entries * 2 * (tagsIn(html) + 1);
    if ((bound - 4096) % 8 !== 0) continue;
    const pad = (bound - 4096) / 8 - html.length - short;
    if (pad >= 0) return "w".repeat(pad) + html;
  }
  throw new Error("no shape lands on the edge");
}

function closed(open: string, name: string): string {
  return open + "t</" + name + ">";
}

function tierOne(lines: number): string {
  return [
    Array.from({ length: 40 }, (_, i) => closed("<b id=" + String(i) + ">", "b")).join(""),
    closed("<b>", "b").repeat(4),
    Array.from({ length: 3 }, (_, i) => closed('<a href="https://l.test/' + String(i) + '">', "a")).join(""),
    Array.from({ length: 4 }, (_, i) => closed('<b title="a>' + String(i) + '">', "b")).join(""),
    closed("<i x<y>", "i").repeat(4),
    "<br>".repeat(lines)
  ].join("");
}

test("formatting tags are parsed as written while their reopen bound is at most 8 per input code unit plus 4096, and lose the attributes the sanitiser never reads one code unit shorter (#420)", () => {
  const at = onReopenEdge(52, tierOne, 0);
  const kept = rt.inertBody(at);
  assert.equal(kept.querySelectorAll("b[id]").length, 40);
  assert.equal(kept.querySelectorAll("b[title]").length, 4);
  assert.equal(kept.querySelectorAll("i").length, 4);
  const short = onReopenEdge(52, tierOne, 1);
  const plain = rt.inertBody(short);
  assert.equal(plain.querySelectorAll("b[id], b[title]").length, 0);
  assert.equal(plain.querySelectorAll("b").length, 44);
  assert.equal(plain.querySelectorAll("i").length, 0);
  assert.equal(count(rt.sanitize(short), /<strong>t<\/strong>/g), 44);
  assert.equal(words(rt.sanitize(short)), words(short));
});

function tierTwo(lines: number): string {
  return [
    Array.from({ length: 30 }, (_, i) => closed('<b style="color:#' + String(100 + i) + '">', "b")).join(""),
    Array.from({ length: 60 }, (_, i) => closed("<i id=" + String(i) + ">", "i")).join(""),
    Array.from({ length: 4 }, (_, i) => closed("<code class=c" + String(i) + ">", "code")).join(""),
    Array.from({ length: 2 }, (_, i) => closed('<a href="https://l.test/' + String(i) + '">', "a")).join(""),
    "<br>".repeat(lines)
  ].join("");
}

test("past the bound, formatting is kept while the tags without unread attributes fit it, and dropped, keeping every word, one code unit shorter (#420)", () => {
  const at = rt.sanitize(onReopenEdge(34, tierTwo, 0));
  assert.equal(count(at, /<em>t<\/em>/g), 60);
  assert.equal(count(at, /<strong>t<\/strong>/g), 30);
  const shortHtml = onReopenEdge(34, tierTwo, 1);
  const short = rt.sanitize(shortHtml);
  assert.equal(count(short, /<em>|<strong>/g), 0);
  assert.equal(count(short, /<a /g), 2);
  assert.equal(words(short), words(shortHtml));
});

test("a bold tag that cancels its weight still does once its other attributes are dropped (#420)", () => {
  const trip = Array.from({ length: 300 }, (_, i) => "<i id=" + String(i) + ">t</i>").join("") + "<br>".repeat(300);
  for (const cancel of ['<b style="font-weight:normal;" id="docs-internal-guid-1">', "<STRONG class=y STYLE='font-weight: 400'>",
    "<b style=font-weight:300 style=font-weight:bold>"]) {
    const once = rt.sanitize(trip + cancel + "plain</b></strong>");
    assert.match(once, /<\/em>(<br>)+plain$/);
  }
  assert.match(rt.sanitize(trip + '<b id=x style="font-weight:bold">heavy</b>'), /<strong>heavy<\/strong>$/);
});

function parsedEdge(over: number): string {
  const build = (pad: number, stretch: number): string =>
    "w".repeat(pad) + '<p><a href="https://x.test/' + "h".repeat(stretch) + '">x' + "<p>y".repeat(400);
  for (let stretch = 0; stretch < 64; stretch++) {
    const html = build(0, stretch);
    const gap = parsedSize(rawBody(html)) - 8 * html.length - 4096;
    if (gap >= 7 && gap % 7 === 0) return build(gap / 7 - over, stretch);
  }
  throw new Error("no shape lands on the edge");
}

test("a parse of exactly 8 code units per input code unit plus 4096 is kept, and one code unit shorter keeps only the words and line breaks (#420)", () => {
  const at = rt.sanitize(parsedEdge(0));
  assert.equal(count(at, /<a /g), 401);
  const short = rt.sanitize(parsedEdge(1));
  assert.equal(count(short, /<a /g), 0);
  assert.match(short, /^w+x<br>(y<br>){400}$/);
});

test("formatting the parser reopens inside a template counts towards the bound (#420)", () => {
  const html = '<img data-blob="' + "a".repeat(64) + '"><template><p><a href="https://x.test/' + "h".repeat(2000) + '">x' + "<p>y".repeat(500) + "</template>";
  assert.ok(rt.inertBody(html).innerHTML.length <= 8 * html.length + 4096);
  assert.ok(String(rt.storedHtmlFromDom(html)).length <= 8 * html.length + 4096);
});

const STYLE = 'style="color: rgb(32, 33, 34); font-family: sans-serif; font-weight: 400; background-color: rgb(255, 255, 255);"';

function article(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) => "<p " + STYLE + ">Paragraph " + String(i) + " has <b " + STYLE + ">bold</b>, <i>italic " +
    String(i % 7) + '</i>, <a href="https://en.example.org/wiki/T_' + String(i) + '" ' + STYLE + '>a link</a>, <code class="mw-code">code()</code>' +
    '<sup id="cite_ref-' + String(i) + '"><a href="#cite_note-' + String(i) + '">[' + String(i) + "]</a></sup>.</p>").join("");
}

test("an ordinary rich paste is parsed exactly as written (#420)", () => {
  const html = article(300);
  assert.equal(rt.inertBody(html).innerHTML, rawBody(html).innerHTML);
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES: readonly string[] = ["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"];
const BLOCKS: readonly string[] = ["<p>", "</p>", "<div>", "</div>", "<li>", "<h2>", "<button>", "<table><td>", "</td></table>", "<object>",
  "</object>", "<br>", "<hr>", "<ul>", "</ul>", "<blockquote>", "<tr>", "<caption>"];
const FLAT_BLOCKS: readonly string[] = ["<p>", "</p>", "<br>", "<hr>", "<li>", "<h2>", "</h2>", "<div>x</div>", "<p><table><td>x</table>"];
const WORDS: readonly string[] = ["x", " ", "&nbsp;", "w", "&amp;", "q"];
const OTHERS: readonly string[] = ["<!-- <b id=99> -->", "<template><p><i id=7>t<p>u</template>", "<svg><font color=red>s</font></svg>",
  '<span style="font-weight:bold">', "</span>", "</b>", "</i>", "</a>", "</strong>", "</font>", "</nobr>"];

export function inflating(seed: number, scale = 1): string {
  const rnd = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  let serial = 0;
  const styled = rnd() < 0.3;
  const formatting = (names: readonly string[]): string => {
    const name = pick(names);
    serial++;
    const attribute = styled && rnd() < 0.7 ? ' style="color:#' + String(serial) + '"' : pick(["", "", " id=" + String(serial), ' class="c' + String(serial % 4) + '"',
      ' style="font-weight:' + pick(["normal", "bold", "300", "700"]) + '"', ' style="color:#' + String(serial) + '"',
      ' title="a>' + String(serial) + '"', " x<y" + String(serial), " title='q\"" + String(serial % 3) + "'", " /",
      ' href="https://x.test/' + "h".repeat(Math.floor(rnd() * 400)) + '"']);
    return "<" + (rnd() < 0.2 ? name.toUpperCase() : name) + attribute + ">";
  };
  const any = (): string => {
    const r = rnd();
    return r < 0.3 ? formatting(NAMES) : r < 0.6 ? pick(BLOCKS) : r < 0.85 ? pick(WORDS) : pick(OTHERS);
  };
  const names = styled ? ["b", "strong"] : NAMES;
  const lead = Array.from({ length: Math.floor(rnd() * 30) }, any).join("");
  const opened = Array.from({ length: Math.floor(rnd() * 80 * scale) }, () => formatting(names)).join("");
  const unit = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (rnd() < 0.6 ? pick(FLAT_BLOCKS) : pick(WORDS))).join("") + pick(WORDS);
  return lead + opened + unit.repeat(1 + Math.floor(rnd() * 400 * scale));
}

function elementsIn(root: Node): number {
  let elements = 0;
  const stack: Node[] = [root];
  while (stack.length) {
    (stack.pop() as Node).childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      elements++;
      stack.push(child);
      const content = (child as Partial<HTMLTemplateElement>).content;
      if (content) stack.push(content);
    });
  }
  return elements;
}

const COUNT = Number(process.env["PARSER_INFLATION_FUZZ"] || 60);

test("seeded fuzz: pastes the parser would reopen formatting in stay within the parse and output bounds, keep every word and stay a fixed point (#420)", () => {
  const failures: string[] = [];
  for (let seed = 420000; seed < 420000 + COUNT; seed++) {
    const html = inflating(seed);
    const n = html.length;
    const body = rt.inertBody(html);
    const once = rt.sanitize(html);
    const parsed = elementsIn(rawBody(boundedMarkup(html)));
    let why: string | null = null;
    if (parsedSize(body) > 8 * n + 4096) why = "parsed " + String(parsedSize(body));
    else if (parsed > 8 * n + 4096 + 36 * (tagsIn(html) + 1)) why = String(parsed) + " elements";
    else if (rt.sanitize(once) !== once) why = "not a fixed point";
    else if (once.length > 56 * n + 28672) why = "output of " + String(once.length);
    else if (words(once) !== words(html)) why = "words changed";
    if (why) failures.push(String(seed) + " (" + String(n) + "): " + why);
  }
  assert.deepEqual(failures, []);
});
