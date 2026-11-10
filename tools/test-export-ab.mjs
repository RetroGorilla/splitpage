import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipWrite } from "../src/adapters/formats/zip.ts";
import { compareMasked, compareOutput, completeness, FORMATS, main, parseArgs, zipDifferences } from "./export-ab.mjs";
import { REPO } from "./source-scan.mjs";

const git = (args, cwd = REPO, env = process.env) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const leftovers = () => git(["worktree", "list", "--porcelain"]).split("\n")
  .filter((l) => l.startsWith("worktree ") && /splitpage-export-ab-|export-ab-test-/.test(l));

function manifestOf(formats) {
  const registered = [];
  for (const f of formats) {
    if (f.id === "splitpage-save" || f.id === "md-project") continue;
    const printed = /^(.*) print page$/.exec(f.id);
    registered.push(printed ? { id: printed[1], build: false, printPage: true } : { id: f.id, build: true, printPage: false });
  }
  return { registered, fixtures: [] };
}

test("arguments take a base and an optional head", () => {
  assert.deepEqual(parseArgs(["main"]), { base: "main", head: "HEAD" });
  assert.deepEqual(parseArgs(["main", "topic"]), { base: "main", head: "topic" });
  for (const args of [[], ["a", "b", "c"], ["a", "--keep"]]) assert.throws(() => parseArgs(args));
});

test("an export the app has but the tool does not list fails the completeness check, and so does a stale entry", () => {
  const manifest = manifestOf(FORMATS);
  assert.deepEqual(completeness(manifest, "head"), []);
  manifest.registered.push({ id: "demo-sheet", build: true, printPage: false });
  manifest.registered.push({ id: "demo-list", build: false, printPage: true });
  assert.deepEqual(completeness(manifest, "head"), [
    "head: the app has export demo-sheet, which the tool does not know; add it to FORMATS in tools/export-ab.mjs",
    "head: the app has export demo-list print page, which the tool does not know; add it to FORMATS in tools/export-ab.mjs"
  ]);
  const stale = manifestOf(FORMATS.filter((f) => f.id !== "csv"));
  assert.deepEqual(completeness(stale, "base"), ["base: FORMATS lists csv, which the app no longer produces"]);
});

test("a declared exclusion masks only its own bytes", async () => {
  const created = { format: "demo", field: "created", pattern: /created=\d{4}-\d\d-\d\d/, bytes: 18 };
  const bytes = (text) => Buffer.from(text, "latin1");
  const masked = compareMasked(bytes("created=2030-01-02;body=AAAA"), bytes("created=2031-05-06;body=AAAA"), [created]);
  assert.equal(masked.same, true);
  assert.deepEqual(masked.excluded.base, [{ field: "created", start: 0, end: 18 }]);
  assert.deepEqual(compareMasked(bytes("created=2030-01-02;body=AAAA"), bytes("created=2031-05-06;body=AAAB"), [created]), {
    same: false, offset: 27, excluded: { base: [{ field: "created", start: 0, end: 18 }], head: [{ field: "created", start: 0, end: 18 }] }
  });
  assert.equal(compareMasked(bytes("created=2030-01-02;body"), bytes("created=2030-01-02:body"), [created]).offset, 18);
  assert.equal(compareMasked(bytes("x;created=2030-01-02"), bytes("y;created=2030-01-02"), [created]).offset, 0);
  assert.equal(compareMasked(bytes("created=2030-01-02;created=2030-01-02"), bytes("created=2030-01-02;"), [created]).same, false);
  const greedy = { format: "demo", field: "created", pattern: /created=.*/, bytes: 18 };
  assert.throws(() => compareMasked(bytes("created=2030-01-02;body=AAAA"), bytes("created=2030-01-02;body=AAAB"), [greedy]), /more than its declared 18/);
  const format = { id: "demo", label: "Demo" };
  const outside = await compareOutput(format, { bytes: bytes("created=2030-01-02;body=AAAA") }, { bytes: bytes("created=2031-05-06;body=AABA") }, [created]);
  assert.equal(outside.same, false);
  assert.match(outside.detail, /first difference at offset 26 /);
  const otherFormat = await compareOutput({ id: "other", label: "Other" }, { bytes: bytes("created=2030-01-02") }, { bytes: bytes("created=2031-05-06") }, [created]);
  assert.equal(otherFormat.same, false, "an exclusion applies only to the format that declares it");
});

test("a differing archive names the member and its first differing offset", async () => {
  const day = new Date(Date.UTC(2030, 0, 2));
  const a = Buffer.from(zipWrite([{ name: "one.xml", data: Buffer.from("<a>same</a>") }, { name: "two.xml", data: Buffer.from("<b>before</b>") }], day));
  const b = Buffer.from(zipWrite([{ name: "one.xml", data: Buffer.from("<a>same</a>") }, { name: "two.xml", data: Buffer.from("<b>beFore</b>") }], day));
  assert.deepEqual(await zipDifferences(a, b), ["member two.xml differs at offset 5 (base 13 bytes, head 13 bytes)"]);
  const c = Buffer.from(zipWrite([{ name: "one.xml", data: Buffer.from("<a>same</a>") }], day));
  assert.deepEqual(await zipDifferences(a, c), ["member two.xml only in base"]);
  const result = await compareOutput({ id: "docx", label: "Word" }, { bytes: a }, { bytes: b });
  assert.equal(result.same, false);
  assert.equal(result.detail, "member two.xml differs at offset 5 (base 13 bytes, head 13 bytes)");
});

test("the same commit on both sides is identical in every format and fixture, and the worktrees are removed", async () => {
  let seen;
  assert.equal(await main(["HEAD", "HEAD"], REPO, (result) => { seen = result; }), 0);
  assert.deepEqual(leftovers(), []);
  assert.deepEqual(seen.problems, []);
  assert.deepEqual(seen.formats, FORMATS.map((f) => f.id));
  assert.equal(seen.fixtures.length, 10);
  assert.equal(seen.cells.length, FORMATS.length * 10);
  assert.deepEqual(seen.cells.filter((c) => !c.same), []);
});

test("a one-byte change to an exporter in a scratch commit fails exactly the formats it reaches, and an unlisted export fails completeness", async () => {
  const work = mkdtempSync(join(tmpdir(), "export-ab-test-"));
  const plant = join(work, "plant");
  try {
    git(["worktree", "add", "--detach", plant, "HEAD"]);
    const edit = (path, from, to) => {
      const file = join(plant, path);
      const text = readFileSync(file, "utf8");
      assert.equal(text.split(from).length, 2, `${path} holds ${from} once`);
      writeFileSync(file, text.replace(from, to));
    };
    edit("src/adapters/formats/csv.ts", '"(no b-roll yet)"', '"(no b-roll yeT)"');
    edit("src/adapters/formats/xlsx.ts", 'cellStyle name="Normal"', 'cellStyle name="normal"');
    edit("src/bootstrap/wiring/exporters.ts", '  { id: "txt", writeback: true,', '  { id: "demo", fileName: suffixed(".demo"), build: () => product("demo") },\n  { id: "txt", writeback: true,');
    git(["add", "-A"], plant);
    const tree = git(["write-tree"], plant);
    const identity = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const planted = git(["commit-tree", tree, "-p", "HEAD", "-m", "Planted export change"], plant, identity);
    git(["worktree", "remove", "--force", plant]);
    let seen;
    assert.equal(await main(["HEAD", planted], REPO, (result) => { seen = result; }), 1);
    assert.deepEqual(leftovers(), []);
    assert.deepEqual(seen.problems, ["head: the app has export demo, which the tool does not know; add it to FORMATS in tools/export-ab.mjs"]);
    const differing = seen.cells.filter((c) => !c.same);
    assert.deepEqual([...new Set(differing.map((c) => c.format))].sort(), ["b-roll csv", "b-roll xlsx", "breakdown xlsx", "xlsx"]);
    for (const c of differing.filter((x) => x.format.endsWith("xlsx"))) {
      assert.match(c.detail, /^member xl\/styles\.xml differs at offset \d+ \(base (\d+) bytes, head \1 bytes\)$/);
    }
    for (const c of differing.filter((x) => x.format === "b-roll csv")) {
      assert.match(c.detail, /^first difference at offset \d+ \(base (\d+) bytes, head \1 bytes\)$/);
    }
    assert.ok(seen.cells.filter((c) => c.format === "b-roll csv" && c.same).length > 0, "fixtures with b-roll never write the empty line");
  } finally {
    if (leftovers().length) git(["worktree", "remove", "--force", plant]);
    rmSync(work, { recursive: true, force: true });
  }
});
