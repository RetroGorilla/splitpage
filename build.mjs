#!/usr/bin/env node
/* Splitpage build.
 *
 * Source lives in src/ as separate files so it can be edited like normal code:
 * page.html (shell), app.css, seed-state.json (the demo document) and the
 * numbered fragments in src/js/.
 * The SHIPPED app is a single index.html, and that is not a packaging
 * preference — it is load-bearing. A save writes
 *   "<!doctype html>" + document.documentElement.outerHTML
 * with the new document spliced into #state-data (see buildPublishHtml in
 * src/app.js). If the page linked out to app.css / app.js, every saved
 * .splitpage.html would be a shell that only works next to those files. So we
 * inline everything back into one self-contained page here.
 *
 * No dependencies, no plugins: substitution of three marker lines. Run it with
 *   node build.mjs           write index.html
 *   node build.mjs --check   verify index.html matches src/ (exit 1 if not)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(ROOT, "src", name), "utf8");

/* Each marker sits alone on its line in src/page.html. Stripping one trailing
   newline from the inserted file makes the join exact: the marker line's own
   newline becomes the inserted block's last one. */
const chomp = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/* src/js/*.js are FRAGMENTS of one IIFE, not modules: they share a single
   closure and are concatenated in filename order, which is why every name is
   numbered. A fragment is not valid JS on its own — 00-prelude.js opens the
   function and 21-events.js closes it. That is deliberate: it keeps the
   scoping identical to the single file this was split out of, with no bundler
   and no dependency. Renaming one renumbers its position, so don't. */
function appJs() {
  const dir = join(ROOT, "src", "js");
  const names = readdirSync(dir).filter((n) => n.endsWith(".js")).sort();
  if (!names.length) throw new Error("no fragments in src/js");
  return names.map((n) => chomp(readFileSync(join(dir, n), "utf8"))).join("\n");
}

/* ---- README.md -> in-app Help ----
 *
 * A dependency-free Markdown-to-HTML converter, just capable enough for
 * README.md's own vocabulary (headings, lists, blockquotes, pipe tables,
 * fenced code, horizontal rules, and inline code/bold/italic/links, plus a
 * few literal <kbd> tags README already writes by hand). Not a general
 * Markdown engine — anything README doesn't use isn't handled.
 *
 * Order matters (HANDOFF.md's escaping rule, applied to a build-time
 * converter rather than live text): escape HTML first, so nothing in the
 * document can inject markup into the shipped page; then fenced code, which
 * must not be touched by anything after it; then block structure; then
 * inline formatting last, since it only ever narrows already-safe text.
 */

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ---- the pristine-seed gate (invariant #30) ----
 *
 * A cheap synchronous checksum over a JS string's own UTF-16 code units —
 * not real FNV-1a over bytes, but the same mixing step, and it only has to
 * agree with ITSELF: this exact function runs again in the browser
 * (20b-onboarding.js) against the live #state-data element's textContent,
 * and both sides are plain JS strings, so there is no encoding to agree on.
 * No crypto.subtle (that's async; this gate runs synchronously at boot,
 * before the first paint has a chance to flash the wizard open then shut).
 */
function checksumText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* The exact string that ends up as #state-data's textContent once
 * {{SEED_STATE}} below is substituted: the template surrounds that marker
 * with one newline on each side, and PARTS chomps the loaded file's own
 * trailing newline before splicing it in. Recomputing that shape here,
 * rather than reading it back out of `html`, keeps this independent of
 * where the marker ends up landing in page.html. */
function seedCheckValue() {
  const text = "\n" + chomp(src("seed-state.json")) + "\n";
  return text.length + "-" + checksumText(text);
}

/* Inline formatting: code spans first (so `**not bold**` inside backticks is
   protected), then links, then bold, then italic. <kbd>/</kbd> are the only
   literal HTML README writes outside of code — everything else stays
   escaped text. */
function mdInline(text) {
  const codeSpans = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return "\u0000CODE" + (codeSpans.length - 1) + "\u0000";
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const internal = href.startsWith("#");
    const target = internal ? "#help-" + href.slice(1) : href;
    const attrs = internal ? "" : ' target="_blank" rel="noopener"';
    return '<a href="' + target + '"' + attrs + ">" + label + "</a>";
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/&lt;kbd&gt;/g, "<kbd>").replace(/&lt;\/kbd&gt;/g, "</kbd>");
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => "<code>" + codeSpans[i] + "</code>");
  return text;
}

/* Strips everything between <!-- help:skip-start --> and <!-- help:skip-end -->
   (developer-only sections that don't belong in the in-app Help), operating
   on the ALREADY-ESCAPED text, so the markers themselves must be matched in
   their escaped form. */
function stripHelpSkipBlocks(escaped) {
  const start = "&lt;!-- help:skip-start --&gt;";
  const end = "&lt;!-- help:skip-end --&gt;";
  let out = "";
  let i = 0;
  while (i < escaped.length) {
    const s = escaped.indexOf(start, i);
    if (s === -1) { out += escaped.slice(i); break; }
    out += escaped.slice(i, s);
    const e = escaped.indexOf(end, s);
    if (e === -1) throw new Error("README.md: help:skip-start with no matching help:skip-end");
    i = e + end.length;
  }
  return out;
}

/* Parses a run of consecutive list lines into <ul>/<ol> HTML. Lines indented
   2+ spaces and starting with "-" nest one level deep inside the preceding
   top-level item — README only ever goes one level, so that's all this
   supports. Any other line (a wrapped physical line of the same paragraph)
   is a "lazy continuation" of whichever item/sub-item came before it, joined
   with a space — README wraps list-item prose onto following lines without
   re-indenting it to any marker. */
function mdList(lines) {
  const ordered = /^\d+\.\s/.test(lines[0]);
  const tag = ordered ? "ol" : "ul";
  const topRe = ordered ? /^\d+\.\s+(.*)$/ : /^-\s+(.*)$/;
  const subRe = /^\s{2,}-\s+(.*)$/;
  const items = [];
  let lastTarget = null;
  for (const raw of lines) {
    let m = topRe.exec(raw);
    if (m) { const item = { parts: [m[1]], subs: [] }; items.push(item); lastTarget = item; continue; }
    m = subRe.exec(raw);
    if (m && items.length) {
      const sub = { parts: [m[1]] };
      items[items.length - 1].subs.push(sub);
      lastTarget = sub;
      continue;
    }
    if (lastTarget) lastTarget.parts.push(raw.trim());
  }
  let html = "<" + tag + ">";
  for (const item of items) {
    html += "<li>" + mdInline(item.parts.join(" "));
    if (item.subs.length) {
      html += "<ul>" + item.subs.map((s) => "<li>" + mdInline(s.parts.join(" ")) + "</li>").join("") + "</ul>";
    }
    html += "</li>";
  }
  return html + "</" + tag + ">";
}

function mdTable(lines) {
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = splitRow(lines[0]);
  let html = "<table><thead><tr>" +
    head.map((c) => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>";
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    html += "<tr>" + cells.map((c) => "<td>" + mdInline(c) + "</td>").join("") + "</tr>";
  }
  return html + "</tbody></table>";
}

/* Returns { html, toc } — toc is a nested <ul> of <h2>/<h3> links, in
   document order, for #help-toc. Heading ids are "help-" + a slug of the
   heading text, so a README anchor link and a Help deep link land on the
   same element. */
function mdToHtml(markdown) {
  const escaped = stripHelpSkipBlocks(escapeHtml(markdown));
  const lines = escaped.split("\n");
  const out = [];
  const toc = []; /* { li: "<li>...", subs: ["<li>...", ...] } — one per h2 */
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++; /* the closing fence */
      out.push("<pre><code>" + code.join("\n") + "</code></pre>");
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const slug = "help-" + slugify(text.replace(/[.*`_]/g, ""));
      out.push("<h" + level + ' id="' + slug + '">' + mdInline(text) + "</h" + level + ">");
      if (level === 2) {
        toc.push({ li: '<li><a href="#' + slug + '">' + text + "</a>", subs: [] });
      } else if (level === 3 && toc.length) {
        toc[toc.length - 1].subs.push('<li><a href="#' + slug + '">' + text + "</a></li>");
      }
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) { out.push("<hr>"); i++; continue; }

    if (/^&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) { quote.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
      out.push("<blockquote><p>" + mdInline(quote.join(" ")) + "</p></blockquote>");
      continue;
    }

    if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const table = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith("|")) { table.push(lines[j]); j++; }
      out.push(mdTable(table));
      i = j;
      continue;
    }

    if (/^-\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const list = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" &&
             !/^(#{1,4})\s/.test(lines[j]) && !lines[j].trim().startsWith("```") &&
             !/^&gt;\s?/.test(lines[j])) {
        list.push(lines[j]); j++;
      }
      out.push(mdList(list));
      i = j;
      continue;
    }

    const para = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() &&
           !/^(#{1,4})\s/.test(lines[j]) && !lines[j].trim().startsWith("```") &&
           !/^-\s+/.test(lines[j]) && !/^\d+\.\s+/.test(lines[j]) && !/^&gt;\s?/.test(lines[j]) &&
           !/^\|.*\|\s*$/.test(lines[j])) {
      para.push(lines[j]); j++;
    }
    out.push("<p>" + mdInline(para.join(" ")) + "</p>");
    i = j;
  }
  const tocHtml = "<ul>" + toc.map((node) =>
    node.li + (node.subs.length ? "<ul>" + node.subs.join("") + "</ul>" : "") + "</li>"
  ).join("") + "</ul>";
  return { html: out.join("\n"), toc: tocHtml };
}

/* Computed once and reused for both markers below, rather than re-parsing
   README.md twice. */
let readmeHelp = null;
function readmeHtml() {
  if (!readmeHelp) readmeHelp = mdToHtml(readFileSync(join(ROOT, "README.md"), "utf8"));
  return readmeHelp;
}

const PARTS = [
  /* Inline, not a line of its own: stamps the release into a <meta> so the
     About box can name a version even on a file:// open, where there is no
     launcher to ask. */
  ["{{VERSION}}", () => readFileSync(join(ROOT, "VERSION"), "utf8")],
  ["{{SEED_CHECK}}", seedCheckValue],
  ["/*{{APP_CSS}}*/", () => src("app.css")],
  ["{{SEED_STATE}}", () => src("seed-state.json")],
  ["{{HELP_TOC}}", () => readmeHtml().toc],
  ["{{README_HTML}}", () => readmeHtml().html],
  ["//{{APP_JS}}", appJs]
];

function build() {
  let html = src("page.html");
  for (const [marker, load] of PARTS) {
    if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/page.html`);
    /* split/join rather than replace(): the content is data and may well
       contain "$&" or "$1", which replace() would expand. */
    html = html.split(marker).join(chomp(load()));
  }
  return html;
}

const out = join(ROOT, "index.html");
const built = build();

if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current === built) {
    console.log("index.html is up to date with src/ (" + Buffer.byteLength(built) + " bytes)");
    process.exit(0);
  }
  console.error("index.html does NOT match src/ — run `node build.mjs`");
  console.error("  built:   " + Buffer.byteLength(built) + " bytes");
  console.error("  on disk: " + Buffer.byteLength(current) + " bytes");
  process.exit(1);
}

writeFileSync(out, built);
console.log("wrote index.html (" + Buffer.byteLength(built) + " bytes)");
