import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateRows } from "../src/core/migrate.ts";
import { mergeStates } from "../src/core/merge-states.ts";
import { fakeMigration } from "../tests/core/migrate-ports.ts";
import { fixedClock } from "../tests/core/merge/fakes.ts";

const BASE = "a77f01bf8b3ca4b1334c0c11978594c137f3192e";
const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "paragraph-differential-"));
const clone = value => JSON.parse(JSON.stringify(value));
let seed = 0x1a202611;
const pick = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };

function ports() {
  const migration = fakeMigration();
  return { migrate: migration.ports, ids: migration.ids, clock: fixedClock, editor: () => "Editor",
    decode: html => html ? [{ text: html, marks: {} }] : [] };
}

function raw() {
  const rows = Array.from({ length: 2 + pick(14) }, (_, i) => ({ id: "r" + i, audioText: "beat " + i + " words",
    visualText: pick(2) ? "visual " + i : "", status: ["todo", "ready", "shot"][pick(3)],
    ...(pick(3) ? {} : { lengthSeconds: pick(90) }) }));
  return { schema: 2, docId: "d" + "4".repeat(32), title: "Script " + pick(8), rows,
    ...(pick(2) ? { sections: [{ id: "s", name: "Scene", firstSceneId: rows[1].id }] } : {}) };
}

function edit(source) {
  const doc = clone(source);
  const row = doc.rows[pick(doc.rows.length)];
  if (pick(2)) row.audioText += " changed " + pick(4);
  if (pick(2)) row.visualText = "new visual " + pick(3);
  if (pick(2)) row.lengthSeconds = pick(60); else delete row.lengthSeconds;
  if (pick(3) === 0) doc.rows.splice(pick(doc.rows.length), 1);
  if (pick(3) === 0) doc.rows.reverse();
  if (pick(3) === 0) doc.title += " edit";
  return doc;
}

const BASELINE = `
import { readFileSync } from "node:fs";
import { migrateRows } from "./src/core/migrate.ts";
import { mergeStates } from "./src/core/merge-states.ts";
import { fakeMigration } from "./tests/core/migrate-ports.ts";
import { fixedClock } from "./tests/core/merge/fakes.ts";
const inputs = JSON.parse(readFileSync(0, "utf8"));
const results = inputs.map(({ source, sides }) => {
  const migrated = migrateRows(source, fakeMigration().ports);
  const merges = sides.map(([base, mine, theirs]) => {
    const migration = fakeMigration();
    return mergeStates(base, mine, theirs, { migrate: migration.ports, ids: migration.ids, clock: fixedClock,
      editor: () => "Editor", decode: html => html ? [{ text: html, marks: {} }] : [] });
  });
  return { migrated, merges };
});
process.stdout.write(JSON.stringify(results));
`;

try {
  const archive = execFileSync("git", ["archive", BASE, "src/core", "shared", "package.json", "tests/core"], { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive });
  const inputs = [];
  const current = [];
  for (let i = 0; i < 500; i++) {
    const source = raw();
    const base = migrateRows(clone(source), fakeMigration().ports);
    const mine = edit(base), theirs = edit(base);
    const sides = [base, null].flatMap(ancestor => [[ancestor, mine, theirs], [ancestor, theirs, mine]]);
    inputs.push({ source, sides });
    current.push({ migrated: base, merges: sides.map(([b, m, t]) => mergeStates(clone(b), clone(m), clone(t), ports())) });
  }
  const previous = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", BASELINE], {
    cwd: scratch, input: JSON.stringify(inputs), encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  }));
  current.forEach((result, i) => assert.deepEqual(clone(result), previous[i], "case " + i));
  process.stdout.write(`Paragraph differential against ${BASE}: 500 migrations and 2000 merges passed (seed 0x1a202611).\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
