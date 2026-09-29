import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STAGE_DIR = resolve(__dirname, ".stage", "splitpage");

console.log("Building app (running build.mjs)...");
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, ["build.mjs"], {
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

// Must match electron-builder.yml files and verify-dist expectations
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

const serverDir = resolve(STAGE_DIR, "server");
await fs.mkdir(serverDir, { recursive: true });
for (const filename of ["server.js", "package.json"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "server", filename));
  await fs.writeFile(resolve(serverDir, filename), data);
  console.log(`  server/${filename} (${data.length} bytes)`);
}

const sharedDir = resolve(STAGE_DIR, "shared");
await fs.mkdir(sharedDir, { recursive: true });
for (const filename of ["package.json", "history-policy.js", "doc-id-policy.js", "blob-policy.js", "history-store.js", "video-embed.js"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "shared", filename));
  await fs.writeFile(resolve(sharedDir, filename), data);
  console.log(`  shared/${filename} (${data.length} bytes)`);
}

console.log(`\nStaging complete. Ready to run: npx electron-builder --config electron-builder.yml`);
