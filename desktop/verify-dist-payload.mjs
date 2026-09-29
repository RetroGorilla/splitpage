import { spawnSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const PAYLOAD_BASENAME = { x64: "app-64", arm64: "app-arm64", ia32: "app-32" };

function existsSyncSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Only electron-winstaller bundles a 7z that reads NSIS
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

async function resolvePackagingPath7za() {
  let mod;
  try {
    mod = await import(pathToFileURL(require.resolve("app-builder-lib/out/toolsets/7zip.js")));
  } catch (e) {
    throw new Error(`could not load app-builder-lib's 7zip toolset module: ${e.message}`, { cause: e });
  }
  return mod.getPath7za();
}

function run(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

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

export async function extractPackagedArchive(archivePath, destDir) {
  const sevenZa = await resolvePackagingPath7za();
  const result = run(sevenZa, ["x", archivePath, `-o${destDir}`, "-y"]);
  if (result.status !== 0) {
    throw new Error(`7za failed to extract ${archivePath}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return destDir;
}

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
