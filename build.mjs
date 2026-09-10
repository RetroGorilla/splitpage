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

const PARTS = [
  /* Inline, not a line of its own: stamps the release into a <meta> so the
     About box can name a version even on a file:// open, where there is no
     launcher to ask. */
  ["{{VERSION}}", () => readFileSync(join(ROOT, "VERSION"), "utf8")],
  ["/*{{APP_CSS}}*/", () => src("app.css")],
  ["{{SEED_STATE}}", () => src("seed-state.json")],
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
