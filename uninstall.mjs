#!/usr/bin/env node
/* Remove a portable Splitpage.
 *
 *   node uninstall.mjs          say what would go, then ask
 *   node uninstall.mjs --yes    don't ask
 *   node uninstall.mjs --dry-run   say what would go and stop
 *
 * If you installed with SplitpageSetup.exe, use Add/Remove Programs instead —
 * that uninstaller also clears the Start Menu entry, which this cannot see.
 *
 * It removes exactly the files listed in .splitpage-release.json, which the
 * packager wrote when this copy was built. Anything else in the folder is
 * yours and is left alone — the one thing an uninstaller must never get wrong
 * is deleting work it did not create.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(ROOT, ".splitpage-release.json");

/* Every path this script touches comes from a key in .splitpage-release.json
   — written by this project's own packager, but a crafted or corrupted copy
   of that file is exactly what an uninstaller must be paranoid about. join()
   alone does not stop "../../.ssh/authorized_keys": it normalizes right out
   of ROOT. So every one of those paths is checked against the resolved root
   before rmSync ever sees it — the one thing this tool must never get wrong
   is deleting something it did not ship. */
function safeJoin(root, rel) {
  const target = resolve(join(root, rel));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`refusing to touch a path outside ${root}: ${rel}`);
  }
  return target;
}

const argv = process.argv.slice(2);
const YES = argv.includes("--yes") || argv.includes("-y");
const DRY = argv.includes("--dry-run");

if (!existsSync(MANIFEST)) {
  console.error(`
  No .splitpage-release.json here, so this is not a packaged Splitpage.

  This script only removes copies made by \`node package.mjs\`. If this is a
  git checkout, delete the folder yourself. If you installed with
  SplitpageSetup.exe, uninstall from Add/Remove Programs.
`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const owned = Object.keys(manifest.files || {});

/* ---------- what is here that we did not ship ---------- */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(relative(ROOT, full).split(/[\\/]/).join("/"));
  }
  return out;
}

const present = walk(ROOT);
const ours = owned.filter((rel) => {
  try { return existsSync(safeJoin(ROOT, rel)); } catch { return false; }
});
const theirs = present.filter((rel) => !owned.includes(rel) && rel !== ".splitpage-release.json");

/* ---------- report ---------- */

console.log(`\n  Splitpage ${manifest.version} in ${ROOT}\n`);
console.log(`  Will remove ${ours.length} file${ours.length === 1 ? "" : "s"}:`);
for (const rel of ours) console.log(`    ${rel}`);
console.log(`    ${".splitpage-release.json"}`);

if (theirs.length) {
  /* Documents are the whole reason this script is careful. In library mode
     they are in data/; a saved script can be anywhere. Either way they are
     not ours to delete, and the user should be told they will remain. */
  console.log(`\n  Will KEEP ${theirs.length} file${theirs.length === 1 ? "" : "s"} that came from you:`);
  for (const rel of theirs.slice(0, 20)) console.log(`    ${rel}`);
  if (theirs.length > 20) console.log(`    ...and ${theirs.length - 20} more`);
  console.log(`\n  Nothing above is touched. Move anything you want to keep out of
  this folder, then delete the folder itself to finish.`);
} else {
  console.log(`\n  Nothing else is in this folder, so it can be deleted afterwards.`);
}

if (DRY) {
  console.log(`\n  --dry-run: nothing was removed.\n`);
  process.exit(0);
}

/* ---------- confirm ---------- */

if (!YES) {
  if (!process.stdin.isTTY) {
    console.error(`\n  Not a terminal, so there is nobody to ask. Re-run with --yes.\n`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\n  Remove these files? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("  Nothing was removed.\n");
    process.exit(0);
  }
}

/* ---------- remove ---------- */

let removed = 0;
const failed = [];
/* This script is listed in the manifest and deletes itself. Node has already
   read it into memory by now, so that is safe — but do it last, so a failure
   partway through still leaves a working uninstaller to re-run. */
const self = relative(ROOT, fileURLToPath(import.meta.url)).split(/[\\/]/).join("/");
const order = [...ours.filter((r) => r !== self), ...ours.filter((r) => r === self)];

for (const rel of order) {
  try {
    rmSync(safeJoin(ROOT, rel));
    removed++;
  } catch (err) {
    failed.push(`${rel}: ${err.message}`);
  }
}
try { rmSync(MANIFEST); } catch { /* already gone */ }

/* Directories we emptied (server/), but never one with anything left in it. */
for (const dir of new Set(ours.map((rel) => dirname(rel)).filter((d) => d !== "."))) {
  let full;
  try { full = safeJoin(ROOT, dir); } catch { continue; }
  try {
    if (existsSync(full) && statSync(full).isDirectory() && !readdirSync(full).length) rmdirSync(full);
  } catch { /* not empty, or gone — either is fine */ }
}

console.log(`\n  Removed ${removed} file${removed === 1 ? "" : "s"}.`);
if (failed.length) {
  console.log(`  Could not remove ${failed.length}:`);
  for (const f of failed) console.log(`    ${f}`);
  console.log(`  A running Splitpage server holds these open — stop it and re-run.`);
}
console.log(theirs.length
  ? `  Your ${theirs.length} file${theirs.length === 1 ? "" : "s"} above are still here.\n`
  : `  The folder is empty now and can be deleted.\n`);
