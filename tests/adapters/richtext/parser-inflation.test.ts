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

test("a long link the parser reopens in every paragraph keeps its words and line breaks, as the paste would without the link (#420)", () => {
  const lead = "<p><br></p><div>d</div><p></p><div><p>e</p></div>";
  const html = lead + '<p><a href="https://x.test/' + "h".repeat(2000) + '">x' + "<p>y".repeat(500);
  const once = rt.sanitize(html);
  assert.ok(once.length <= 14 * html.length + 4096, String(once.length));
  assert.equal(once, rt.sanitize(lead + "<p>x" + "<p>y".repeat(500)));
  assert.equal(once, "<br>d<br><br>e<br><br>x<br>" + "y<br>".repeat(500));
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

const DELIMITERS: readonly string[] = [" ", "\t", "\n", "\f", "\r", "/"];

function quotedGreaterThan(i: number): string {
  const forms = ['<b title="a>#">', '<b title = "a>#">', "<b title='a>#'>", "<b title= 'a>#'>"];
  return (forms[Math.floor(i / 4)] as string).replace("#", String(i % 4));
}

function tierOne(lines: number): string {
  return [
    Array.from({ length: 42 }, (_, i) => closed("<" + (i % 7 ? "b" : "B") + (DELIMITERS[i % 6] as string) + "id=" + String(i) + ">", "b")).join(""),
    closed("<b>", "b").repeat(4),
    Array.from({ length: 3 }, (_, i) => closed('<a href="https://l.test/' + String(i) + '">', "a")).join(""),
    Array.from({ length: 16 }, (_, i) => closed(quotedGreaterThan(i), "b")).join(""),
    closed("<i x<y>", "i").repeat(4),
    "<br>".repeat(lines)
  ].join("");
}

test("formatting tags are parsed as written while their reopen bound, each entry weighed as 1 plus its attributes, is at most 8 per input code unit plus 4096, and lose the attributes the sanitiser never reads one code unit shorter (#420)", () => {
  const at = onReopenEdge(127, tierOne, 0);
  const kept = rt.inertBody(at);
  assert.equal(kept.querySelectorAll("b[id]").length, 42);
  assert.equal(kept.querySelectorAll("b[title]").length, 16);
  assert.equal(kept.querySelectorAll("i[x\\<y]").length, 4);
  const short = onReopenEdge(127, tierOne, 1);
  const plain = rt.inertBody(short);
  assert.equal(plain.querySelectorAll("b[id], b[title], i[x\\<y]").length, 0);
  assert.equal(plain.querySelectorAll("b").length, 62);
  assert.equal(plain.querySelectorAll("i").length, 4);
  assert.equal(count(rt.sanitize(short), /<strong>t<\/strong>/g), 62);
  assert.equal(words(rt.sanitize(short)), words(short));
});

function tierTwo(lines: number): string {
  return [
    Array.from({ length: 30 }, (_, i) => closed('<b style="font-family:f' + String(100 + i) + '">', "b")).join(""),
    Array.from({ length: 60 }, (_, i) => closed("<i id=" + String(i) + ">", "i")).join(""),
    Array.from({ length: 4 }, (_, i) => closed("<code class=c" + String(i) + ">", "code")).join(""),
    Array.from({ length: 2 }, (_, i) => closed('<a href="https://l.test/' + String(i) + '">', "a")).join(""),
    "<!-- <b id=c> -->",
    "<br>".repeat(lines)
  ].join("");
}

test("past the bound, formatting is kept while the tags without unread attributes fit it, and dropped, keeping every word, one code unit shorter (#420)", () => {
  const atHtml = onReopenEdge(67, tierTwo, 0);
  const at = rt.sanitize(atHtml);
  assert.equal(count(at, /<em>t<\/em>/g), 60);
  assert.equal(count(at, /<strong>t<\/strong>/g), 30);
  const unkept = Array.from(rt.inertBody(atHtml).querySelectorAll("code-"));
  assert.deepEqual(unkept.map((el) => el.textContent), ["t", "t", "t", "t"]);
  const shortHtml = onReopenEdge(67, tierTwo, 1);
  assert.ok(boundedMarkup(shortHtml).includes("<!-- <b id=c> -->"));
  const short = rt.sanitize(shortHtml);
  assert.equal(count(short, /<em>|<strong>/g), 0);
  assert.equal(count(short, /<a /g), 2);
  assert.equal(words(short), words(shortHtml));
  const dropped = Array.from(rt.inertBody(shortHtml).querySelectorAll("b-, i-, code-"));
  assert.equal(dropped.length, 94);
  assert.ok(dropped.every((el) => el.textContent === "t"));
});

test("a bold tag that cancels its weight still does once its other attributes are dropped (#420)", () => {
  const trip = Array.from({ length: 300 }, (_, i) => "<i id=" + String(i) + ">t</i>").join("") + "<br>".repeat(300);
  for (const cancel of ['<b style="font-weight:normal;" id="docs-internal-guid-1">', "<STRONG class=y STYLE='font-weight: 400'>",
    "<b style=font-weight:normal style=font-weight:bold>"]) {
    const once = rt.sanitize(trip + cancel + "plain</b></strong>");
    assert.match(once, /<\/em>(<br>)+plain$/);
  }
  assert.match(rt.sanitize(trip + '<b id=x style="font-weight:bold">heavy</b>'), /<strong>heavy<\/strong>$/);
});

function parsedEdge(over: number): string {
  const build = (pad: number, stretch: number): string =>
    "<!--" + "w".repeat(pad) + '--><p><a href="https://x.test/' + "h".repeat(stretch) + '">x' + "<p>y".repeat(400);
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
  assert.equal(short, "x<br>" + "y<br>".repeat(400));
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
  '<span style="font-weight:bold">', "</span>", "</b>", "</i>", "</a>", "</strong>", "</font>", "</nobr>", '<span title="<b q">w</span>',
  "<textarea><b id=5>t</textarea>", "<!-- <a x y z> -->", "<script><!--<script></script><i id=6>--></script>"];

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
      manyAttributes(Math.floor(rnd() * 60)), ' style="color:#' + String(serial) + ';font-weight:' + pick(["300", "700"]) + '"',
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
    const bounded = rawBody(boundedMarkup(html));
    const parsed = elementsIn(bounded);
    const copies = attributeCopies(bounded);
    let why: string | null = null;
    if (parsedSize(body) > 8 * n + 4096) why = "parsed " + String(parsedSize(body));
    else if (parsed > 8 * n + 4096 + (tagsIn(html) + 1)) why = String(parsed) + " elements";
    else if (copies > 9 * n + 4096) why = String(copies) + " attributes";
    else if (rt.sanitize(once) !== once) why = "not a fixed point";
    else if (once.length > 56 * n + 28672) why = "output of " + String(once.length);
    else if (words(once) !== words(html)) why = "words changed";
    if (why) failures.push(String(seed) + " (" + String(n) + "): " + why);
  }
  assert.deepEqual(failures, []);
});

function attributeCopies(root: Node): number {
  let attributes = 0;
  const stack: Node[] = [root];
  while (stack.length) {
    (stack.pop() as Node).childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      attributes += (child as Element).attributes.length;
      stack.push(child);
      const content = (child as Partial<HTMLTemplateElement>).content;
      if (content) stack.push(content);
    });
  }
  return attributes;
}

function manyAttributes(count: number): string {
  return Array.from({ length: count }, (_, i) => " a" + i.toString(36)).join("");
}

test("a reopened tag with many attributes is reopened without them, so the parser copies at most 8 attributes per input code unit plus 4096 (#420)", () => {
  const extra = manyAttributes(400);
  const shapes: readonly (readonly [string, string])[] = [
    ["<p><b" + extra + ">", "<p><b>"],
    ['<p><b title="<>"' + extra + ">", '<p><b title="<>">'],
    ['<p><a href="https://x.test/"' + extra + ">", '<p><a href="https://x.test/">']
  ];
  const tail = "<p>x".repeat(400) + '<a href="https://y.test/">y</a>';
  for (const [open, plain] of shapes) {
    const html = open + tail;
    const copies = attributeCopies(rawBody(boundedMarkup(html)));
    assert.ok(copies <= 8 * html.length + 4096, String(copies) + " from " + String(html.length));
    assert.equal(rt.sanitize(html), rt.sanitize(plain + tail));
  }
});

test("a tag scan that would step through more than 8 code units per input code unit plus 4096 takes the first tier (#420)", () => {
  const shape = (inner: number): string => "<b/t=".repeat(9) + "x".repeat(inner) + ">";
  assert.equal(boundedMarkup(shape(4230)), shape(4230));
  assert.equal(boundedMarkup(shape(4231)), "<b>");
});

function strongLines(lines: number, family: string): string {
  return Array.from({ length: lines }, (_, i) => "<p>Line " + String(i) + ' has <strong style="' + family + "color: rgb(" + String(i % 256) + ", " +
    String(Math.floor(i / 256)) + ', 0);">a word</strong> in it.</p>').join("");
}

test("bold with a colour of its own on every line keeps its bold however many lines there are (#420)", () => {
  for (const [lines, family] of [[120, ""], [400, ""], [400, "font-family: &quot;Arial&quot;; "]] as const) {
    const html = strongLines(lines, family);
    assert.notEqual(boundedMarkup(html), html);
    assert.equal(count(rt.sanitize(html), /<strong>a word<\/strong>/g), lines);
  }
});

const TRIP = Array.from({ length: 300 }, (_, i) => "<i id=" + String(i) + ">t</i>").join("") + "<br>".repeat(300);

const WEIGHT_STYLES: readonly string[] = [
  'style="color: red; font-weight: 300"',
  'style="font-weight: 300; color: red"',
  'style="color: red"',
  "STYLE='COLOR: red; FONT-WEIGHT: 300'",
  'style="font: italic 300 12px serif; color: blue"',
  'style="font-family: &quot;a; font-weight: 300&quot;; color: red"',
  'style="color: &quot;a; font-weight: 300; b&quot;"',
  "style='color: \"a; font-weight: 300; b\"'",
  'style="font-family: &quot;Arial&quot;; font-weight: 300; color: red"',
  'style="background: url(a;font-weight:300;b); color: red"',
  'style="--x: (a]; font-weight: 300; b); color: red"',
  'style="--x: [a; font-weight: 300; b]; color: red"',
  'style="--x: {a; font-weight: 300; b}; color: red"',
  'style="color: red /* ; font-weight: 300; */"',
  'style="font-weight: 300; font-weight: bold; color: red"',
  'style="font-weight: 3&#48;0; color: red"',
  'style="font-weight: \\33 00; color: red"',
  'style="color: red; font-weight: 300" style="font-weight: bold"',
  "style=color:red;font-weight:900",
  'style="--w: 300; font-weight: var(--w); color: red"'
];

test("past the first bound, bold keeps from its style only what decides its weight, and cancels or not as it did (#420)", () => {
  for (const style of WEIGHT_STYLES) {
    for (const name of ["b", "strong"]) {
      const tag = "<" + name + " id=k " + style + ">w</" + name + ">";
      assert.notEqual(boundedMarkup(TRIP + tag), TRIP + tag);
      assert.equal(rt.sanitize(TRIP + tag), rt.sanitize(TRIP) + rt.sanitize(tag), tag);
    }
  }
});

test("past the first bound, a tag name inside an attribute value is left as written, so the words and the link after it are kept (#420)", () => {
  const tail = '<span title="<b q" class=x>Hello</span> world. <a href="https://x.test/">link</a> more "text"';
  assert.notEqual(boundedMarkup(TRIP + tail), TRIP + tail);
  assert.equal(rt.sanitize(TRIP + tail), rt.sanitize(TRIP) + rt.sanitize(tail));
});

test("past the first bound, a comment holding tags stays one comment (#420)", () => {
  const comment = '<!-- <b style=a-- x><img src=x onerror=alert(1)><a href="javascript:alert(1)">j</a> -->';
  const body = rt.inertBody(TRIP + comment + "after");
  assert.equal(body.querySelectorAll("img, a").length, 0);
  assert.equal(rt.sanitize(TRIP + comment + "after"), rt.sanitize(TRIP + "after"));
});

const INNER = '<b id=1 title="q>">x</b><a href=y z=1>l</a><font color=red>f</font></i>';

test("past the first bound, the text of a text box, a title, a style, a script, an xmp, an iframe, a noembed and a noframes is left as written, and the tags after it are rewritten (#420)", () => {
  const contents: readonly (readonly [string, string, string])[] = [
    ["textarea", INNER, ">"], ["title", INNER, ">"], ["style", INNER, ">"], ["script", INNER, ">"], ["xmp", INNER, ">"], ["iframe", INNER, ">"],
    ["noembed", INNER, ">"], ["noframes", INNER, ">"], ["script", "<!--<script></script>" + INNER + "-->", ">"],
    ["script", "<!--<script>-->" + INNER, ">"], ["script", "<!--<script></script>" + INNER, ">"], ["script", "<!--><script>" + INNER, ">"], ["script", "<!---><script>" + INNER, ">"],
    ["TEXTAREA", INNER + "</textareax>", ">"], ["textarea", "</title>" + INNER, ">"], ["textarea", INNER, "/>"], ["script", INNER, "/>"]
  ];
  for (const [name, text, close] of contents) {
    const html = "<" + name + ">" + text + "</" + name + close + TRIP;
    assert.notEqual(boundedMarkup(html), html);
    const body = rt.inertBody(html);
    assert.equal(body.querySelector(name)?.textContent, text, name + text);
    assert.equal(body.querySelectorAll("i").length, 300, name + text);
  }
  assert.equal(rt.inertBody(TRIP + "<plaintext>" + INNER).querySelector("plaintext")?.textContent, INNER);
});

test("past the first bound, a comment, a bogus comment and a doctype end where the parser ends them, and a tag cut off by the end of the paste stays dropped (#420)", () => {
  const before = ["<!---->", "<!-->", "<!--->", "<!-- <b id=1> --!>", "<!-- a --->", "<!-- a -- b -->", "<!-- a --> <!-- <b id=1> -->",
    "<!-- a --!> <!-- <b id=1> --!>", "<!x <b id=1>", "<?x <b id=1>", "</ <b id=1>", "</>", "<!DOCTYPE html PUBLIC \"a>b\">"];
  for (const lead of before) {
    const html = lead + TRIP;
    assert.equal(boundedMarkup(html), lead + boundedMarkup(TRIP), lead);
    assert.equal(rt.inertBody(html).querySelectorAll("i").length, 300, lead);
  }
  assert.notEqual(boundedMarkup(TRIP), TRIP);
  assert.equal(rt.sanitize(TRIP + "<b id=1 x"), rt.sanitize(TRIP));
});

test("past the first bound, bold keeps exactly the style declarations that can decide its weight, as written or re-quoted (#420)", () => {
  const reduced: readonly (readonly [string, string])[] = [
    ['<b id=k style="color: red; FONT-WEIGHT: 300">', '<b style=" FONT-WEIGHT: 300">'],
    ['<b style="color: red; all: initial" id=k>', '<b style=" all: initial">'],
    ['<strong id=k style="font-weight:\\33 00;color:red">', '<strong style="font-weight:\\33 00;color:red">'],
    ['<b id=k style="color: red">', "<b>"],
    ['<i id=k style="font-weight: 300">', "<i>"],
    ["<b id=k style=\"color: 'a\nb; font-weight: 300'\">", "<b style=\" font-weight: 300'\">"],
    ["<b id=k style=\"color: 'a; font-weight: 300; b'; x: y\">", "<b style=\"color: 'a; font-weight: 300; b'\">"],
    ['<b id=k style="font-family: &quot;A&amp;B&quot;; x: y">', '<b style="font-family: &quot;A&amp;B&quot;">'],
    ['<b id=k style="font-weight: &#x33;00; x: y">', '<b style="font-weight: &#x33;00; x: y">']
  ];
  for (const [tag, plain] of reduced) {
    assert.ok(boundedMarkup(TRIP + tag + "w").endsWith(plain + "w"), tag);
  }
});

test("where the tokenizer guesses raw text wrongly, the formatting it hid is renamed with its end tags and every word stays in place (#420)", () => {
  const hidden = Array.from({ length: 300 }, (_, i) => "<b id=" + String(i) + ">t</b>").join("");
  const html = TRIP + "<svg></math><style>" + hidden;
  const renamed = Array.from(rt.inertBody(html).querySelectorAll("b-"));
  assert.equal(renamed.length, 300);
  assert.ok(renamed.every((el) => el.textContent === "t"));
});

test("past the first bound, svg and math content is tokenized as markup, and raw text after a closed or self-closed svg is left as written (#420)", () => {
  for (const open of ["<svg>", "<math>"]) {
    const html = TRIP + open + "<style>" + Array.from({ length: 300 }, (_, i) => "<b id=" + String(i) + ">t</b>").join("");
    assert.equal(rt.inertBody(html).querySelectorAll("b").length, 300, open);
  }
  for (const open of ["<svg/>", "<svg></svg>", "<math></math>"]) {
    const html = TRIP + open + "<textarea>" + INNER + "</textarea>";
    assert.equal(rt.inertBody(html).querySelector("textarea")?.textContent, INNER, open);
  }
});

test("past the first bound, a link keeps its href and its class, so a video card stays a card (#420)", () => {
  const tail = '<a class="video-embed-card" data-x=1 href="https://youtu.be/abc" CLASS=no>v</a> and <a title=t HREF="https://x.test/" href="https://y.test/">l</a>';
  assert.notEqual(boundedMarkup(TRIP + tail), TRIP + tail);
  assert.ok(boundedMarkup(TRIP + tail).endsWith('<a class="video-embed-card" href="https://youtu.be/abc">v</a> and <a HREF="https://x.test/">l</a>'));
  assert.equal(rt.sanitize(TRIP + tail), rt.sanitize(TRIP) + rt.sanitize(tail));
});

test("formatting the tokenizer cannot see, inside comments and attribute values, is renamed only when it alone would pass the bound; links are kept (#420)", () => {
  const hidden = "<!--" + Array.from({ length: 300 }, (_, i) => "<b id=" + String(i) + manyAttributes(10) + "></b>").join("") +
    "<a id=x" + manyAttributes(400) + "></a>-->";
  const html = hidden + '<p><a href="https://x.test/<b q" title=t>x</a> <a href=u>y</a>' + "<p>z".repeat(400);
  const out = boundedMarkup(html);
  assert.ok(out.startsWith("<!--<b- id=0 a0 a1 a2 a3 a4 a5 a6 a7 a8 a9></b-><b- id=1"), out.slice(0, 40));
  assert.ok(out.includes("<a- id=x a0"), out.slice(hidden.length - 3000, hidden.length));
  assert.ok(out.includes('<a href="https://x.test/<b- q">x</a> <a href=u>y</a>'), out.slice(hidden.length, hidden.length + 120));
  assert.equal(rt.sanitize(html), rt.sanitize('<p><a href="https://x.test/<b- q">x</a> <a href=u>y</a>' + "<p>z".repeat(400)));
  const light = "<!--" + Array.from({ length: 10 }, (_, i) => "<b id=" + String(i) + ">").join("") + "-->" + TRIP;
  assert.ok(boundedMarkup(light).startsWith("<!--<b id=0><b id=1>"));
});

const COUNTED_NAMES: readonly string[] = ["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"];
const UNKEPT_NAMES: readonly string[] = ["big", "code", "font", "nobr", "small", "tt"];
const REOPENABLE_NAMES: readonly string[] = ["b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"];

function namedPaste(name: string): (lines: number) => string {
  const carrier = name === "a" ? "i" : name;
  return (lines) => Array.from({ length: 40 }, (_, i) => closed("<" + carrier + " id=" + String(i) + ">", carrier)).join("") +
    closed('<a href="https://l.test/">', "a") + "<br>".repeat(lines);
}

for (const name of COUNTED_NAMES) {
  test('each counted tag name, here "' + name + '", is counted by the first tier and, where the second tier renames it, is renamed (#420)', () => {
    const carrier = name === "a" ? "i" : name;
    const body = namedPaste(name);
    const at = onReopenEdge(82, body, 0);
    const short = onReopenEdge(82, body, 1);
    assert.equal(boundedMarkup(at), at);
    const first = boundedMarkup(short);
    const unkept = UNKEPT_NAMES.includes(name);
    assert.ok(first.includes(unkept ? "<" + carrier + "- id=0>" : "<" + carrier + ">"), first.slice(0, 120));
    if (unkept) assert.ok(first.includes("</" + carrier + "->"), first.slice(0, 120));
    if (REOPENABLE_NAMES.includes(name)) {
      const styled = Array.from({ length: 200 }, (_, i) => closed('<b style="font-family:f' + String(i) + '">', "b")).join("");
      const second = boundedMarkup(styled + closed("<" + name + " id=0>", name));
      assert.ok(second.includes("<" + name + "-"), second.slice(0, 120));
    }
  });
}
