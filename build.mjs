#!/usr/bin/env node
/* Splitpage build.
 *
 * Source lives in src/ as separate files so it can be edited like normal code:
 * page.html (shell), app.css, seed-state.json (the demo document) and the
 * numbered ES modules in src/js/.
 * The SHIPPED app is a single index.html, and that is not a packaging
 * preference — it is load-bearing. A save writes
 *   "<!doctype html>" + document.documentElement.outerHTML
 * with the new document spliced into #state-data (see buildPublishHtml in
 * src/js/02-state.js). If the page linked out to app.css / app.js, every
 * saved .splitpage.html would be a shell that only works next to those files.
 * So we inline everything back into one self-contained page here.
 *
 * Substitution of a handful of marker lines, plus one bundler. Two outputs:
 * index.html, and sw.js, which cannot be inlined into it (a service worker
 * has to have its own URL) and so is stamped in place — see "sw.js (#79)".
 *   node build.mjs           write index.html and stamp sw.js
 *   node build.mjs --check   verify both are current (exit 1 if not)
 *
 * esbuild is the only dependency, and it is a build-time one: nothing it
 * produces needs a runtime, and the shipped page still has no <script src>.
 * `npm install` (or `npm ci`) before either command.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Imported this way, rather than at the top, so a checkout that has not run
   `npm install` yet gets told what is wrong instead of a module-resolution
   stack trace. CI and desktop/stage.mjs both shell out to this file. */
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error("esbuild is not installed — run `npm install` first.");
  console.error("(src/js has been bundled rather than concatenated since #66.)");
  process.exit(1);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(ROOT, "src", name), "utf8");

/* Each marker sits alone on its line in src/page.html. Stripping one trailing
   newline from the inserted file makes the join exact: the marker line's own
   newline becomes the inserted block's last one. */
const chomp = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/* src/js/*.js are ES modules (#66). They used to be fragments of one IIFE,
   concatenated in filename order — which is why they are still numbered: the
   numbers are the order src/js/_entry.js calls their __init()s in, and that
   is the app's boot order. Nothing else depends on the filenames now, so a
   rename costs an edit to _entry.js and the imports that name the file.

   One esbuild call, no plugins and no config file, producing one IIFE with
   everything in it — the same shape the concatenated fragments had, which is
   what lets it be inlined into the page exactly as before.

   - bundle: follow the imports from _entry.js; nothing is left external.
   - format iife: a classic script, not a module. <script type="module"> is
     deferred, and 00-prelude has to capture PAGE_SHELL while the parser is
     still paused on this tag (that is the whole reason the page is one file).
   - minify: names, whitespace and dead code. The window.__* test backdoors
     survive it because they are property assignments, not bindings.
   - charset utf8: leave the app's text alone rather than re-escaping every
     non-ASCII character. The page is <meta charset="utf-8"> and the CSP hash
     below is taken over the same characters the parser will see.
   - legalComments none: keep the output a single pure line of JS, so the
     hash and the byte count only move when the source does. */
function appJs() {
  const result = esbuild.buildSync({
    entryPoints: [join(ROOT, "src", "js", "_entry.js")],
    bundle: true,
    format: "iife",
    minify: true,
    charset: "utf8",
    legalComments: "none",
    absWorkingDir: ROOT,
    logLevel: "warning",
    write: false
  });
  if (result.outputFiles.length !== 1) {
    throw new Error("esbuild produced " + result.outputFiles.length + " files, expected 1");
  }
  const code = result.outputFiles[0].text;
  /* The bundle is inlined into <script id="app-logic">, so an unescaped
     "</script" anywhere in it would end the tag early and leave the rest of
     the app as text on the page. esbuild escapes the sequence inside string
     literals; this is the guard for everything else. */
  if (/<\/script/i.test(code)) throw new Error("the bundle contains a literal </script");
  return code;
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
  /* The seed is copied into every fresh copy of the app, so a docId in it
     would give every new document everywhere the same identity — one shared
     version history for strangers' scripts. migrateRows mints a random id at
     boot instead (src/js/02b-doc-id.js). */
  const seed = JSON.parse(src("seed-state.json"));
  if (seed && typeof seed === "object" && Object.prototype.hasOwnProperty.call(seed, "docId")) {
    throw new Error("seed-state.json must not contain docId — every fresh copy of the app would share one document identity");
  }
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
      /* A blank line normally ends a list, but README also uses blank lines
         to separate ordered items that carry a trailing paragraph or nested
         bullets. So a blank line doesn't end the list by itself — only when
         nothing after it (skipping further blank lines) continues the list:
         another item at the same marker, or an indented continuation line. */
      const itemRe = /^\d+\.\s+/.test(line) ? /^\d+\.\s+/ : /^-\s+/;
      const list = [line];
      let j = i + 1;
      while (j < lines.length) {
        const cur = lines[j];
        if (cur.trim() === "") {
          let k = j + 1;
          while (k < lines.length && lines[k].trim() === "") k++;
          const next = lines[k];
          if (k < lines.length && (itemRe.test(next) || /^\s{2,}\S/.test(next))) { j = k; continue; }
          break;
        }
        if (/^(#{1,4})\s/.test(cur) || cur.trim().startsWith("```") || /^&gt;\s?/.test(cur)) break;
        list.push(cur); j++;
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

/* VERSION is one line. Two different outputs splice it in — index.html's
   <meta> and sw.js's cache name — and only one of them goes through chomp(),
   so trim it here rather than leaving the second one to inherit whatever
   line ending an editor left behind. */
const version = () => readFileSync(join(ROOT, "VERSION"), "utf8").trim();

const PARTS = [
  /* Inline, not a line of its own: stamps the release into a <meta> so the
     About box can name a version even on a file:// open, where there is no
     launcher to ask. */
  ["{{VERSION}}", version],
  ["{{SEED_CHECK}}", seedCheckValue],
  ["/*{{APP_CSS}}*/", () => src("app.css")],
  ["{{SEED_STATE}}", () => src("seed-state.json")],
  ["{{HELP_TOC}}", () => readmeHtml().toc],
  ["{{README_HTML}}", () => readmeHtml().html],
  ["//{{APP_JS}}", appJs]
];

/* ---------- the Content Security Policy (#65) ----------

   Substituted last, because the one directive that cannot be written by hand
   is the hash of the app's own inline script — which does not exist until
   every other marker has been filled in.

   What each directive is holding back, in a page whose whole job is to parse
   somebody else's script file and put it in a contenteditable:

   default-src 'self'   everything not named below, from this page's own
                        origin only. Under file:// that origin matches almost
                        nothing, which is the right default for a copy opened
                        by double-clicking it.
   script-src           the inline app, by the SHA-256 of its body, plus
                        'self' for sw.js. Nothing else runs: not an injected
                        <script>, not an onerror= on a pasted <img>, not a
                        javascript: href sanitizeHtml missed.
   style-src            'unsafe-inline' because the app sets style attributes
                        (the drag ghost, panel widths, the teleprompter's
                        transform), and Google Fonts for the one stylesheet.
   font-src             the same, plus data: for anything embedded.
   img-src              'self' data: blob: — every image in a document is a
                        data: URI (safeImageSrc allows nothing else) and
                        exports build blob: URLs.
   connect-src          this origin, and any http(s) server the user points
                        File > Servers... at, which is a documented feature
                        and includes a LAN address over plain http. Narrower
                        than '*': ws:, data: and the rest stay refused.
   object-src 'none'    the app has no plugins.
   frame-src 'self'     the app never creates a frame; 24-history.txt does,
                        to run a second copy of the app in this origin and
                        race it against the first over one IndexedDB store.
                        'none' would be tidier and buys nothing: walkSanitize
                        drops an <iframe> from every untrusted path, so the
                        only way to get one into this page is to be running
                        script in it already.
   worker-src 'self'    the service worker that makes a hosted copy work
                        offline, and nothing else. Named explicitly, or it
                        falls back to child-src and from there to default-src.
   base-uri 'self'      an injected <base> cannot re-point every relative URL
                        on the page.
   form-action 'none'   the app has no <form> at all.

   frame-ancestors is deliberately absent: browsers ignore it in a meta
   policy. desktop/main.js adds it to the header it serves, where it works. */
const CSP_DIRECTIVES = (scriptHash) => [
  "default-src 'self'",
  `script-src 'self' 'sha256-${scriptHash}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "frame-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'none'"
];

const APP_SCRIPT_OPEN = '<script id="app-logic">';

/* The hash has to be taken over exactly the characters the browser will treat
   as the script's body — everything between the open tag's ">" and the
   closing tag, newlines included, AFTER the two rewrites the HTML parser
   makes to script data on the way in. Both are silent and both are
   length-preserving in UTF-16, so getting them wrong produces a policy that
   looks right, hashes to something else, and refuses to run the app.

   A raw NUL in a source file is the one that actually happened
   (08c-broll.js used one as a key separator), and it is escaped there now —
   this normalisation is the guard that stops the next one being a puzzle. */
function asParsed(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
}

export function inlineScriptBody(html) {
  const i = html.indexOf(APP_SCRIPT_OPEN);
  if (i === -1) throw new Error("the app's inline script is missing from src/page.html");
  const from = i + APP_SCRIPT_OPEN.length;
  const j = html.indexOf("</" + "script>", from);
  if (j === -1) throw new Error("the app's inline script is never closed");
  return html.slice(from, j);
}

export function buildCsp(html) {
  const hash = createHash("sha256").update(asParsed(inlineScriptBody(html)), "utf8").digest("base64");
  return CSP_DIRECTIVES(hash).join("; ");
}

/* ---------- sw.js (#79) ----------
 *
 * The service worker is the one shipped file that is NOT inlined into
 * index.html, and it cannot be: a worker has to have its own URL or the
 * browser will not register it. So package.mjs, the Dockerfile and
 * desktop/stage.mjs all copy the repo-root sw.js out verbatim, and there is
 * no template for it to be spliced into on the way past.
 *
 * It is therefore stamped IN PLACE. sw.js in the tree is both the file you
 * edit and the artifact that ships, and exactly one line of it belongs to
 * this build: the cache name, which has to carry VERSION so that a deploy
 * renames the cache and the worker's activate handler drops the previous
 * release's entries (the whole of issue #79 — see sw.js's own header).
 *
 * --check is meaningful for it in the way that matters: what it catches is
 * VERSION and sw.js having drifted apart, which is the only way this file
 * can be wrong, and it is exactly the failure a version bump committed on
 * its own would otherwise ship. It cannot catch a hand-edit elsewhere in
 * sw.js, because there is no other source for the rest of the file to
 * disagree with.
 */
const SW_CACHE_LINE = /^var CACHE = "(splitpage-[^"]*)";$/m;
const swCacheName = (text) => SW_CACHE_LINE.exec(text)[1];

function buildSw() {
  const current = readFileSync(join(ROOT, "sw.js"), "utf8");
  if (!SW_CACHE_LINE.test(current)) {
    throw new Error('sw.js: no `var CACHE = "splitpage-<version>";` line for the build to stamp');
  }
  /* A function replacement, not "$1...$2": VERSION is data, and replace()
     would expand a "$&" in it — the same reason build() splits and joins. */
  return current.replace(SW_CACHE_LINE, () => 'var CACHE = "splitpage-' + version() + '";');
}

function build() {
  let html = src("page.html");
  for (const [marker, load] of PARTS) {
    if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/page.html`);
    /* split/join rather than replace(): the content is data and may well
       contain "$&" or "$1", which replace() would expand. */
    html = html.split(marker).join(chomp(load()));
  }
  if (!html.includes("{{CSP}}")) throw new Error("marker {{CSP}} missing from src/page.html");
  return html.split("{{CSP}}").join(buildCsp(html));
}

const out = join(ROOT, "index.html");
const built = build();
const swOut = join(ROOT, "sw.js");
const swBuilt = buildSw();

if (process.argv.includes("--check")) {
  let stale = false;
  const current = readFileSync(out, "utf8");
  if (current === built) {
    console.log("index.html is up to date with src/ (" + Buffer.byteLength(built) + " bytes)");
  } else {
    console.error("index.html does NOT match src/ — run `node build.mjs`");
    console.error("  built:   " + Buffer.byteLength(built) + " bytes");
    console.error("  on disk: " + Buffer.byteLength(current) + " bytes");
    stale = true;
  }
  /* Reported separately, and both are reported, so a run that is wrong twice
     does not have to be fixed twice to find that out. */
  const swCurrent = readFileSync(swOut, "utf8");
  if (swCurrent === swBuilt) {
    console.log("sw.js is stamped with VERSION (cache " + swCacheName(swBuilt) + ")");
  } else {
    console.error("sw.js's cache name does NOT match VERSION — run `node build.mjs`");
    console.error("  built:   " + swCacheName(swBuilt));
    console.error("  on disk: " + swCacheName(swCurrent));
    stale = true;
  }
  process.exit(stale ? 1 : 0);
}

writeFileSync(out, built);
console.log("wrote index.html (" + Buffer.byteLength(built) + " bytes)");
writeFileSync(swOut, swBuilt);
console.log("wrote sw.js (cache " + swCacheName(swBuilt) + ")");
