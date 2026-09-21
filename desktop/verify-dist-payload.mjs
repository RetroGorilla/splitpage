/* desktop/verify-dist-payload.mjs — the payload-extraction half of verify-dist.mjs,
 * split into its own module so the comparison at its core can be unit-tested without
 * spawning 7-Zip or needing a real build (see test/verify-dist-payload.test.mjs).
 *
 * WHY THIS EXISTS: verify-dist.mjs proved the *unpacked* app directory's PE files
 * matched their architecture, but never that the installer's compressed payload
 * actually decompresses back into those same files. The 2.0.1 ARM64 setup passed
 * every one of those checks and still silently dropped all seven top-level PE
 * binaries during NSIS's own extraction (fbd1db2) — "verify-dist still passes 9/9
 * ... that gap is worth closing separately." This module is that closing.
 *
 * HOW: an NSIS installer embeds the app as one `$PLUGINSDIR\app-<arch>.<zip|7z>`
 * file (see app-builder-lib's templates/nsis/include/extractAppPackage.nsh), itself
 * wrapped by NSIS's own compressor. Getting the real bytes back out takes two
 * different tools, because no single one here can do both halves:
 *   1. A 7-Zip build with NSIS container support (its "Nsis" format, which reads the
 *      outer installer.exe and pulls the embedded file back out unmodified). The
 *      minimal `7za` electron-builder itself downloads cannot do this — `7za i`
 *      lists no Nsis format, only 7z/zip/gzip/bzip2/tar/xz/zstd. `electron-winstaller`
 *      vendors a full `7z.exe` + `7z.dll` pair that has it. It is a peer dependency of
 *      electron-builder-squirrel-windows, itself a peer dependency of app-builder-lib
 *      (see app-builder-lib/package.json), so `npm ci` against desktop/'s committed
 *      lockfile always installs it even though this project never builds a Squirrel
 *      target.
 *   2. The same `7za` electron-builder itself downloads and caches
 *      (app-builder-lib's toolsets/7zip.js, getPath7za()) to decompress the embedded
 *      zip/7z back into real files — the exact tool and codec support the real build
 *      used to create it in the first place.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/* $PLUGINSDIR\app-<X>.<zip|7z> — see extractAppPackage.nsh's x64_app_files /
   arm64_app_files / ia32_app_files macros. Lower-case, matching them exactly. */
const PAYLOAD_BASENAME = { x64: "app-64", arm64: "app-arm64", ia32: "app-32" };

function existsSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Path to a 7-Zip build that understands the NSIS container format ("Nsis" in
 * `7z i`'s format list) — resolved through node_modules rather than hard-coded,
 * since exactly where npm hoists it can vary. Throws with a clear reason if it
 * is not there, rather than skipping the check it enables. */
function resolveNsisCapable7z() {
  let pkgJson;
  try {
    pkgJson = require.resolve("electron-winstaller/package.json");
  } catch {
    throw new Error(
      "electron-winstaller not found in node_modules — it ships the only 7z.exe/7z.dll " +
        "pair here that understands the NSIS container format. Run `npm ci` in desktop/."
    );
  }
  const exe = join(dirname(pkgJson), "vendor", "7z.exe");
  if (!existsSyncSafe(exe)) {
    throw new Error(`electron-winstaller is installed but ${exe} is missing`);
  }
  return exe;
}

/** The 7za electron-builder itself downloads/caches to build the app-*.zip/.7z in
 * the first place — reused here so decompression uses the exact tool the real
 * build did. */
async function resolvePackagingPath7za() {
  let mod;
  try {
    mod = await import(pathToFileURL(require.resolve("app-builder-lib/out/toolsets/7zip.js")));
  } catch (e) {
    throw new Error(`could not load app-builder-lib's 7zip toolset module: ${e.message}`);
  }
  return mod.getPath7za();
}

function run(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

/** Pulls `$PLUGINSDIR\app-<arch>.<zip|7z>` back out of a built NSIS setup.exe,
 * uncompressed, into destDir (created if needed). Returns the extracted archive's
 * path. Tries zip then 7z, since which one is embedded depends on nsis.useZip /
 * nsis.differentialPackage (see NsisTarget.js's buildAppPackage). */
export function extractNsisEmbeddedPayload(setupExe, destDir, arch) {
  const nsis7z = resolveNsisCapable7z();
  const base = PAYLOAD_BASENAME[arch];
  if (!base) throw new Error(`no known payload name for arch "${arch}"`);
  const tried = [];
  for (const ext of ["zip", "7z"]) {
    const entry = `$PLUGINSDIR\\${base}.${ext}`;
    tried.push(entry);
    const result = run(nsis7z, ["e", setupExe, `-o${destDir}`, entry, "-y"]);
    const outFile = join(destDir, `${base}.${ext}`);
    if (result.status === 0 && existsSyncSafe(outFile)) {
      return outFile;
    }
  }
  throw new Error(
    `could not pull an app payload out of ${setupExe} — tried ${tried.join(", ")}. ` +
      `Either the installer's internal layout changed, or 7z.exe could not read it.`
  );
}

/** Fully decompresses a zip or 7z file into destDir (created if needed) with the
 * same 7za electron-builder used to create it. */
export async function extractPackagedArchive(archivePath, destDir) {
  const sevenZa = await resolvePackagingPath7za();
  const result = run(sevenZa, ["x", archivePath, `-o${destDir}`, "-y"]);
  if (result.status !== 0) {
    throw new Error(`7za failed to extract ${archivePath}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return destDir;
}

/** Every *.exe/*.dll directly inside dir — not recursive, because "top-level" is
 * the whole point: those are exactly the files the 2.0.1 bug dropped while every
 * .pak/.dat/.bin/.html underneath extracted fine. Keyed lower-case so a comparison
 * is not case-sensitive; NSIS/Windows aren't either. */
export function topLevelPeFiles(dir) {
  const out = new Map();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (ext !== ".exe" && ext !== ".dll") continue;
    out.set(name.toLowerCase(), { name, size: st.size });
  }
  return out;
}

/** The comparison at the heart of the check: every top-level PE file the unpacked
 * app directory has must also be in the extracted payload, at the same size. Pure
 * and side-effect-free so it can be unit-tested against fixture directories
 * without spawning 7-Zip or needing a real build — see
 * test/verify-dist-payload.test.mjs, which drives it against a directory with the
 * PE files deleted the way the 2.0.1 NSIS extraction actually left them. */
export function comparePayloadPeFiles(unpackedDir, extractedDir) {
  const expected = topLevelPeFiles(unpackedDir);
  const actual = topLevelPeFiles(extractedDir);
  const problems = [];
  for (const [key, exp] of expected) {
    const got = actual.get(key);
    if (!got) {
      problems.push(`${exp.name} missing from extracted payload`);
    } else if (got.size !== exp.size) {
      problems.push(`${exp.name} is ${got.size} bytes extracted, ${exp.size} bytes unpacked`);
    }
  }
  return { problems, checked: expected.size };
}

/** Runs the whole thing end to end against a real built setup.exe: extract,
 * decompress, compare, and always clean up the temp work directory. Returns the
 * same {problems, checked} shape as comparePayloadPeFiles. */
export async function verifyInstallerPayload(setupExe, unpackedDir, arch) {
  const work = mkdtempSync(join(tmpdir(), "splitpage-verify-dist-"));
  try {
    const archive = extractNsisEmbeddedPayload(setupExe, join(work, "outer"), arch);
    const inner = join(work, "inner");
    await extractPackagedArchive(archive, inner);
    return comparePayloadPeFiles(unpackedDir, inner);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
