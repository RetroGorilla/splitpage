import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const chomp = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

function appJs() {
  const result = esbuild.buildSync({
    entryPoints: [join(ROOT, "src", "js", "_entry.js")],
    bundle: true,
    // Not module: 00-prelude must run while parser is paused.
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
  // Bundle is inlined in a script tag; guards early close.
  if (/<\/script/i.test(code)) throw new Error("the bundle contains a literal </script");
  return code;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Must match 20b-onboarding.js checksum exactly; keep in sync.
function checksumText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function seedCheckValue() {
  const seed = JSON.parse(src("seed-state.json"));
  if (seed && typeof seed === "object" && Object.prototype.hasOwnProperty.call(seed, "docId")) {
    throw new Error("seed-state.json must not contain docId — every fresh copy of the app would share one document identity");
  }
  const text = "\n" + chomp(src("seed-state.json")) + "\n";
  return text.length + "-" + checksumText(text);
}

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
  /* eslint-disable-next-line no-control-regex -- the NUL is the sentinel the
     code-span pass at the top of this function wrote; it is chosen precisely
     because the guide's prose can never contain one. */
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => "<code>" + codeSpans[i] + "</code>");
  return text;
}

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

function mdToHtml(markdown) {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split("\n");
  const out = [];
  const toc = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++;
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
        toc.push({ li: '<li><a href="#' + slug + '">' + mdInline(text) + "</a>", subs: [] });
      } else if (level === 3 && toc.length) {
        toc[toc.length - 1].subs.push('<li><a href="#' + slug + '">' + mdInline(text) + "</a></li>");
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

let helpRendered = null;
function helpHtml() {
  if (!helpRendered) helpRendered = mdToHtml(readFileSync(join(ROOT, "docs", "help.md"), "utf8"));
  return helpRendered;
}

const version = () => readFileSync(join(ROOT, "VERSION"), "utf8").trim();

const PARTS = [
  ["{{VERSION}}", version],
  ["{{SEED_CHECK}}", seedCheckValue],
  ["/*{{APP_CSS}}*/", () => src("app.css")],
  ["{{SEED_STATE}}", () => src("seed-state.json")],
  ["{{HELP_TOC}}", () => helpHtml().toc],
  ["{{HELP_HTML}}", () => helpHtml().html],
  ["//{{APP_JS}}", appJs]
];

const CSP_DIRECTIVES = (scriptHash) => [
  "default-src 'self'",
  `script-src 'self' 'sha256-${scriptHash}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'none'"
];

const APP_SCRIPT_OPEN = '<script id="app-logic">';

function asParsed(text) {
  /* eslint-disable-next-line no-control-regex -- matching a NUL is the entire
     point: this is the rewrite the HTML parser makes, reproduced. */
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

const SW_CACHE_LINE = /^var CACHE = "(splitpage-[^"]*)";$/m;
const swCacheName = (text) => SW_CACHE_LINE.exec(text)[1];

function buildSw() {
  const current = readFileSync(join(ROOT, "sw.js"), "utf8");
  if (!SW_CACHE_LINE.test(current)) {
    throw new Error('sw.js: no `var CACHE = "splitpage-<version>";` line for the build to stamp');
  }
  return current.replace(SW_CACHE_LINE, () => 'var CACHE = "splitpage-' + version() + '";');
}

function stripHtmlComments(shell) {
  return shell
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function build() {
  let html = stripHtmlComments(src("page.html"));
  for (const [marker, load] of PARTS) {
    if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/page.html`);
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
  const current = existsSync(out) ? readFileSync(out, "utf8") : null;
  if (current === null) {
    console.error("index.html has not been built yet — run `node build.mjs`");
    stale = true;
  } else if (current === built) {
    console.log("index.html is up to date with src/ (" + Buffer.byteLength(built) + " bytes)");
  } else {
    console.error("index.html does NOT match src/ — run `node build.mjs`");
    console.error("  built:   " + Buffer.byteLength(built) + " bytes");
    console.error("  on disk: " + Buffer.byteLength(current) + " bytes");
    stale = true;
  }
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
