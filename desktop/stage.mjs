import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { leakedHooks } from "../tools/release-hooks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STAGE_DIR = resolve(__dirname, ".stage", "splitpage");
const TEST_BUILD = process.argv.includes("--test");

console.log(`Building app (running build.mjs${TEST_BUILD ? " --test" : ""})...`);
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, TEST_BUILD ? ["build.mjs", "--test"] : ["build.mjs"], {
    cwd: REPO_ROOT,
    stdio: "inherit"
  });
  build.on("error", reject);
  build.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`build.mjs exited with code ${code}`));
  });
});

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

try {
  await fs.rm(STAGE_DIR, { recursive: true, force: true });
} catch {
}

await fs.mkdir(STAGE_DIR, { recursive: true });

const files = [
  ["index.html", "index.html"],
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["icon.svg", "icon.svg"],
  ["icon-maskable.svg", "icon-maskable.svg"],
  ["sw.js", "sw.js"],
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

const leaked = leakedHooks(await fs.readFile(resolve(STAGE_DIR, "index.html"), "utf8"));
if (TEST_BUILD) {
  if (!leaked.length) throw new Error("The staged index.html has no test hooks; stage --test expects the test build.");
  console.log(`  test build staged (${leaked.length} hooks a release build leaves out); package it into dist-test/ only, never publish it`);
} else if (leaked.length) {
  throw new Error(`The staged index.html exposes test hooks (${leaked.join(", ")}); stage a release build (node build.mjs, no --test).`);
}

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
for (const filename of ["package.json", "history-policy.ts", "doc-id-policy.ts", "blob-policy.ts", "history-store.ts", "video-embed.ts", "video-path.ts"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "shared", filename));
  await fs.writeFile(resolve(sharedDir, filename), data);
  console.log(`  shared/${filename} (${data.length} bytes)`);
}

console.log(`\nStaging complete. Ready to run: npx electron-builder --config electron-builder.yml`);
