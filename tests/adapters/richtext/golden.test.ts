import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../../../src/core/text/html.ts";
import type { DecodedMedia } from "../../../src/core/text/ports.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { goldenText, image, readGoldenText } from "../../../src/test/golden-helpers.mjs";
import { adapterWith, fakePorts } from "./fakes.ts";
import type { Minted, PortCall } from "./fakes.ts";

const DOM_GLOBALS = ["window", "document", "DOMParser", "Node", "Element", "HTMLElement"].filter((name) => name in globalThis);

type GoldenCase = { input: unknown } & Record<string, unknown>;

type RichtextGolden = {
  cases: Record<string, GoldenCase>;
  videoCards: { href: string; html: string }[];
};

type JsonRun = { atom?: string; id?: unknown; marks?: { cmt?: unknown[] } };

const GOLDEN = JSON.parse(readGoldenText("richtext", "richtext-golden.json")) as RichtextGolden;
const KNOWN = image("png", 7, 5);

const ports = fakePorts([KNOWN.record]);
const rt = adapterWith(ports);

function createMasker(minted: readonly Minted[]) {
  const placeholders = new Map<string, string>();
  const counts = new Map<string, number>();
  function id(value: unknown, prefix: string): unknown {
    if (typeof value !== "string") return value;
    const known = placeholders.get(value);
    if (known !== undefined) return known;
    const m = minted.find((x) => x.value === value);
    if (!m) return value;
    assert.equal(m.prefix, prefix, value + " was minted with the prefix " + m.prefix);
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    const ph = `{minted:${prefix}:${String(n)}}`;
    placeholders.set(value, ph);
    return ph;
  }
  function html(text: string): string {
    return text.replace(/(data-(cmt|broll-id)=")([^"]*)(")/g,
      (_m: string, a: string, kind: string, v: string, b: string) => a + String(id(v, kind === "cmt" ? "c" : "bs")) + b);
  }
  return { id, html };
}

function maskCell(cell: readonly Run[], masker: ReturnType<typeof createMasker>): JsonRun[] {
  return cell.map((r) => {
    const out = JSON.parse(JSON.stringify(r)) as JsonRun;
    if (out.atom === "broll") out.id = masker.id(out.id, "bs");
    if (out.marks && Array.isArray(out.marks.cmt)) out.marks.cmt = out.marks.cmt.map((id) => masker.id(id, "c"));
    return out;
  });
}

function callsDuring(run: () => void): PortCall[] {
  const from = ports.log.length;
  run();
  return ports.log.slice(from);
}

function runCase(input: unknown) {
  const masker = createMasker(ports.minted);
  let sanitized = "";
  let cell: Run[] = [];
  const media: DecodedMedia[] = [];
  const sanitizeCalls = callsDuring(() => { sanitized = rt.sanitize(input); });
  const decodeCalls = callsDuring(() => { cell = rt.decode(input, { onMedia: (m) => { media.push(m); } }); });
  const rendered = toHtml(cell);
  let markdown = "", markdownOfInput = "";
  let storedFromDom: unknown = null;
  const readerCalls = callsDuring(() => {
    markdown = rt.htmlToMarkdown(sanitized);
    markdownOfInput = rt.htmlToMarkdown(input);
    storedFromDom = rt.storedHtmlFromDom(input);
  });
  return {
    sanitized,
    rendered,
    sanitizeCalls,
    decodeCalls,
    readerCalls,
    golden: {
      input,
      sanitized: masker.html(sanitized),
      fromHtml: maskCell(cell, masker),
      media,
      toHtml: masker.html(rendered),
      markdown,
      markdownOfInput,
      storedFromDom
    }
  };
}

const results = Object.entries(GOLDEN.cases).map(([name, c]) => [name, runCase(c.input)] as const);

test("no DOM global exists in this process: the adapter has only the parser it was given", () => {
  assert.deepEqual(DOM_GLOBALS, []);
});

test("the replay covers every case in the richtext fixture", () => {
  assert.ok(results.length > 0);
  assert.deepEqual(results.map(([name]) => name), Object.keys(GOLDEN.cases));
});

for (const [name, r] of results) {
  test("golden through the adapter: " + name, () => {
    assert.equal(goldenText(r.golden), goldenText(GOLDEN.cases[name]));
  });
}

test("golden through the adapter: video card HTML", () => {
  assert.deepEqual(GOLDEN.videoCards.map((v) => ({ href: v.href, html: rt.videoCardHtml(v.href) })), GOLDEN.videoCards);
});

test("INV-10: the sanitiser's output is its own fixed point over the corpus", () => {
  for (const [name, r] of results) {
    const calls = callsDuring(() => { assert.equal(rt.sanitize(r.sanitized), r.sanitized, name); });
    assert.ok(calls.every((c) => c[0] === "known"), name + ": stored output only looks pictures up");
  }
});

test("toHtml(decode(x)) is already in stored form over the corpus", () => {
  for (const [name, r] of results) {
    assert.equal(rt.sanitize(r.rendered), r.rendered, name);
  }
});

test("decoding sanitises once, asking the ports what sanitising asks, in the same order", () => {
  for (const [name, r] of results) {
    assert.deepEqual(r.decodeCalls, r.sanitizeCalls, name);
  }
});

test("Markdown and stored-form reads use neither port", () => {
  for (const [name, r] of results) {
    assert.deepEqual(r.readerCalls, [], name);
  }
});

test("every id the adapter minted came from the IdSource and is masked in the replay", () => {
  assert.ok(ports.minted.length > 0, "the corpus has anchors and b-roll keys without ids");
  const replay = goldenText(results.map(([, r]) => r.golden));
  for (const m of ports.minted) assert.ok(!replay.includes(m.value), m.value + " is left unmasked");
});
