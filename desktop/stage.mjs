#!/usr/bin/env node
/**
 * desktop/stage.mjs
 *
 * Prepares the app bundle for packaging:
 * 1. Runs the repo's build (build.mjs) to regenerate index.html
 * 2. Verifies desktop/package.json version matches ../VERSION (single source of truth)
 * 3. Recreates desktop/.stage/splitpage/ with the exact files electron-builder
 *    will embed as extraResources: the allowlist in main.js:protocol.handle(),
 *    the document server, and shared/ (which main.js requires at startup)
 *
 * Run: node stage.mjs (from desktop/)
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STAGE_DIR = resolve(__dirname, ".stage", "splitpage");

/* ---- 1. Run the build ---- */
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

/* ---- 2. Verify version consistency ---- */
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

/* ---- 3. Stage the app bundle ---- */
console.log(`Staging to ${STAGE_DIR}...`);

// Clean out old stage
try {
  await fs.rm(STAGE_DIR, { recursive: true, force: true });
} catch {
  // Ignore
}

// Create stage directory
await fs.mkdir(STAGE_DIR, { recursive: true });

// Files to copy from repo root (the allowlist in main.js:protocol.handle()).
// [source path in the repo, name inside the stage] — the two differ only for
// the user guide, which lives in docs/ but is served flat like everything
// else. It used to be README.md; #80 split the user-facing half out into
// docs/help.md so that editing the repo's README no longer changes what the
// desktop app ships.
const files = [
  ["index.html", "index.html"],
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["icon.svg", "icon.svg"],
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

// tabstrip/ (the splitpage://tabstrip origin's three files — main.js serves
// them from APP_ROOT/tabstrip when packaged, __dirname/tabstrip in dev, and
// its TABSTRIP_ALLOWLIST is exactly this list)
const tabstripDir = resolve(STAGE_DIR, "tabstrip");
await fs.mkdir(tabstripDir, { recursive: true });
for (const filename of ["index.html", "tabstrip.js", "tabstrip.css"]) {
  const data = await fs.readFile(resolve(__dirname, "tabstrip", filename));
  await fs.writeFile(resolve(tabstripDir, filename), data);
  console.log(`  tabstrip/${filename} (${data.length} bytes)`);
}

// voice/ (issue #8): Follow My Voice's listener. powershell.exe runs it by
// path, and a path inside app.asar is not one it can read, so it lives here —
// main.js finds it at APP_ROOT/voice when packaged, __dirname/voice in dev.
const voiceDir = resolve(STAGE_DIR, "voice");
await fs.mkdir(voiceDir, { recursive: true });
for (const filename of ["listen.ps1"]) {
  const data = await fs.readFile(resolve(__dirname, "voice", filename));
  await fs.writeFile(resolve(voiceDir, filename), data);
  console.log(`  voice/${filename} (${data.length} bytes)`);
}

// server/ (subdirectory). package.json travels with server.js and is not
// optional: server.js is CommonJS, the repo root's package.json says
// "type": "module" for the build tooling, and Node resolves the nearest one.
// Stage server.js alone next to a module-typed root and the first require()
// throws.
const serverDir = resolve(STAGE_DIR, "server");
await fs.mkdir(serverDir, { recursive: true });
for (const filename of ["server.js", "package.json"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "server", filename));
  await fs.writeFile(resolve(serverDir, filename), data);
  console.log(`  server/${filename} (${data.length} bytes)`);
}

// shared/ (issue #76). main.js REQUIRES these at startup — the history
// eviction planner, the meta clamps, the duplicate-id rules — so a packaged
// app without them does not launch. They cannot live in the asar beside
// main.js: main.js resolves them from APP_ROOT, which is the repo root in dev
// and resources/splitpage here, and one path has to work in both.
// package.json travels with them for the same reason server/'s does: they are
// CommonJS, the repo root's package.json says "type": "module", and node
// resolves the nearest one. blob-policy.js (#82: the image-record gate, the
// reference walker and the image sniffer) is staged with them because the
// desktop blob store will require it the same way (#82 P3); until then it is
// shipped and unused. history-store.js (#83: the one version-history store,
// over a backend each build supplies) requires history-policy.js and
// doc-id-policy.js by relative path, so all three have to sit side by side
// here; main.js requires it at startup once #83 step 3a lands, and a packaged
// app without it would then fail at that require.
const sharedDir = resolve(STAGE_DIR, "shared");
await fs.mkdir(sharedDir, { recursive: true });
for (const filename of ["package.json", "history-policy.js", "doc-id-policy.js", "blob-policy.js", "history-store.js"]) {
  const data = await fs.readFile(resolve(REPO_ROOT, "shared", filename));
  await fs.writeFile(resolve(sharedDir, filename), data);
  console.log(`  shared/${filename} (${data.length} bytes)`);
}

console.log(`\nStaging complete. Ready to run: npx electron-builder --config electron-builder.yml`);
