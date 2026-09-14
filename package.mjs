#!/usr/bin/env node
/* Splitpage release packager.
 *
 *   node package.mjs              build dist/splitpage-<version>/ and the .zip
 *   node package.mjs --installer  ...and build SplitpageSetup-<version>.exe
 *
 * The installer needs NOTHING installed to build. It is a self-extracting
 * archive made by iexpress.exe, which ships with Windows, wrapping a zip
 * payload and installer/install.ps1. That payload carries its own node.exe,
 * so the person who runs it downloads one file and is finished — no second
 * trip for a runtime before they can host a shared session.
 *
 * The zip IS the portable app: unzip it anywhere and run start.bat (Windows)
 * or ./start.sh (macOS/Linux). Nothing is compiled and nothing is installed,
 * so this also serves as the "no build tools" path for people who do not want
 * installer/splitpage.iss and a real setup.exe.
 *
 * Deliberately excluded: src/ and build.mjs (a release ships the built page,
 * not the parts), and the hosting files (Dockerfile, DEPLOY.md), which are a
 * different job with a different audience.
 *
 * The zip is written here rather than shelled out to, because this has to
 * produce the same bytes on the Windows machine that cuts releases as on a
 * Linux CI box, and neither `zip` nor Compress-Archive is on both.
 */

import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
let releaseConfig = {};
try {
  releaseConfig = JSON.parse(readFileSync(join(ROOT, "release.json"), "utf8"));
} catch {
  // release.json is optional; updateApi defaults to current hard-coded value
}

/* ---------- build first ---------- */

const built = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
if (built.status !== 0) {
  console.error("Build failed — not packaging.");
  process.exit(1);
}

/* ---------- stage ---------- */

/* Executable bits matter: start.sh has to stay runnable after a round trip
   through the zip, or macOS and Linux users get "permission denied". */
const FILES = [
  ["index.html", 0o644],
  ["manifest.webmanifest", 0o644],
  ["icon.svg", 0o644],
  ["sw.js", 0o644],
  ["server/server.js", 0o644],
  ["start.mjs", 0o644],
  ["start.bat", 0o644],
  ["start.ps1", 0o644],
  ["start.sh", 0o755],
  ["uninstall.mjs", 0o644],
  ["uninstall.bat", 0o644],
  ["uninstall.sh", 0o755],
  ["update.mjs", 0o644],
  /* Shipped in the portable zip so an unzipped copy can put itself in the
     Start Menu without downloading the installer: the app's setup step calls
     the launcher's loopback-only register endpoint, which runs this with
     -InPlace. Nothing runs it at unzip time. */
  ["installer/install.ps1", 0o644],
  ["README.md", 0o644],
  ["VERSION", 0o644]
];

const NAME = `splitpage-${VERSION}`;
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, NAME);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const [rel] of FILES) {
  const from = join(ROOT, rel);
  if (!existsSync(from)) {
    console.error(`missing: ${rel}`);
    process.exit(1);
  }
  const to = join(STAGE, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

/* ---------- release manifest ----------
 *
 * A record of exactly what this release consists of, shipped inside it. The
 * uninstaller removes the files listed here and nothing else, so it can never
 * take something the user put in the folder themselves; the updater compares
 * these hashes to spot files you have hand-edited before it overwrites them.
 */

const MANIFEST_NAME = ".splitpage-release.json";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const manifest = {
  name: "Splitpage",
  version: VERSION,
  ...(releaseConfig.updateApi && { updateApi: releaseConfig.updateApi }),
  files: Object.fromEntries(
    FILES.map(([rel, mode]) => [rel, { sha256: sha256(readFileSync(join(STAGE, rel))), mode }])
  )
};
writeFileSync(join(STAGE, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

/* Everything that goes in the zip: the payload plus the manifest describing it. */
const ENTRIES = [...FILES, [MANIFEST_NAME, 0o644]];

/* ---------- zip ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* MS-DOS date/time. Fixed, not "now": a release built twice from the same
   commit should be the same file, and a timestamp is the one thing that would
   stop it. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function makeZip(prefix, entries, read) {
const locals = [];
const central = [];
let offset = 0;

for (const [rel, mode] of entries) {
  /* Zip paths are always forward-slashed, whatever the host OS. */
  const nameBuf = Buffer.from(`${prefix}/${rel.split(/[\\/]/).join("/")}`, "utf8");
  const raw = read(rel);
  const deflated = deflateRawSync(raw, { level: 9 });
  /* Only claim compression if it actually helped. */
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          /* version needed */
  local.writeUInt16LE(0, 6);           /* flags */
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);          /* extra */
  locals.push(local, nameBuf, data);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  /* 3 = Unix in the upper byte, so the permission bits below are honoured. */
  dir.writeUInt16LE((3 << 8) | 20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt32LE(raw.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30);            /* extra */
  dir.writeUInt16LE(0, 32);            /* comment */
  dir.writeUInt16LE(0, 34);            /* disk */
  dir.writeUInt16LE(0, 36);            /* internal attrs */
  dir.writeUInt32LE(((0o100000 | mode) >>> 0) * 0x10000, 38); /* external attrs */
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

return Buffer.concat([...locals, centralBuf, eocd]);
}

const zipPath = join(DIST, `${NAME}.zip`);
writeFileSync(zipPath, makeZip(NAME, ENTRIES, (rel) => readFileSync(join(STAGE, rel))));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`\n  ${STAGE}`);
console.log(`  ${zipPath}  (${kb(statSync(zipPath).size)})`);

/* ---------- optional: the Windows installer ---------- */

if (process.argv.includes("--installer")) {
  const { fetchRuntime } = await import("./tools/fetch-runtime.mjs");

  /* ---------- the extractor stub's own architecture ----------
   *
   * IExpress does not cross-build. The self-extractor it produces is a copy of
   * the wextract stub belonging to the iexpress.exe that ran, so a setup
   * inherits the architecture of the build machine's binary and NOT of the
   * payload it wraps. On Windows on ARM, System32\iexpress.exe is ARM64, and
   * the x64 setup it builds is an ARM64 program wrapped around an x64 payload:
   * Windows refuses it on an x64 PC with "This app can't run on your PC" long
   * before install.ps1 — and its own architecture check — gets to run. 1.0.1
   * shipped exactly that.
   *
   * SysWOW64 holds the 32-bit x86 copy, present on x64 and on ARM64 Windows
   * alike, and an x86 stub starts everywhere: natively on x86, under WOW64 on
   * x64, under emulation on ARM64. So prefer it and leave the architecture to
   * the payload, which is what the per-arch SED already decides. A 32-bit stub
   * also spawns 32-bit powershell.exe, which is safe here only because
   * install.ps1 reads the machine's architecture from the registry rather than
   * from $env:PROCESSOR_ARCHITECTURE.
   */
  const IEXPRESS = (() => {
    const root = process.env.SystemRoot || "C:\\Windows";
    for (const dir of ["SysWOW64", "System32"]) {
      const exe = join(root, dir, "iexpress.exe");
      if (existsSync(exe)) return exe;
    }
    /* Not Windows, or a layout we do not know: let PATH answer, and let the
       ENOENT below explain itself. */
    return "iexpress";
  })();

  const PE_MACHINE = { 0x014c: "x86", 0x8664: "x64", 0xaa64: "arm64" };

  /* Which stubs a PC of a given architecture can actually start: x86 runs
     everywhere, x64 runs on x64 and emulated on ARM64, ARM64 only on ARM64. */
  const RUNS_ON = { x64: ["x86", "x64"], arm64: ["x86", "x64", "arm64"] };

  /* The PE machine field, which is what Windows checks before it will load the
     file at all. MZ at 0, e_lfanew at 0x3C, "PE\0\0", then the machine word. */
  function stubMachine(exe) {
    const buf = readFileSync(exe);
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;
    const off = buf.readUInt32LE(0x3c);
    if (off + 6 > buf.length || buf.readUInt32LE(off) !== 0x00004550) return null;
    const machine = buf.readUInt16LE(off + 4);
    return PE_MACHINE[machine] || `0x${machine.toString(16).padStart(4, "0")}`;
  }

  /* --arch x64 (default) | arm64 | both. "both" builds one setup per
     architecture, each carrying only its own runtime: an x64 user should not
     download an 87 MB ARM binary they can never run. */
  const archIdx = process.argv.indexOf("--arch");
  const archArg = archIdx === -1 ? "x64" : String(process.argv[archIdx + 1] || "");
  if (!["x64", "arm64", "both"].includes(archArg)) {
    console.error("--arch must be x64, arm64 or both");
    process.exit(1);
  }
  const archs = archArg === "both" ? ["x64", "arm64"] : [archArg];

  async function buildSetup(arch) {
    /* The payload is the portable release plus the things only an installed
       copy needs: the runtime(s), the icon the shortcuts point at, and the
       uninstaller that Add/Remove Programs will call. */
    const payloadEntries = [
      ...ENTRIES,
      [`runtime/node-${arch}.exe`, 0o755],
      ["icon.ico", 0o644],
      ["uninstall.ps1", 0o644]
    ];
    const extra = {};
    {
      const a = arch;
      extra[`runtime/node-${a}.exe`] = await fetchRuntime({ arch: a, log: (m) => console.log(m) });
    }
    extra["icon.ico"] = join(ROOT, "installer", "icon.ico");
    extra["uninstall.ps1"] = join(ROOT, "installer", "uninstall.ps1");

    const payloadFile = (rel) => readFileSync(extra[rel] || join(STAGE, rel));

    /* The manifest has to describe THIS release, not the portable one. */
    const payloadManifest = Buffer.from(JSON.stringify({
      name: "Splitpage",
      version: VERSION,
      ...(releaseConfig.updateApi && { updateApi: releaseConfig.updateApi }),
      files: Object.fromEntries(
        payloadEntries
          .filter(([rel]) => rel !== MANIFEST_NAME)
          .map(([rel, mode]) => [rel, { sha256: sha256(payloadFile(rel)), mode }])
      )
    }, null, 2) + "\n");

    const payload = makeZip(NAME, payloadEntries, (rel) =>
      rel === MANIFEST_NAME ? payloadManifest : payloadFile(rel));
    const payloadPath = join(DIST, `splitpage-payload-${arch}.zip`);
    writeFileSync(payloadPath, payload);
    console.log(`  payload (${arch}): ${(payload.length / 1024 / 1024).toFixed(0)} MB`);

    /* install.ps1 with the version stamped in */
    /* Named install.ps1 because that is what AppLaunched and the quiet commands
       run inside the extractor. Its content is the same for every arch. */
    const installPs1 = join(DIST, "install.ps1");
    writeFileSync(installPs1,
      readFileSync(join(ROOT, "installer", "install.ps1"), "utf8").split("@VERSION@").join(VERSION));

    const setupPath = join(DIST, `SplitpageSetup-${VERSION}-${arch}.exe`);

    /* Build the SED for this architecture */
    const win = (p) => p.split("/").join("\\");
    const sed = [
      "[Version]",
      "Class=IEXPRESS",
      "SEDVersion=3",
      "[Options]",
      "PackagePurpose=InstallApp",
      "ShowInstallProgramWindow=1",
      "HideExtractAnimation=1",
      "UseLongFileName=1",
      "InsideCompressed=0",
      "CAB_FixedSize=0",
      "CAB_ResvCodeSigning=0",
      "RebootMode=N",
      "InstallPrompt=%InstallPrompt%",
      "DisplayLicense=%DisplayLicense%",
      "FinishMessage=%FinishMessage%",
      "TargetName=%TargetName%",
      "FriendlyName=%FriendlyName%",
      "AppLaunched=%AppLaunched%",
      "PostInstallCmd=%PostInstallCmd%",
      "AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Silent -AllUsers",
      "UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Silent",
      "SourceFiles=SourceFiles",
      "[Strings]",
      "InstallPrompt=",
      "DisplayLicense=",
      "FinishMessage=",
      `TargetName=${win(setupPath)}`,
      "FriendlyName=Splitpage Setup",
      "AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1",
      "PostInstallCmd=<None>",
      `FILE0=\"install.ps1\"`,
      `FILE1=\"splitpage-payload-${arch}.zip\"`,
      "[SourceFiles]",
      "SourceFiles0=" + win(DIST),
      "[SourceFiles0]",
      "%FILE0%=",
      "%FILE1%="
    ].join("\r\n") + "\r\n";

    const sedPath = join(DIST, `splitpage-${arch}.SED`);
    writeFileSync(sedPath, sed);

    const res = spawnSync(IEXPRESS, ["/N", win(sedPath)], { cwd: DIST, stdio: "inherit" });
    if (res.error && res.error.code === "ENOENT") {
      console.error(`
  iexpress was not found (looked for ${IEXPRESS}), so no setup.exe was built.

  It ships with Windows — this is not something to install, it just means the
  build is not running on Windows. Everything it needs is already in dist/:

      dist/install.ps1
      dist/splitpage-payload-${arch}.zip
      dist/splitpage-${arch}.SED

  On a Windows machine, run:  iexpress /N dist\\splitpage-${arch}.SED`);
      process.exit(1);
    }
    if (res.status !== 0) {
      console.error("\n  IExpress failed — see the output above.");
      process.exit(1);
    }

    /* Never ship a setup that the PC it is meant for cannot start. This is the
       one failure the build can see and the user cannot: to them it is a
       download that does nothing, with no installer log, because no installer
       ever ran. */
    const machine = stubMachine(setupPath);
    if (!machine) {
      console.error(`\n  ${setupPath} is not a PE executable — refusing to ship it.`);
      process.exit(1);
    }
    if (!RUNS_ON[arch].includes(machine)) {
      console.error(`
  The ${arch} setup came out with a ${machine} extractor stub, which a ${arch} PC
  cannot start: Windows answers "This app can't run on your PC" and nothing in
  the installer ever runs.

  IExpress stamps the setup with the architecture of the iexpress.exe that built
  it, whatever the payload holds. This build used:

      ${IEXPRESS}

  Build with the 32-bit copy instead — %SystemRoot%\\SysWOW64\\iexpress.exe —
  whose stub starts on every architecture.`);
      process.exit(1);
    }

    console.log(`  ${setupPath}  (${machine} stub, ${arch} payload)`);
    return setupPath;
  }

  /* Build setup for each architecture */
  const setupPaths = [];
  for (const arch of archs) {
    setupPaths.push(await buildSetup(arch));
  }

  /* For x64, also create a copy without the arch suffix for backward compatibility */
  if (archs.includes("x64")) {
    const x64Path = setupPaths.find((p) => p.includes("-x64.exe"));
    const noSuffixPath = join(DIST, `SplitpageSetup-${VERSION}.exe`);
    cpSync(x64Path, noSuffixPath);
    console.log(`  ${noSuffixPath} (copy of x64 for compatibility)`);
  }
}

console.log(`\n  Unzip and run start.bat (Windows) or ./start.sh (macOS/Linux).\n`);
