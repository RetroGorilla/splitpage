/* desktop/test/verify-dist-payload.test.mjs: unit tests for
 * desktop/verify-dist-payload.mjs's comparePayloadPeFiles/topLevelPeFiles —
 * the comparison verify-dist.mjs's new "installer payload actually extracts"
 * check is built on.
 *
 * These do not spawn 7-Zip and do not need a real build: they drive the pure
 * comparison function directly against fixture directories, proving it would
 * have caught the 2.0.1 failure (fbd1db2) — an installer payload that
 * extracted every .pak/.dat/.bin/.html correctly and silently dropped every
 * top-level PE binary — without needing an ARM64 machine or a broken 7-Zip
 * build to reproduce it on. verify-dist.mjs's own real end-to-end path
 * (extract the actual setup.exe with 7z.exe + 7za, then run this same
 * function) is exercised by running `node verify-dist.mjs` against a real
 * `npm run dist:win` build, which this suite cannot do headlessly.
 *
 * Node built-ins only. Every case works in its own folder under os.tmpdir()
 * and the whole temp root is removed at the end. Prints ALL PASS and exits
 * 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/verify-dist-payload.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { comparePayloadPeFiles, topLevelPeFiles } = await import(
  pathToFileURL(path.join(here, "..", "verify-dist-payload.mjs"))
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-verify-dist-payload-test-"));
let caseCounter = 0;
function freshDir() {
  const dir = path.join(ROOT, `case-${++caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Writes `name` (size bytes long) into dir, in a subdirectory when name
   contains a "/". Mirrors a real unpacked/extracted app directory closely
   enough for the comparison: some top-level PE files, some non-PE files,
   some files a level deeper that must never be mistaken for top-level. */
function put(dir, name, size) {
  const p = path.join(dir, ...name.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 0x41));
}

/* The real seven from fbd1db2's commit message, standing in for themselves. */
const REAL_BINARIES = [
  ["Splitpage.exe", 4096],
  ["d3dcompiler_47.dll", 1024],
  ["dxcompiler.dll", 2048],
  ["dxil.dll", 512],
  ["ffmpeg.dll", 8192],
  ["vk_swiftshader.dll", 256],
  ["vulkan-1.dll", 128],
];

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("identical top-level PE files, same sizes: no problems", () => {
  const unpacked = freshDir();
  const extracted = freshDir();
  for (const [name, size] of REAL_BINARIES) {
    put(unpacked, name, size);
    put(extracted, name, size);
  }
  // Non-PE files extracted fine either way — not part of this check.
  put(unpacked, "resources.pak", 10);
  put(extracted, "resources.pak", 10);

  const { problems, checked } = comparePayloadPeFiles(unpacked, extracted);
  assert.deepEqual(problems, []);
  assert.equal(checked, REAL_BINARIES.length);
});

test("the 2.0.1 failure: every .pak/.dat/.html extracts, every top-level PE binary is missing", () => {
  const unpacked = freshDir();
  const extracted = freshDir();
  for (const [name, size] of REAL_BINARIES) put(unpacked, name, size);
  put(unpacked, "resources.pak", 10);
  put(unpacked, "icudtl.dat", 10);
  put(unpacked, "locales/en-US.pak", 10);

  // Exactly what fbd1db2 describes the broken NSIS extraction leaving behind:
  // every .pak/.dat/.bin/.html present, every top-level PE binary absent.
  put(extracted, "resources.pak", 10);
  put(extracted, "icudtl.dat", 10);
  put(extracted, "locales/en-US.pak", 10);

  const { problems, checked } = comparePayloadPeFiles(unpacked, extracted);
  assert.equal(checked, REAL_BINARIES.length);
  assert.equal(problems.length, REAL_BINARIES.length, "one problem per dropped binary");
  for (const [name] of REAL_BINARIES) {
    assert.ok(
      problems.some((p) => p.startsWith(`${name} missing`)),
      `expected a problem naming ${name}`
    );
  }
});

test("a partial drop is still caught and named, not averaged away", () => {
  const unpacked = freshDir();
  const extracted = freshDir();
  for (const [name, size] of REAL_BINARIES) put(unpacked, name, size);
  // Only Splitpage.exe survives extraction; its six neighbours don't.
  put(extracted, "Splitpage.exe", 4096);

  const { problems } = comparePayloadPeFiles(unpacked, extracted);
  assert.equal(problems.length, REAL_BINARIES.length - 1);
  assert.ok(!problems.some((p) => p.startsWith("Splitpage.exe")));
  assert.ok(problems.some((p) => p.startsWith("vulkan-1.dll missing")));
});

test("present but truncated is a mismatch, not a pass", () => {
  const unpacked = freshDir();
  const extracted = freshDir();
  put(unpacked, "Splitpage.exe", 4096);
  put(extracted, "Splitpage.exe", 4095);

  const { problems } = comparePayloadPeFiles(unpacked, extracted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Splitpage\.exe is 4095 bytes extracted, 4096 bytes unpacked/);
});

test("a PE file one level down is not top-level and is ignored on both sides", () => {
  const unpacked = freshDir();
  const extracted = freshDir();
  put(unpacked, "Splitpage.exe", 4096);
  put(unpacked, "resources/elevate.exe", 999); // present only in unpacked
  put(extracted, "Splitpage.exe", 4096);

  const { problems, checked } = comparePayloadPeFiles(unpacked, extracted);
  assert.deepEqual(problems, [], "the nested exe is not part of the top-level comparison");
  assert.equal(checked, 1);
});

test("topLevelPeFiles: only top-level .exe/.dll, case-insensitive, non-PE and subdirectories excluded", () => {
  const dir = freshDir();
  put(dir, "Splitpage.EXE", 10);
  put(dir, "ffmpeg.dll", 20);
  put(dir, "resources.pak", 30);
  put(dir, "sub/nested.exe", 40);
  fs.mkdirSync(path.join(dir, "a-directory.exe")); // a directory can share a PE-like name; must not be treated as a file

  const files = topLevelPeFiles(dir);
  assert.deepEqual([...files.keys()].sort(), ["ffmpeg.dll", "splitpage.exe"]);
  assert.equal(files.get("splitpage.exe").name, "Splitpage.EXE", "original casing kept for reporting");
  assert.equal(files.get("ffmpeg.dll").size, 20);
});

/* ------------------------------------------------------------------ */

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (_) {
  /* a leftover temp folder is not a test failure */
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
