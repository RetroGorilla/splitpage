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

const RUNS_ON = { x64: ["x86", "x64"], arm64: ["x86", "x64", "arm64"] };

const UNPACKED = { x64: "win-unpacked", arm64: "win-arm64-unpacked" };

const ALLOW_OTHER_ARCH = { "resources/elevate.exe": ["x86"] };

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
