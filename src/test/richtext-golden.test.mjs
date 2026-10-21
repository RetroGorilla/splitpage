import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoCardEl, htmlToMarkdown, sanitizeHtml, storedHtmlFromDom } from "../js/04-richtext.js";
import { fromHtml, toHtml } from "../js/04c-doc-model.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import { createIdMasker, goldenText, idsInHtml, image, mintedId, settleGolden } from "./golden-helpers.mjs";

const KNOWN = image("png", 7, 5);
const PNG = image("png", 71, 13);
const JPEG = image("jpeg", 9, 7);
const GIF = image("gif", 3, 2);
const WEBP = image("webp", 300, 200);
const JPG = image("jpeg", 10, 8);
const MISLABELED = image("png", 20, 10);
const WRAPPED = image("png", 33, 11);
const FALLBACK = image("gif", 4, 4);
const UNKNOWN = "a1".repeat(32);
const SVG = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");

const tag = (cat, name, inner) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;
const blob = (sha, attrs) => `<img data-blob="${sha}"${attrs || ""}>`;

const CORPUS = [
  ["null input", null],
  ["empty", ""],
  ["whitespace only", "   \n  \t "],
  ["plain text", "Hello world"],
  ["seed audio cell", 'On the left, what the viewer sees. On the right, <strong>exactly</strong> what gets said — <span class="cmt-anchor" data-cmt="c1"><mark>word for word</mark></span>, ready for the <u>teleprompter</u>. (This sentence shows off <a href="https://example.com" target="_blank" rel="noopener">a link</a>, too.)'],
  ["pasted style spans: weight",
    '<span style="font-weight: bold">bold</span> <span style="font-weight:700">w700</span> <span style="font-weight: 600">w600</span> ' +
    '<span style="font-weight: 500">w500</span> <span style="font-weight: normal">normal</span> <span style="font-weight: bolder">bolder</span>'],
  ["pasted style spans: italic, underline, strike",
    '<span style="font-style: italic">it</span> <span style="font-style: oblique">oblique</span> <span style="text-decoration: underline">u</span> ' +
    '<span style="text-decoration-line: line-through">s</span> <span style="text-decoration: underline line-through">us</span> <span style="text-decoration: overline">over</span>'],
  ["pasted style spans: highlight",
    '<span style="background-color: yellow">hl</span> <span style="background-color: transparent">transparent</span> ' +
    '<span style="background-color: rgba(0, 0, 0, 0)">clear</span> <span style="background: #ff0">shorthand</span> <span style="background-color: rgba(0,0,0,0.5)">half</span>'],
  ["pasted style spans: everything at once",
    '<span style="font-weight:bold;font-style:italic;text-decoration:underline line-through;background-color:#ff0">all</span>'],
  ["pasted style spans: nested",
    '<span style="font-weight:700">bold <span style="font-style:italic">and italic</span></span> <span>plain span</span> <span style="color:red;font-size:30px">colour only</span>'],
  ["b with normal weight",
    '<b style="font-weight: normal">normal</b> <b style="font-weight:400">w400</b> <b style="font-weight: 500">w500</b> <b style="font-weight: 599">w599</b> ' +
    '<b style="font-weight: 600">w600</b> <b style="font-weight: bolder">bolder</b> <strong style="font-weight: normal">strong normal</strong> <strong>strong</strong> <b>b</b>'],
  ["google docs paste",
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-weight:700">Bold</span>' +
    '<span style="font-size:11pt"> and </span><span style="font-style:italic">italic</span></p><br><p dir="ltr"><span>second para</span></p></b>'],
  ["word paste",
    '<p class="MsoNormal">Hello<o:p></o:p></p><!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]--><p class="MsoNormal"><span style="mso-bidi-font-weight:bold">x</span></p>'],
  ["empty blocks", "<div>one</div><div><br></div><div>three</div><p></p><p><br></p><p>five</p><div><br><br></div><div> </div>"],
  ["nested blocks", "<div><div>inner</div></div><p>a<br>b</p><div>x<p>y</p>z</div>"],
  ["formatting tags", "<strong>s</strong><b>b</b><em>e</em><i>i</i><u>u</u><s>s</s><strike>st</strike><del>d</del><mark>m</mark><sup>sup</sup><code>code</code><ins>ins</ins>"],
  ["nested formatting", "<b><i><u>biu</u></i></b> <em>x <strong>y</strong></em> z <mark><s>ms</s></mark>"],
  ["script, style and frames",
    '<script>alert(1)</script><style>p{color:red}</style><iframe src="https://evil.test"></iframe><img src=x onerror="alert(1)"><object data="x"></object>ok'],
  ["svg and math", '<svg><a href="https://e.x/">svg link</a><text>t</text></svg><math><mi>x</mi></math>after'],
  ["template and noscript", "<template><b>hidden</b></template><noscript><b>ns</b></noscript>end"],
  ["lists, tables, headings", "<h1>Title</h1><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><blockquote>q</blockquote><pre>pre\n  text</pre>"],
  ["tag anchor", "pick up the " + tag("prop", "Red mug", "red mug") + " now"],
  ["tag anchor: every category", ["prop", "location", "cast", "vfx", "sound", "gear"].map((c) => tag(c, c + " one", c)).join(" ")],
  ["tag anchor: invalid category",
    tag("weapon", "Sword", "sword") + " " + tag("Prop", "Mug", "mug") + " " + tag("", "Empty", "empty") + ' <span class="tag-anchor" data-tag-name="No cat">no cat</span>'],
  ["tag anchor: missing or blank name",
    '<span class="tag-anchor" data-tag-cat="prop">no name</span> ' + tag("prop", "   ", "blank") + " " + tag("prop", "&lt;b&gt;&lt;/b&gt;", "markup only")],
  ["tag anchor: dirty name",
    tag("prop", "&lt;b&gt;Big&lt;/b&gt; lamp &quot;x&quot; &amp; y", "lamp") + " " + tag("location", "  " + "L".repeat(100) + "  ", "long")],
  ["tag anchor: runs merged across marks",
    tag("prop", "Red mug", 'red <strong>mug</strong> <span class="cmt-anchor" data-cmt="c7">handle</span>') + " " +
    tag("gear", "Tripod", '<a href="https://e.x/t">tri</a>pod') + " " +
    tag("cast", "Ann", '<span class="stage-dir">Ann</span> waves')],
  ["b-roll key", '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span> drone shot<br>next'],
  ["b-roll key: marker variants",
    '<span class="broll-key" data-broll-id="k1">b roll -</span> a <span class="broll-key" data-broll-id="k2">B-Roll —</span> b ' +
    '<span class="broll-key" data-broll-id="k3">broll–</span> c <span class="broll-key" data-broll-id="k4">  B-roll :  </span> d ' +
    '<span class="broll-key" data-broll-id="k5">B-roll: and words</span> e'],
  ["b-roll key: bad marker",
    '<span class="broll-key" data-broll-id="bs2">Not a marker</span> <span class="broll-key">Rollb:</span> <span class="broll-key" data-broll-id="bs3"></span>end'],
  ["b-roll key: no id", '<span class="broll-key">B-roll:</span> one <span class="broll-key" data-broll-id="">B-roll:</span> two'],
  ["b-roll key: dirty id", '<span class="broll-key" data-broll-id="bs 9!&lt;x&gt;">B-roll:</span> x <span class="broll-key" data-broll-id="!!!">B-roll:</span> y'],
  ["b-roll key: markup inside", '<span class="broll-key" data-broll-id="bs4"><b>B-roll</b>: </span>city <strong><span class="broll-key" data-broll-id="bs5">B-roll:</span></strong> bold'],
  ["b-roll key inside a comment, a link and a cue line",
    '<span class="cmt-anchor" data-cmt="c1"><span class="broll-key" data-broll-id="k1">B-roll:</span> x</span> ' +
    '<a href="https://e.x/"><strong><span class="broll-key" data-broll-id="k2">B-roll:</span></strong> y</a><br>' +
    '<span class="audio-cue">SFX: <span class="broll-key" data-broll-id="k3">B-roll:</span> z</span>'],
  ["one span, two special classes",
    '<span class="cmt-anchor tag-anchor" data-cmt="c1" data-tag-cat="prop" data-tag-name="Mug">mug</span> ' +
    '<span class="stage-dir audio-cue">both</span> <span class="broll-key cmt-anchor" data-cmt="c2" data-broll-id="k1">B-roll:</span> ' +
    '<a class="video-embed-card other" href="https://e.x/v">card</a>'],
  ["comment anchor", 'before <span class="cmt-anchor" data-cmt="c1">quoted</span> after'],
  ["comment anchor: no id", '<span class="cmt-anchor">no id</span> and <span class="cmt-anchor" data-cmt="">empty id</span>'],
  ["comment anchor: dirty and prototype ids",
    '<span class="cmt-anchor" data-cmt="c 1&lt;&gt;">dirty</span> <span class="cmt-anchor" data-cmt="__proto__">proto</span> <span class="cmt-anchor" data-cmt="constructor">ctor</span>'],
  ["comment anchor: nested and overlapping",
    '<span class="cmt-anchor" data-cmt="c2">outer <span class="cmt-anchor" data-cmt="c1">inner</span> tail</span> <span class="cmt-anchor" data-cmt="c3"><span class="cmt-anchor" data-cmt="c3">same twice</span></span>'],
  ["stage direction", 'Hello <span class="stage-dir">beat</span> world <span class="stage-dir"><em>softly</em></span>.'],
  ["audio cue", '<span class="audio-cue">SFX: thunder</span><br>next line<br><span class="audio-cue">Music : theme</span>'],
  ["audio cue: not a cue line", '<span class="audio-cue">not a cue</span> and <span class="audio-cue">sfx</span>: late<br>x <span class="audio-cue">SFX: mid-line</span>'],
  ["audio cue: spreads across its line", '<span class="audio-cue">SFX:</span> thunder <em>rolls</em><br>Music: <span class="audio-cue">theme</span>'],
  ["audio cue: with a tag",'<span class="audio-cue">Music: ' + tag("sound", "Theme", "Theme") + "</span>"],
  ["image: png", 'a <img src="' + PNG.dataUrl + '" alt="x" onerror="y" width="9"> b'],
  ["image: jpeg", '<img src="' + JPEG.dataUrl + '">'],
  ["image: jpg label", '<img src="data:image/jpg;base64,' + JPG.base64 + '">'],
  ["image: gif", '<img src="' + GIF.dataUrl + '">'],
  ["image: webp", '<img src="' + WEBP.dataUrl + '">'],
  ["image: svg", 'a<img src="' + SVG + '">b<img src="data:image/svg+xml,%3Csvg%2F%3E">c'],
  ["image: label disagrees with bytes", '<img src="data:image/gif;base64,' + MISLABELED.base64 + '">'],
  ["image: wrapped base64", '<img src="data:image/png;base64,' + WRAPPED.base64.replace(/(.{12})/g, "$1\n") + '">'],
  ["image: bad base64 characters", 'a<img src="data:image/png;base64,@@@@">b<img src="data:image/png;base64,' + PNG.base64.slice(0, 8) + " " + PNG.base64.slice(8) + '">c'],
  ["image: bad base64 padding", 'a<img src="data:image/png;base64,iVBO=Rw0">b<img src="data:image/png;base64,' + PNG.base64 + 'A">c'],
  ["image: base64 that is not a picture", 'a<img src="data:image/png;base64,' + Buffer.from("hello, world").toString("base64") + '">b<img src="data:image/png;base64,AAAA">c'],
  ["image: remote and blob sources", 'a<img src="https://example.com/x.png">b<img src="blob:https://splitpage.test/abc">c<img>d'],
  ["image: known data-blob", blob(KNOWN.sha256, ' data-w="999" data-h="1" data-mime="image/gif" src="blob:https://splitpage.test/1" class="x" alt="y"')],
  ["image: unknown data-blob with a size", blob(UNKNOWN, ' class="x" data-w="5" data-h="6" data-mime="image/webp" width="9"')],
  ["image: unknown data-blob with a bad size",
    [' data-w="5" data-h="6" data-mime="image/svg+xml"', ' data-w="0" data-h="6" data-mime="image/png"', ' data-w="5.5" data-h="6" data-mime="image/png"',
      ' data-w="5" data-mime="image/png"', ' data-w="-5" data-h="6" data-mime="image/png"', ' data-w="01" data-h="6" data-mime="image/png"',
      ' data-w="12345678" data-h="6" data-mime="image/png"', ""].map((a) => blob(UNKNOWN, a)).join("|")],
  ["image: unknown data-blob beside a data src", blob(UNKNOWN, ' data-w="2" data-h="2" data-mime="image/png" src="' + FALLBACK.dataUrl + '"')],
  ["image: bad data-blob", ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", " " + "a".repeat(64)].map((s) => "x" + blob(s)).join("") + "y"],
  ["image: bad data-blob with a picture of its own", blob("nope", ' src="' + FALLBACK.dataUrl + '"')],
  ["links: safe",
    '<a href="https://e.x/a?b=1&amp;c=2">https</a> <a href="http://e.x/">http</a> <a href="mailto:a@e.x">mail</a> <a href="  https://e.x/trim  ">trim</a> ' +
    '<a href="HTTPS://E.X/">upper</a> <a href="https://e.x/" target="_self" onclick="x()">attrs</a>'],
  ["links: javascript",
    '<a href="javascript:alert(1)">js</a> <a href=" JaVaScRiPt:alert(1)">js2</a> <a href="java&#0;script:alert(1)">js3</a> ' +
    '<a href="java&#9;script:alert(1)">tab</a> <a href="java&#10;script:x">nl</a> <a href="vbscript:x">vb</a> <a href="&#1;javascript:x">c0</a>'],
  ["links: data", '<a href="data:text/html,&lt;script&gt;x&lt;/script&gt;">d</a> <a href="DATA:image/png;base64,AAAA">d2</a> <a href=" data:x">d3</a>'],
  ["links: other schemes", '<a href="ftp://e.x/">ftp</a> <a href="/x">rel</a> <a href="#frag">frag</a> <a href="MAILTO:a@e.x">MAIL</a> <a href="https:no-slashes">ns</a> <a>none</a>'],
  ["links: label with brackets", '<a href="https://e.x/(1)">a [b] (c)</a> and <a href="https://e.x/"><strong>bold</strong> label</a>'],
  ["links: a link inside a link",
    '<a href="https://one.test/">p<table><td><a href="https://two.test/"><b>x</b></a></td></table>q<object><a href="javascript:void(0)">u</a></object></a>'],
  ["links: a video card inside a link",
    '<a href="https://one.test/">see <object><a class="video-embed-card" href="https://youtu.be/x"><span>Watch video</span></a></object> after<object><a class="video-embed-card" href="javascript:alert(1)">gone</a></object></a>'],
  ["links: nested in formatting", "<strong>bold <a href=\"https://e.x/\">link</a></strong> <a href=\"https://e.x/\"><em>it</em></a>"],
  ["video card", 'watch <a class="video-embed-card" href="https://www.youtube.com/watch?v=abc" target="_blank"><span>junk</span></a> this'],
  ["video card: unsafe href", 'a <a class="video-embed-card" href="javascript:alert(1)"><span>Watch video</span></a> b <a class="video-embed-card">no href</a> c'],
  ["video card: mailto and odd hosts",
    '<a class="video-embed-card" href="mailto:a@e.x">m</a><a class="video-embed-card" href="https://WWW.Example.COM/Path">e</a><a class="video-embed-card" href="http://[::1]:8080/x">v6</a>'],
  ["astral characters", "😀 𝒳 👩‍👩‍👧 <b>𝄞 bold</b> <span class=\"cmt-anchor\" data-cmt=\"c5\">🎬</span>"],
  ["nbsp", "a&nbsp;b c  d <b>&nbsp;</b> <span class=\"stage-dir\">&nbsp;x&nbsp;</span>"],
  ["object replacement character", "a￼b <b>￼</b>"],
  ["zero width space", "a​b <b>​</b> ​"],
  ["crlf", "line1\r\nline2\rline3\nline4<br>\r\nafter"],
  ["control characters", "a\u0000b\u0001c\u0008d\te\u000bf\u000cg\u001fh\u007fi"],
  ["entities", "&lt;b&gt; &amp; &quot; &#x1F600; &copy; &#0; &bogus;"],
  ["lone surrogates", "x\ud800y \udc00z <b>\ud83d</b>"],
  ["markdown-looking text", "**not bold** *not it* ~~not s~~ [x](https://e.x/) ((not a direction)) # heading"],
  ["hydrated cell",
    'one <strong>two</strong> <img class="comment-img" data-blob="' + "c3".repeat(32) + '" data-w="4" data-h="5" data-mime="image/png" src="blob:https://splitpage.test/9" alt="" width="4"> ' +
    '<img class="comment-img" data-blob="' + "c3".repeat(32) + '" data-blob-state="missing" alt="Image unavailable" title="Image unavailable"> three&nbsp;'],
  ["data-blob only in text", "the word data-blob appears <b>here</b> &amp; there"],
  ["data-blob attribute on another element", '<span data-blob="' + "c3".repeat(32) + '">x</span> <img src="x" data-blob>']
];

const VIDEO_HREFS = [
  "https://www.youtube.com/watch?v=abc",
  "https://youtu.be/xyz",
  "http://vimeo.com/123",
  "https://WWW.Example.COM/Path",
  "https://例え.jp/動画",
  "mailto:someone@example.com",
  "http://[::1]:8080/x",
  "http://",
  "not a url",
  "javascript:alert(1)",
  'https://example.com/a"b<c>&d'
];

function maskCell(cell, masker) {
  return cell.map((r) => {
    const out = JSON.parse(JSON.stringify(r));
    if (out.atom === "broll") out.id = masker.id(out.id, "bs");
    if (out.marks && Array.isArray(out.marks.cmt)) out.marks.cmt = out.marks.cmt.map((id) => masker.id(id, "c"));
    return out;
  });
}

function runCase(input) {
  const started = Date.now();
  const masker = createIdMasker(() => started, () => Date.now());
  const sanitized = sanitizeHtml(input);
  const media = [];
  const cell = fromHtml(input, { onMedia: (m) => media.push(m) });
  const rendered = toHtml(cell);
  return {
    input,
    started,
    raw: { sanitized, rendered, cell: JSON.parse(JSON.stringify(cell)) },
    golden: {
      input,
      sanitized: masker.html(sanitized),
      fromHtml: maskCell(cell, masker),
      media,
      toHtml: masker.html(rendered),
      markdown: htmlToMarkdown(sanitized),
      markdownOfInput: htmlToMarkdown(input),
      storedFromDom: storedHtmlFromDom(input)
    },
    minted: masker.minted,
    ended: Date.now()
  };
}

function idsTheInputCarries(input) {
  const known = new Set();
  if (typeof input !== "string") return known;
  const body = new DOMParser().parseFromString(input, "text/html").body;
  for (const el of body.querySelectorAll("[data-cmt], [data-broll-id]")) {
    for (const v of [el.getAttribute("data-cmt"), el.getAttribute("data-broll-id")]) {
      if (v !== null) known.add(v).add(v.replace(/[^A-Za-z0-9_-]/g, ""));
    }
  }
  return known;
}

function idsTheOutputsAdd(r) {
  const known = idsTheInputCarries(r.input);
  const found = [...idsInHtml(r.raw.sanitized), ...idsInHtml(r.raw.rendered)];
  for (const run of r.raw.cell) {
    if (run.atom === "broll") found.push({ prefix: "bs", value: run.id });
    for (const id of run.marks.cmt || []) found.push({ prefix: "c", value: id });
  }
  return found.filter((f) => !known.has(f.value));
}

intern(KNOWN.bytes);

const results = CORPUS.map(([name, input]) => [name, runCase(input)]);
const actual = {
  cases: Object.fromEntries(results.map(([name, r]) => [name, r.golden])),
  videoCards: VIDEO_HREFS.map((href) => ({ href, html: buildVideoCardEl(href).outerHTML }))
};
const expected = settleGolden("richtext", "richtext-golden.json", actual);

test("the corpus names are unique", () => {
  assert.equal(new Set(CORPUS.map(([name]) => name)).size, CORPUS.length);
});

test("the fixture holds exactly the corpus, in order", () => {
  assert.deepEqual(Object.keys(expected.value.cases), CORPUS.map(([name]) => name));
});

for (const [name, r] of results) {
  test("golden: " + name, () => {
    const want = expected.value.cases[name];
    assert.ok(want, "no fixture entry for " + JSON.stringify(name));
    assert.equal(goldenText(r.golden), goldenText(want));
  });
}

test("golden: video card HTML", () => {
  assert.equal(goldenText(actual.videoCards), goldenText(expected.value.videoCards));
});

test("every id the outputs add is minted in this run's format and masked; no id the input carried is masked", () => {
  let added = 0;
  for (const [name, r] of results) {
    const ids = idsTheOutputsAdd(r);
    const golden = goldenText(r.golden);
    for (const a of ids) {
      assert.ok(mintedId(a.value, a.prefix, r.started, r.ended),
        `${name}: ${a.value} is not ${a.prefix} plus seven base-36 digits at most and a base-36 time stamp from this run`);
      assert.ok(!golden.includes(a.value), `${name}: ${a.value} is left unmasked`);
    }
    for (const m of r.minted) assert.ok(ids.some((a) => a.value === m.value), `${name}: ${m.value} was masked, yet the input carried it`);
    added += ids.length;
  }
  assert.ok(added > 0, "the corpus has anchors and b-roll keys without ids");
});

test("INV-10: the sanitiser's output is its own fixed point over the corpus", () => {
  for (const [name, r] of results) {
    assert.equal(sanitizeHtml(r.raw.sanitized), r.raw.sanitized, name);
  }
});

test("toHtml(fromHtml(x)) is already in stored form over the corpus", () => {
  for (const [name, r] of results) {
    assert.equal(sanitizeHtml(r.raw.rendered), r.raw.rendered, name);
  }
});

test("the whole fixture file is byte-for-byte what the corpus produces", () => {
  assert.equal(goldenText(actual), expected.text);
});
