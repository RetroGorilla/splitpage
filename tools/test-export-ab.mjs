import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipWrite } from "../src/adapters/formats/zip.ts";
import { compareMasked, compareOutput, compareRuns, completeness, FORMATS, main, parseArgs, report, zipDifferences } from "./export-ab.mjs";
import { clockProblems, pinnedDateTimeFormat } from "./export-ab-environment.mjs";
import { REPO } from "./source-scan.mjs";

const EXPORT_FACTS_DATE_FORMATS = ["docx", "html", "md", "md-table", "pdf print page"];
const DATE_TEXT_FORMATS = ["b-roll pdf print page", "docx", "html", "md", "md-table", "packing-gear print page", "packing-prop print page", "pdf print page"];

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

const page = (title, stateData, extra = "") => Buffer.concat([
  Buffer.from(`<!doctype html><html><head>${extra}<title>`, "latin1"), Buffer.from(title, "latin1"),
  Buffer.from('</title><meta name="description" content="Three scenes"></head><body><script id="state-data" type="application/json">', "latin1"),
  stateData, Buffer.from("</script></body></html>", "latin1")
]);
const STANDALONE = FORMATS.find((f) => f.id === "html");

test("Standalone HTML compares the title the parser finds, not one inside a comment", async () => {
  const state = Buffer.from('{"title":"A"}');
  const result = await compareOutput(STANDALONE,
    { bytes: page("Script A", state, "<!-- <title>Script A</title> -->") },
    { bytes: page("Script B", state, "<!-- <title>Script A</title> -->") });
  assert.equal(result.same, false);
  assert.equal(result.detail, "title element 1 differs at byte 14 of the element (base 23 bytes, head 23 bytes)");
  const second = await compareOutput(STANDALONE, { bytes: page("Script A", state) }, { bytes: page("Script A", state, "<title>Script A</title>") });
  assert.equal(second.same, false);
  assert.equal(second.detail, "title: base has 1 elements, head 2");
});

test("Standalone HTML compares the state bytes, not their decoded text", async () => {
  const result = await compareOutput(STANDALONE,
    { bytes: page("Script", Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x7d])) },
    { bytes: page("Script", Buffer.from([0x7b, 0x22, 0x81, 0x22, 0x7d])) });
  assert.equal(result.same, false);
  assert.equal(result.detail, "stateData element 1 differs at byte 50 of the element (base 62 bytes, head 62 bytes)");
  const same = await compareOutput(STANDALONE,
    { bytes: page("Script", Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x7d])) },
    { bytes: page("Script", Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x7d])) });
  assert.equal(same.same, true);
  assert.equal(same.info, "page shell around them: base 54 bytes, head 54 bytes");
});

test("the date format pin only fills in the default locale and time zone", () => {
  const Pinned = pinnedDateTimeFormat(Intl.DateTimeFormat);
  const day = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
  const long = { day: "numeric", month: "long", year: "numeric" };
  assert.equal(new Pinned(undefined, long).format(day), "January 2, 2030");
  assert.equal(new Pinned("de-DE", long).format(day), "2. Januar 2030");
  assert.equal(new Pinned(undefined, { hour: "numeric", hourCycle: "h23" }).format(day), "03");
  assert.equal(new Pinned(undefined, { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Tokyo" }).format(day), "12");
});

test("a fixture captured on the wall clock's day is refused, since a stray clock read would not show", () => {
  assert.deepEqual(clockProblems("head", [{ name: "a", clock: { capturedAt: "2026-10-13T17:30:00.000Z", now: "2030-01-02T03:04:05.678Z" } }]), []);
  assert.deepEqual(clockProblems("head", [{ name: "a", clock: { capturedAt: "2030-01-02T00:00:00.000Z", now: "2030-01-02T03:04:05.678Z" } }, { name: "b" }]), [
    "head: a was captured on the day the wall clock reads (2030-01-02T03:04:05.678Z), so a stray clock read would not show",
    "head: b records no capture and wall clock"
  ]);
});

test("a cell with no output is a failure, even when both sides fail the same way", async () => {
  const csv = FORMATS.find((f) => f.id === "csv");
  const both = await compareOutput(csv, { error: "boom" }, { error: "boom" });
  assert.deepEqual(both, { same: false, detail: "no output on both sides: base boom; head boom" });
  assert.deepEqual(await compareOutput(csv, { error: "boom" }, { bytes: Buffer.from("a") }), { same: false, detail: "no output on base: boom" });
  const out = mkdtempSync(join(tmpdir(), "export-ab-cells-"));
  try {
    const clock = { capturedAt: "2026-10-13T17:30:00.000Z", now: "2030-01-02T03:04:05.678Z" };
    for (const side of ["base", "head"]) {
      mkdirSync(join(out, side));
      writeFileSync(join(out, side, "manifest.json"), JSON.stringify({ ...manifestOf([csv]), fixtures: [{ name: "one", clock, outputs: { csv: { error: "boom" } } }] }));
    }
    const result = await compareRuns({ base: join(out, "base"), head: join(out, "head") }, [csv]);
    assert.equal(result.same, false);
    assert.deepEqual(result.cells, [{ format: "csv", fixture: "one", same: false, detail: "no output on both sides: base boom; head boom" }]);
    const text = report("a".repeat(40), "b".repeat(40), result, [csv]);
    assert.match(text, /: DIFFERENCES\./);
    assert.match(text, /\| Spreadsheet \(\.csv\) \| NO OUTPUT \|/);
    assert.match(text, /- csv \/ one: no output on both sides: base boom; head boom/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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
  assert.deepEqual(seen.clocks.map((c) => c.name), seen.fixtures);
  for (const clock of seen.clocks) {
    assert.equal(clock.capturedAt, "2026-10-13T17:30:00.000Z", clock.name);
    assert.equal(clock.now, "2030-01-02T03:04:05.678Z", clock.name);
  }
});

async function plantedRun(edits) {
  const work = mkdtempSync(join(tmpdir(), "export-ab-test-"));
  const plant = join(work, "plant");
  try {
    git(["worktree", "add", "--detach", plant, "HEAD"]);
    for (const [path, from, to] of edits) {
      const file = join(plant, path);
      const text = readFileSync(file, "utf8");
      assert.equal(text.split(from).length, 2, `${path} holds ${from} once`);
      writeFileSync(file, text.replace(from, to));
    }
    git(["add", "-A"], plant);
    const tree = git(["write-tree"], plant);
    const identity = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const planted = git(["commit-tree", tree, "-p", "HEAD", "-m", "Planted export change"], plant, identity);
    git(["worktree", "remove", "--force", plant]);
    let seen;
    const status = await main(["HEAD", planted], REPO, (result) => { seen = result; });
    assert.deepEqual(leftovers(), []);
    return { status, seen };
  } finally {
    if (leftovers().length) git(["worktree", "remove", "--force", plant]);
    rmSync(work, { recursive: true, force: true });
  }
}

const differingFormats = (seen) => [...new Set(seen.cells.filter((c) => !c.same).map((c) => c.format))].sort();

test("an exporter that asks for its own locale is not overridden, so the change shows", async () => {
  const { status, seen } = await plantedRun([
    ["src/adapters/formats/export-kit.ts", "new Intl.DateTimeFormat(undefined, {", 'new Intl.DateTimeFormat("de-DE", {']
  ]);
  assert.equal(status, 1);
  assert.deepEqual(seen.problems, []);
  assert.deepEqual(differingFormats(seen), DATE_TEXT_FORMATS);
});

test("an exporter that reads the wall clock instead of the capture time shows a difference", async () => {
  const { status, seen } = await plantedRun([
    ["src/adapters/formats/export-kit.ts", "const when = new Date(doc.capturedAt);", "const when = new Date();"]
  ]);
  assert.equal(status, 1);
  assert.deepEqual(seen.problems, []);
  assert.deepEqual(differingFormats(seen), EXPORT_FACTS_DATE_FORMATS);
});

test("a one-byte change to an exporter in a scratch commit fails exactly the formats it reaches, and an unlisted export fails completeness", async () => {
  {
    const { status, seen } = await plantedRun([
      ["src/adapters/formats/csv.ts", '"(no b-roll yet)"', '"(no b-roll yeT)"'],
      ["src/adapters/formats/xlsx.ts", 'cellStyle name="Normal"', 'cellStyle name="normal"'],
      ["src/bootstrap/wiring/exporters.ts", '  { id: "txt", writeback: true,', '  { id: "demo", fileName: suffixed(".demo"), build: () => product("demo") },\n  { id: "txt", writeback: true,']
    ]);
    assert.equal(status, 1);
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
  }
});
