import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { zipRead } from "../src/adapters/formats/zip.ts";
import { clockProblems } from "./export-ab-environment.mjs";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";
import { withRefTrees } from "./ref-trees.mjs";

export const PRODUCER = "tools/export-ab-produce.mjs";
export const PRODUCER_FILES = [PRODUCER, "tools/export-ab-environment.mjs"];
export const CANONICAL_DOCUMENTS = "prototypes/collab/test/proj";

export const FORMATS = [
  { id: "splitpage-save", label: ".splitpage (save)" },
  { id: "md-project", label: ".md project (save)" },
  { id: "splitpage", label: ".splitpage (export copy)" },
  { id: "md", label: "Markdown (.md, or .zip with images)" },
  { id: "md-table", label: "Markdown, two columns" },
  { id: "txt", label: "Plain text (.txt write-back)" },
  { id: "docx", label: "Word (.docx)" },
  { id: "narration-docx", label: "Narration (.docx)" },
  { id: "narration-txt", label: "Narration (.txt)" },
  { id: "xlsx", label: "Spreadsheet (.xlsx)" },
  { id: "csv", label: "Spreadsheet (.csv)" },
  { id: "breakdown xlsx", label: "Breakdown (.xlsx)" },
  { id: "breakdown", label: "Breakdown (.csv)" },
  { id: "b-roll xlsx", label: "B-roll shot list (.xlsx)" },
  { id: "b-roll csv", label: "B-roll shot list (.csv)" },
  { id: "html", label: "Standalone HTML: state, title, description", standalone: true },
  { id: "pdf print page", label: "PDF: print page HTML" },
  { id: "packing-gear print page", label: "Gear packing list PDF: print page HTML" },
  { id: "packing-prop print page", label: "Props packing list PDF: print page HTML" },
  { id: "b-roll pdf print page", label: "B-roll shot list PDF: print page HTML" }
];

export const NOT_COMPARED = [
  {
    what: "PDF bytes (pdf, packing-gear, packing-prop, b-roll pdf)",
    why: "the browser's print dialog or Electron's printToPDF renders them from the print page compared above; neither runs here",
    covered: "browser suite 384-browser-print, desktop/test/print-pdf.test.mjs, tests/adapters/formats/list-print.test.mjs"
  },
  {
    what: ".splitpage with the script's files (.zip)",
    why: "desktop only: it reads the script's linked files from disk through the desktop shell",
    covered: "desktop/test/bundle-export.test.mjs, tests/features/gallery/video-bundles.test.ts"
  },
  {
    what: "Standalone HTML outside the state-data script, title and description elements of the document itself, including such elements inside <template>",
    why: "it embeds the whole app, so its bytes follow every app change; here the shell is src/page.html as loaded in Node, not the built app, and its size is reported, not compared",
    covered: "src/test/exports-golden.test.mjs (state, title, description); browser suite 284-exports-from-a-fixture"
  }
];

export const UNSEEN = [
  "a change visible only under another default locale or time zone: Intl.DateTimeFormat defaults to en-US and UTC, and other default-locale methods (toLocaleString and the like) use this machine's default on both sides",
  "a change that depends on the difference between two clock reads: every wall-clock read returns the same frozen instant"
];

export const EXCLUSIONS = [];

export function parseArgs(argv) {
  const refs = argv.filter((a) => !a.startsWith("-"));
  const unknown = argv.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`unknown option: ${unknown}`);
  if (refs.length < 1 || refs.length > 2) throw new Error("usage: node tools/export-ab.mjs <base> [head=HEAD]");
  return { base: refs[0], head: refs[1] ?? "HEAD" };
}

export function producedIds(manifest) {
  return [
    "splitpage-save",
    "md-project",
    ...manifest.registered.filter((e) => e.build).map((e) => e.id),
    ...manifest.registered.filter((e) => e.printPage).map((e) => `${e.id} print page`)
  ];
}

export function completeness(manifest, side, formats = FORMATS) {
  const known = new Set(formats.map((f) => f.id));
  const produced = producedIds(manifest);
  const problems = produced.filter((id) => !known.has(id)).map((id) => `${side}: the app has export ${id}, which the tool does not know; add it to FORMATS in tools/export-ab.mjs`);
  for (const f of formats) {
    if (!produced.includes(f.id)) problems.push(`${side}: FORMATS lists ${f.id}, which the app no longer produces`);
  }
  return problems;
}

export function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export function excludedRanges(bytes, exclusions) {
  const text = Buffer.from(bytes).toString("latin1");
  const ranges = [];
  for (const exclusion of exclusions) {
    const pattern = new RegExp(exclusion.pattern.source, exclusion.pattern.flags.replace("g", "") + "g");
    for (const match of text.matchAll(pattern)) {
      if (!match[0].length) continue;
      if (match[0].length > exclusion.bytes) {
        throw new Error(`exclusion ${exclusion.field} matched ${match[0].length} bytes at ${match.index}, more than its declared ${exclusion.bytes}`);
      }
      ranges.push({ field: exclusion.field, start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((x, y) => x.start - y.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) throw new Error(`exclusions ${ranges[i - 1].field} and ${ranges[i].field} overlap at ${ranges[i].start}`);
  }
  return ranges;
}

export function compareMasked(a, b, exclusions) {
  const ra = excludedRanges(a, exclusions);
  const rb = excludedRanges(b, exclusions);
  const kept = (bytes, ranges) => {
    const parts = [];
    let at = 0;
    for (const r of ranges) {
      parts.push({ from: at, bytes: bytes.subarray(at, r.start) });
      at = r.end;
    }
    parts.push({ from: at, bytes: bytes.subarray(at) });
    return parts;
  };
  const excluded = { base: ra, head: rb };
  if (ra.length !== rb.length || ra.some((r, i) => r.field !== rb[i].field)) {
    return { same: false, offset: Math.min(ra[0]?.start ?? a.length, rb[0]?.start ?? b.length), excluded };
  }
  const pa = kept(a, ra);
  const pb = kept(b, rb);
  for (let i = 0; i < pa.length; i++) {
    const at = firstDifference(pa[i].bytes, pb[i].bytes);
    if (at !== -1) return { same: false, offset: pa[i].from + at, excluded };
  }
  return { same: true, offset: -1, excluded };
}

const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const arrayBufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function zipDifferences(a, b) {
  const [za, zb] = await Promise.all([zipRead(arrayBufferOf(a)), zipRead(arrayBufferOf(b))]);
  const lines = [];
  for (const name of za.names.filter((n) => !zb.names.includes(n))) lines.push(`member ${name} only in base`);
  for (const name of zb.names.filter((n) => !za.names.includes(n))) lines.push(`member ${name} only in head`);
  for (const name of za.names.filter((n) => zb.names.includes(n))) {
    const [ma, mb] = await Promise.all([za.get(name), zb.get(name)]);
    const at = firstDifference(ma, mb);
    if (at !== -1) lines.push(`member ${name} differs at offset ${at} (base ${ma.length} bytes, head ${mb.length} bytes)`);
  }
  const shared = za.names.filter((n) => zb.names.includes(n));
  if (shared.join("\n") !== zb.names.filter((n) => za.names.includes(n)).join("\n")) lines.push("members are in a different order");
  if (!lines.length) lines.push(`archive bytes differ at offset ${firstDifference(a, b)}; every member is identical`);
  return lines;
}

export const STANDALONE_FIELDS = [
  { key: "stateData", select: (document) => [...document.querySelectorAll("script")].filter((e) => e.id === "state-data") },
  { key: "title", select: (document) => [...document.getElementsByTagName("title")] },
  { key: "description", select: (document) => [...document.getElementsByTagName("meta")].filter((e) => e.getAttribute("name") === "description") }
];

export function standaloneParts(html) {
  const bytes = Buffer.from(html);
  const dom = new JSDOM(bytes.toString("latin1"), { includeNodeLocations: true });
  const parts = {};
  let found = 0;
  for (const field of STANDALONE_FIELDS) {
    parts[field.key] = field.select(dom.window.document).map((element) => {
      const at = dom.nodeLocation(element);
      found += at.endOffset - at.startOffset;
      return bytes.subarray(at.startOffset, at.endOffset);
    });
  }
  dom.window.close();
  return { ...parts, restBytes: bytes.length - found };
}

function noOutput(base, head) {
  if (base.error !== undefined && head.error !== undefined) return `no output on both sides: base ${base.error}; head ${head.error}`;
  return base.error !== undefined ? `no output on base: ${base.error}` : `no output on head: ${head.error}`;
}

export async function compareOutput(format, base, head, exclusions = EXCLUSIONS) {
  if (base.error !== undefined || head.error !== undefined) return { same: false, detail: noOutput(base, head) };
  const rules = exclusions.filter((e) => e.format === format.id);
  if (format.standalone) {
    const pa = standaloneParts(base.bytes);
    const pb = standaloneParts(head.bytes);
    const info = `page shell around them: base ${pa.restBytes} bytes, head ${pb.restBytes} bytes`;
    const where = [];
    const excluded = { base: [], head: [] };
    for (const { key } of STANDALONE_FIELDS) {
      if (!pa[key].length || !pb[key].length) where.push(`no ${key} element on ${pa[key].length ? "head" : pb[key].length ? "base" : "either side"}`);
      else if (pa[key].length !== pb[key].length) where.push(`${key}: base has ${pa[key].length} elements, head ${pb[key].length}`);
      pa[key].forEach((element, i) => {
        if (!pb[key][i]) return;
        const result = compareMasked(element, pb[key][i], rules);
        excluded.base.push(...result.excluded.base);
        excluded.head.push(...result.excluded.head);
        if (!result.same) where.push(`${key} element ${i + 1} differs at byte ${result.offset} of the element (base ${element.length} bytes, head ${pb[key][i].length} bytes)`);
      });
    }
    if (where.length) return { same: false, detail: where.join("; "), info };
    return { same: true, info, excluded: rules.length ? excluded : null };
  }
  const result = compareMasked(base.bytes, head.bytes, rules);
  if (result.same) return { same: true, excluded: rules.length ? result.excluded : null };
  if (isZip(base.bytes) && isZip(head.bytes)) return { same: false, detail: (await zipDifferences(base.bytes, head.bytes)).join("; ") };
  return { same: false, detail: `first difference at offset ${result.offset} (base ${base.bytes.length} bytes, head ${head.bytes.length} bytes)` };
}

function readOutput(dir, entry) {
  if (!entry) return { error: "not produced" };
  if (entry.error !== undefined) return { error: entry.error };
  return { bytes: readFileSync(join(dir, entry.file)) };
}

export async function compareRuns(dirs, formats = FORMATS, exclusions = EXCLUSIONS) {
  const manifests = {};
  for (const side of ["base", "head"]) manifests[side] = JSON.parse(readFileSync(join(dirs[side], "manifest.json"), "utf8"));
  const problems = [
    ...completeness(manifests.base, "base", formats), ...completeness(manifests.head, "head", formats),
    ...clockProblems("base", manifests.base.fixtures), ...clockProblems("head", manifests.head.fixtures)
  ];
  const names = manifests.head.fixtures.map((f) => f.name);
  const baseNames = manifests.base.fixtures.map((f) => f.name);
  if (names.join("\n") !== baseNames.join("\n")) problems.push(`the fixtures differ: base ${baseNames.join(", ")}; head ${names.join(", ")}`);
  const cells = [];
  for (const format of formats) {
    for (const name of names) {
      const outputsOf = (side) => manifests[side].fixtures.find((f) => f.name === name)?.outputs[format.id];
      const result = await compareOutput(format, readOutput(dirs.base, outputsOf("base")), readOutput(dirs.head, outputsOf("head")), exclusions);
      cells.push({ format: format.id, fixture: name, ...result });
    }
  }
  const clocks = manifests.head.fixtures.map((f) => ({ name: f.name, ...f.clock }));
  return { fixtures: names, formats: formats.map((f) => f.id), cells, problems, clocks, same: !problems.length && cells.every((c) => c.same) };
}

export function report(base, head, result, formats = FORMATS) {
  const label = (id) => formats.find((f) => f.id === id)?.label ?? id;
  const cell = (format, fixture) => result.cells.find((c) => c.format === format && c.fixture === fixture);
  const lines = [
    `Exports of ${result.fixtures.length} fixtures in ${result.formats.length} formats, base ${base.slice(0, 8)} against head ${head.slice(0, 8)}: ${result.same ? "every cell has identical compared bytes" : "DIFFERENCES"}.`,
    "Compared bytes: the whole output, except Standalone HTML, where only the state-data script, title and description meta elements of the document itself are compared (found by an HTML parse, as raw bytes); element content inside <template> and the rest of the shell are not compared.",
    `Capture clock ${result.clocks[0]?.capturedAt ?? "unknown"}; wall clock ${result.clocks[0]?.now ?? "unknown"}, so an export that reads the wall clock instead of the capture time differs.`,
    "",
    `| Format | ${result.fixtures.join(" | ")} |`,
    `| --- | ${result.fixtures.map(() => "---").join(" | ")} |`
  ];
  for (const format of result.formats) {
    lines.push(`| ${label(format)} | ${result.fixtures.map((fixture) => {
      const c = cell(format, fixture);
      if (c.same) return "same";
      return c.detail.startsWith("no output") ? "NO OUTPUT" : "DIFF";
    }).join(" | ")} |`);
  }
  if (result.problems.length) lines.push("", "Problems:", "", ...result.problems.map((p) => `- ${p}`));
  const differing = result.cells.filter((c) => !c.same);
  if (differing.length) lines.push("", "Differences and missing output:", "", ...differing.map((c) => `- ${c.format} / ${c.fixture}: ${c.detail}`));
  const excluded = result.cells.filter((c) => c.excluded);
  lines.push("", "Declared exclusions:", "");
  if (!excluded.length) lines.push("- none: every compared byte is compared");
  for (const c of excluded) {
    const ranges = (side) => c.excluded[side].map((r) => `${r.field} ${r.start}-${r.end}`).join(", ") || "none";
    lines.push(`- ${c.format} / ${c.fixture}: base ${ranges("base")}; head ${ranges("head")}`);
  }
  const info = result.cells.filter((c) => c.info);
  if (info.length) lines.push("", "Information, not compared:", "", ...info.map((c) => `- ${c.format} / ${c.fixture}: ${c.info}`));
  lines.push("", "Not compared here:", "", ...NOT_COMPARED.map((n) => `- ${n.what}: ${n.why}. Covered by ${n.covered}.`));
  lines.push("", "Change kinds this tool cannot see:", "", ...UNSEEN.map((u) => `- ${u}`));
  return lines.join("\n");
}

export async function main(argv, repo = REPO, seen = () => {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`export-ab: ${error.message}`);
    return 1;
  }
  const started = Date.now();
  const status = await withRefTrees(repo, "export-ab", [["base", args.base], ["head", args.head]], async ({ dirs, shas, run, scratch }) => {
    const documents = join(repo, CANONICAL_DOCUMENTS);
    if (!existsSync(documents)) throw new Error(`${CANONICAL_DOCUMENTS} is missing`);
    const out = {};
    for (const side of ["base", "head"]) {
      for (const file of PRODUCER_FILES) cpSync(join(repo, file), join(dirs[side], file));
      out[side] = join(scratch, `out-${side}`);
      console.error(`export-ab: producing ${side} exports`);
      await run(process.execPath, [PRODUCER, out[side], documents], dirs[side], { ...process.env, TZ: "UTC" });
    }
    const result = await compareRuns(out);
    seen(result);
    console.log(report(shas.base, shas.head, result));
    return result.same ? 0 : 1;
  });
  console.error(`export-ab: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return status;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
