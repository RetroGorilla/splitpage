/* verify-dist.mjs — check what electron-builder actually produced, before
 * anything is published.
 *
 * WHY THIS EXISTS: 1.0.1's SplitpageSetup-x64.exe (the IExpress setup from
 * package.mjs) shipped as an ARM64 binary and would not start on an x64 PC at
 * all. IExpress stamps the self-extractor with the architecture of the
 * iexpress.exe that built it, and on this Snapdragon machine that is ARM64.
 * electron-builder has the same trap in a different place: left to its
 * defaults it builds for the HOST's architecture. electron-builder.yml and
 * `npm run dist:win` both pin x64 + arm64 now, but a pin is a promise; this
 * script checks the result. To the user a wrong-architecture download is just
 * "This app can't run on your PC", with no installer log, because nothing ever
 * ran. The build is the only place that failure can be seen.
 *
 * WHAT IT CHECKS, per architecture:
 *   1. dist/<unpacked>/Splitpage.exe has exactly that PE machine type. An x64
 *      Splitpage.exe in the ARM64 build would still start (Windows 11 on ARM
 *      emulates x64), but slowly and wrongly, so an exact match is required.
 *   2. Every other .exe/.dll/.node in that unpacked app matches too, except
 *      the allowlist below. A native module or a stray DLL of the wrong
 *      architecture fails at load time, not at install time.
 *   3. The installer dist/SplitpageDesktopSetup-<version>-<arch>.exe has a
 *      stub that a PC of that architecture can START. electron-builder's
 *      NSIS stub is x86 (014C) by design, because x86 runs on every Windows
 *      PC, so "setup must be 8664" would be the wrong test.
 *   4. The installer is not older than its unpacked app. electron-builder
 *      packs each installer from the unpacked directory of the same
 *      architecture in the same run; an installer older than the exe would
 *      be a leftover from an earlier build, verified against the wrong thing.
 *   5. The installer's payload actually extracts, and every top-level PE
 *      binary the unpacked app has comes back out at the same size. The
 *      2.0.1 ARM64 setup passed every check above — Splitpage.exe and its
 *      neighbours were exactly the right architecture *in the unpacked
 *      directory* — and still silently dropped all seven of them (fbd1db2)
 *      because NSIS's own extraction of the compressed payload botched them.
 *      Checks 1, 2 and 4 only prove the source of that payload was right;
 *      this pulls the payload back out of the actual setup.exe with a real
 *      archive tool and diffs it (verify-dist-payload.mjs).
 * With both architectures it also checks the combined installer's stub is
 * x86, the only stub that starts everywhere.
 *
 * Usage (from desktop/):
 *   node verify-dist.mjs [--arch x64|arm64|both] [--dist <dir>] [--version <v>]
 * Exits 0 when everything matches, 1 otherwise (and lists every mismatch).
 * PE machine types: 014C x86, 8664 x64, AA64 ARM64.
 */

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInstallerPayload } from "./verify-dist-payload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : String(process.argv[i + 1] || "");
}

const DIST = argValue("--dist", join(HERE, "dist"));
const VERSION = argValue("--version", JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version);
const ARCH_ARG = argValue("--arch", "both");
if (!["x64", "arm64", "both"].includes(ARCH_ARG)) {
  console.error("--arch must be x64, arm64 or both");
  process.exit(1);
}
const ARCHS = ARCH_ARG === "both" ? ["x64", "arm64"] : [ARCH_ARG];

const PE_MACHINE = { 0x014c: "x86", 0x8664: "x64", 0xaa64: "arm64" };

/* Which installer stubs a PC of each architecture can start: x86 runs
   everywhere, x64 runs natively on x64 and emulated on Windows 11 ARM64,
   ARM64 only on ARM64. (Same table as package.mjs's RUNS_ON.) */
const RUNS_ON = { x64: ["x86", "x64"], arm64: ["x86", "x64", "arm64"] };

const UNPACKED = { x64: "win-unpacked", arm64: "win-arm64-unpacked" };

/* Binaries that are deliberately not the app's architecture. elevate.exe is
   electron-builder's UAC helper, shipped as x86 so one copy runs on every
   Windows PC. Paths are relative to the unpacked directory, lower-case,
   forward slashes. Anything added here needs a reason next to it. */
const ALLOW_OTHER_ARCH = { "resources/elevate.exe": ["x86"] };

/* The PE machine word, read without loading the file. Splitpage.exe is over
   200 MB, and Windows only needs the header to refuse it: "MZ" at 0, e_lfanew
   at 0x3C, "PE\0\0" at e_lfanew, then the machine word. Returns
   "x86"/"x64"/"arm64", "0x…" for an unknown type, or null if the file is not
   a PE executable. */
function peMachine(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(0x40);
    if (readSync(fd, head, 0, 0x40, 0) < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return null;
    const off = head.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (readSync(fd, pe, 0, 6, off) < 6 || pe.readUInt32LE(0) !== 0x00004550) return null;
    const machine = pe.readUInt16LE(4);
    return PE_MACHINE[machine] || `0x${machine.toString(16).padStart(4, "0")}`;
  } finally {
    closeSync(fd);
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const failures = [];
let checks = 0;
function check(ok, label, detail) {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label + (detail ? ` (${detail})` : ""));
}

for (const arch of ARCHS) {
  const unpacked = join(DIST, UNPACKED[arch]);
  const appExe = join(unpacked, "Splitpage.exe");

  if (!existsSync(appExe)) {
    check(false, `${arch}: ${relative(DIST, appExe)} exists`, "not built");
  } else {
    const m = peMachine(appExe);
    check(m === arch, `${arch}: Splitpage.exe is ${arch}`, `PE machine ${m}`);

    /* One check for the whole directory, and it fails if any single binary
       does: a summary line that said "ok" right under a mismatch would read
       as a pass to anyone skimming the build log. */
    let native = 0;
    const wrong = [];
    for (const file of walk(unpacked)) {
      const ext = extname(file).toLowerCase();
      if (ext !== ".exe" && ext !== ".dll" && ext !== ".node") continue;
      const rel = relative(unpacked, file).split("\\").join("/").toLowerCase();
      if (rel === "splitpage.exe") continue;
      native++;
      const fm = peMachine(file);
      const allowed = ALLOW_OTHER_ARCH[rel] || [];
      if (fm !== arch && !allowed.includes(fm)) wrong.push(`${rel} is ${fm}`);
    }
    check(wrong.length === 0,
      `${arch}: every other .exe/.dll/.node in ${UNPACKED[arch]} is ${arch} or allowlisted`,
      wrong.length ? wrong.join("; ") : `${native} checked`);

    /* Follow My Voice (#8) runs this script with Windows' own powershell.exe,
       so it ships no binary of its own to check above — only the script,
       which has to sit outside the asar for powershell.exe to read it. */
    const voiceScript = join(unpacked, "resources", "splitpage", "voice", "listen.ps1");
    check(existsSync(voiceScript), `${arch}: the Follow My Voice listener ships outside the asar`,
      existsSync(voiceScript) ? "" : "resources/splitpage/voice/listen.ps1 missing — stage.mjs");
  }

  const setup = join(DIST, `SplitpageDesktopSetup-${VERSION}-${arch}.exe`);
  if (!existsSync(setup)) {
    check(false, `${arch}: ${relative(DIST, setup)} exists`, "not built");
  } else {
    const sm = peMachine(setup);
    check(!!sm && RUNS_ON[arch].includes(sm), `${arch}: installer stub starts on an ${arch} PC`, `PE machine ${sm}`);
    if (existsSync(appExe)) {
      const fresh = statSync(setup).mtimeMs + 2000 >= statSync(appExe).mtimeMs;
      check(fresh, `${arch}: installer is from the same build as ${UNPACKED[arch]}`,
        fresh ? "" : "installer is older than Splitpage.exe — a leftover from an earlier build");
    }

    /* The check fbd1db2 said was worth closing separately: really extract the
       payload out of the built setup.exe (not just trust the unpacked directory
       it was built from) and diff its top-level PE files. This is what would
       have failed on the 2.0.1 ARM64 build. */
    if (existsSync(appExe)) {
      try {
        const { problems, checked } = await verifyInstallerPayload(setup, unpacked, arch);
        check(problems.length === 0,
          `${arch}: installer payload actually extracts with every top-level PE binary intact`,
          problems.length ? problems.join("; ") : `${checked} checked`);
      } catch (e) {
        check(false, `${arch}: installer payload actually extracts with every top-level PE binary intact`, e.message);
      }
    }
  }
}

if (ARCHS.length === 2) {
  const combined = join(DIST, `SplitpageDesktopSetup-${VERSION}.exe`);
  if (existsSync(combined)) {
    const cm = peMachine(combined);
    check(cm === "x86", "combined installer stub is x86 (starts on both)", `PE machine ${cm}`);
  }
}

if (failures.length) {
  console.error(`\nFAILED — ${failures.length} of ${checks} checks. Do not publish these installers:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nALL PASS — ${checks}/${checks} architecture checks (${ARCHS.join(" + ")}, version ${VERSION})`);
