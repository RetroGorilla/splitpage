#!/usr/bin/env node
/* Splitpage build.
 *
 * Source lives in src/ as separate files so it can be edited like normal code.
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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(ROOT, "src", name), "utf8");

/* Each marker sits alone on its line in src/page.html. Stripping one trailing
   newline from the inserted file makes the join exact: the marker line's own
   newline becomes the inserted block's last one. */
const chomp = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

const PARTS = [
  ["/*{{APP_CSS}}*/", "app.css"],
  ["{{SEED_STATE}}", "seed-state.json"],
  ["//{{APP_JS}}", "app.js"]
];

function build() {
  let html = src("page.html");
  for (const [marker, file] of PARTS) {
    if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/page.html`);
    /* split/join rather than replace(): the file content is data and may well
       contain "$&" or "$1", which replace() would expand. */
    html = html.split(marker).join(chomp(src(file)));
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
