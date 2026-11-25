import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildSw } from "../build.mjs";
import { writeDesktopBuild } from "../tools/build-preload.mjs";
import { leakedCollaboration, leakedHooks } from "../tools/release-hooks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STAGE_DIR = resolve(__dirname, ".stage", "splitpage");
const DESKTOP_BUILD_DIR = resolve(__dirname, ".stage", "desktop-build");
const DESKTOP_CODE_DIR = resolve(__dirname, ".stage", "desktop-code");
const TEST_BUILD = process.argv.includes("--test");

console.log(`Building app (${TEST_BUILD ? "test" : "release"})...`);
const html = build(TEST_BUILD);

console.log("Verifying version...");
const repoVersionPath = resolve(REPO_ROOT, "VERSION");
const pkgPath = resolve(__dirname, "package.json");

const repoVersionText = await fs.readFile(repoVersionPath, "utf8");
const repoVersion = repoVersionText.trim();

const pkgText = await fs.readFile(pkgPath, "utf8");
const pkg = JSON.parse(pkgText);
const pkgVersion = pkg.version;

if (repoVersion !== pkgVersion) {
  throw new Error(
    `Version mismatch: ../VERSION is "${repoVersion}" but desktop/package.json is "${pkgVersion}". ` +
    `Edit ../VERSION to be the single source of truth, then rebuild.`
  );
}
console.log(`Version OK: ${pkgVersion}`);

console.log(`Staging to ${STAGE_DIR}...`);

await fs.rm(STAGE_DIR, { recursive: true, force: true });
await fs.rm(DESKTOP_BUILD_DIR, { recursive: true, force: true });
await fs.rm(DESKTOP_CODE_DIR, { recursive: true, force: true });
await fs.mkdir(STAGE_DIR, { recursive: true });
await fs.mkdir(DESKTOP_CODE_DIR, { recursive: true });
if (TEST_BUILD) {
  for (const file of ["relay-owner.ts", "relay-setup-window.ts"]) {
    await fs.copyFile(resolve(__dirname, file), resolve(DESKTOP_CODE_DIR, file));
  }
}
writeDesktopBuild(DESKTOP_BUILD_DIR, TEST_BUILD, DESKTOP_CODE_DIR);
await fs.writeFile(resolve(STAGE_DIR, "index.html"), html);
await fs.writeFile(resolve(STAGE_DIR, "sw.js"), buildSw());

const files = [
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["icon.svg", "icon.svg"],
  ["icon-maskable.svg", "icon-maskable.svg"],
  ["docs/help.md", "help.md"],
  ["VERSION", "VERSION"]
];

for (const [from, filename] of files) {
  const src = resolve(REPO_ROOT, from);
  const dst = resolve(STAGE_DIR, filename);
  const data = await fs.readFile(src);
  await fs.writeFile(dst, data);
  console.log(`  ${filename} (${data.length} bytes)`);
}

const leaked = leakedHooks(html);
if (TEST_BUILD) {
  if (!leaked.length) throw new Error("The staged index.html has no test hooks; stage --test expects the test build.");
  console.log(`  test build staged (${leaked.length} hooks a release build leaves out); package it into dist-test/ only, never publish it`);
} else if (leaked.length) {
  throw new Error(`The staged index.html exposes test hooks (${leaked.join(", ")}); stage a release build (node build.mjs, no --test).`);
}
if (!TEST_BUILD && leakedCollaboration(html).length) throw new Error("The staged release exposes collaboration.");

const tabstripDir = resolve(STAGE_DIR, "tabstrip");
await fs.mkdir(tabstripDir, { recursive: true });
for (const filename of ["index.html", "tabstrip.js", "tabstrip.css"]) {
  const data = await fs.readFile(resolve(__dirname, "tabstrip", filename));
  await fs.writeFile(resolve(tabstripDir, filename), data);
  console.log(`  tabstrip/${filename} (${data.length} bytes)`);
}

const voiceDir = resolve(STAGE_DIR, "voice");
await fs.mkdir(voiceDir, { recursive: true });
for (const filename of ["listen.ps1"]) {
  const data = await fs.readFile(resolve(__dirname, "voice", filename));
  await fs.writeFile(resolve(voiceDir, filename), data);
  console.log(`  voice/${filename} (${data.length} bytes)`);
}

const sharedDir = resolve(STAGE_DIR, "shared");
await fs.mkdir(sharedDir, { recursive: true });
for (const filename of ["package.json", "history-policy.ts", "doc-id-policy.ts", "blob-policy.ts", "history-store.ts", "video-embed.ts", "video-path.ts", "native-membership.ts", "shared-script.ts"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "shared", filename));
  await fs.writeFile(resolve(sharedDir, filename), data);
  console.log(`  shared/${filename} (${data.length} bytes)`);
}

console.log(`\nStaging complete. Ready to run: npx electron-builder --config electron-builder.yml`);
