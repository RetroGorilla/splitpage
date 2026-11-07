import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { comparePayloadPeFiles, topLevelPeFiles, requiredSharedFiles, missingSharedFiles } = await import(
  pathToFileURL(path.join(here, "..", "verify-dist-payload.mjs"))
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-verify-dist-payload-test-"));
let caseCounter = 0;
function freshDir() {
  const dir = path.join(ROOT, `case-${++caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir, name, size) {
  const p = path.join(dir, ...name.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 0x41));
}

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
  put(unpacked, "resources/elevate.exe", 999);
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
  fs.mkdirSync(path.join(dir, "a-directory.exe"));

  const files = topLevelPeFiles(dir);
  assert.deepEqual([...files.keys()].sort(), ["ffmpeg.dll", "splitpage.exe"]);
  assert.equal(files.get("splitpage.exe").name, "Splitpage.EXE", "original casing kept for reporting");
  assert.equal(files.get("ffmpeg.dll").size, 20);
});

test("requiredSharedFiles: what the main process requires from shared/, what that imports as a value, and package.json", () => {
  const desktop = freshDir();
  const shared = freshDir();
  fs.writeFileSync(path.join(desktop, "main.ts"), 'const a = require(path.join(SHARED_ROOT, "a.ts"));\nconst b = require(path.join(SHARED_ROOT, "b.ts"));\n');
  fs.writeFileSync(path.join(desktop, "other.ts"), 'import type * as T from "../shared/typed-only.ts";\n');
  fs.writeFileSync(path.join(desktop, "contract.d.ts"), 'const c = require(path.join(SHARED_ROOT, "ignored.ts"));\n');
  fs.writeFileSync(path.join(shared, "a.ts"), 'import * as c from "./c.ts";\nimport type { T } from "./types-only.ts";\nimport { d } from "./d.ts";\n');
  fs.writeFileSync(path.join(shared, "b.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(shared, "c.ts"), 'import { d } from "./d.ts";\n');
  fs.writeFileSync(path.join(shared, "d.ts"), "export const d = 1;\n");
  assert.deepEqual(requiredSharedFiles(desktop, shared), ["a.ts", "b.ts", "c.ts", "d.ts", "package.json"]);
});

test("missingSharedFiles names every file the package lacks", () => {
  const packaged = freshDir();
  put(packaged, "package.json", 1);
  put(packaged, "history-store.ts", 1);
  assert.deepEqual(missingSharedFiles(packaged, ["history-policy.ts", "history-store.ts", "package.json", "video-embed.ts"]), ["history-policy.ts", "video-embed.ts"]);
});

test("the shared files stage.mjs stages cover everything the main process loads", () => {
  const needed = requiredSharedFiles(path.join(here, ".."), path.join(here, "..", "..", "shared"));
  const stage = fs.readFileSync(path.join(here, "..", "stage.mjs"), "utf8");
  const staged = /for \(const filename of \[([^\]]*)\]\) \{\s*const data = await fs\.readFile\(resolve\(REPO_ROOT, "shared"/.exec(stage);
  assert.ok(staged, "stage.mjs no longer lists its shared files in the form this test reads");
  const names = [...staged[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(needed.filter((name) => !names.includes(name)), []);
});

function peHeader(machine) {
  const head = Buffer.alloc(0x46);
  head.writeUInt16LE(0x5a4d, 0);
  head.writeUInt32LE(0x40, 0x3c);
  head.writeUInt32LE(0x00004550, 0x40);
  head.writeUInt16LE(machine, 0x44);
  return head;
}

function verifyDist(dist) {
  const run = spawnSync(process.execPath, [path.join(here, "..", "verify-dist.mjs"), "--dist", dist, "--arch", "x64", "--version", "0.0.0"], { encoding: "utf8" });
  return run.stdout;
}

test("verify-dist fails a package whose shared/ files are missing, and passes one that has them", () => {
  const dist = freshDir();
  const app = path.join(dist, "win-unpacked");
  fs.mkdirSync(path.join(app, "resources", "splitpage"), { recursive: true });
  fs.writeFileSync(path.join(app, "Splitpage.exe"), peHeader(0x8664));
  const label = "x64: every shared/ file the main process loads is packaged";
  assert.match(verifyDist(dist), new RegExp("FAIL  " + label + "  \\(missing: .*history-store\\.ts"));
  const sharedOut = path.join(app, "resources", "splitpage", "shared");
  fs.mkdirSync(sharedOut, { recursive: true });
  const needed = requiredSharedFiles(path.join(here, ".."), path.join(here, "..", "..", "shared"));
  for (const name of needed) fs.copyFileSync(path.join(here, "..", "..", "shared", name), path.join(sharedOut, name));
  assert.match(verifyDist(dist), new RegExp("ok    " + label));
  fs.rmSync(path.join(sharedOut, needed[0]));
  assert.match(verifyDist(dist), new RegExp("FAIL  " + label + "  \\(missing: " + needed[0].replace(".", "\\.")));
});

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
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
