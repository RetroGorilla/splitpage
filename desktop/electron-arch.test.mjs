import assert from "node:assert/strict";
import { electronArch } from "./electron-arch.mjs";

const cases = [
  ["x64 Linux", {}, "linux", "x64", "x64"],
  ["arm64 Linux", {}, "linux", "arm64", "arm64"],
  ["Windows x64", { PROCESSOR_ARCHITECTURE: "AMD64" }, "win32", "x64", "x64"],
  ["Windows ARM64 native Node", { PROCESSOR_ARCHITECTURE: "ARM64" }, "win32", "arm64", "arm64"],
  ["Windows ARM64 emulated Node", { PROCESSOR_ARCHITEW6432: "ARM64", PROCESSOR_ARCHITECTURE: "AMD64" }, "win32", "x64", "arm64"],
  ["Windows ARM64 processor fallback", { PROCESSOR_ARCHITECTURE: "ARM64" }, "win32", "x64", "arm64"],
  ["Windows Node fallback", {}, "win32", "x64", "x64"],
  ["Linux ignores Windows hints", { PROCESSOR_ARCHITECTURE: "ARM64" }, "linux", "x64", "x64"],
  ["npm override wins", { npm_config_arch: "x64", ELECTRON_ARCH: "arm64", PROCESSOR_ARCHITECTURE: "ARM64" }, "win32", "arm64", "x64"],
  ["Electron override wins", { ELECTRON_ARCH: "x64", PROCESSOR_ARCHITEW6432: "ARM64" }, "win32", "arm64", "x64"],
  ["ARM Linux", {}, "linux", "arm", "armv7l"],
  ["Windows x86", { PROCESSOR_ARCHITECTURE: "x86" }, "win32", "ia32", "ia32"]
];

for (const [name, env, platform, nodeArch, expected] of cases) {
  const before = { ...env };
  assert.equal(electronArch(env, platform, nodeArch), expected, name);
  assert.deepEqual(env, before, `${name} leaves the environment unchanged`);
  console.log(`ok ${name}`);
}

for (const env of [
  { npm_config_arch: "unknown-npm", ELECTRON_ARCH: "x64" },
  { ELECTRON_ARCH: "unknown-electron" },
  { PROCESSOR_ARCHITEW6432: "unknown-native", PROCESSOR_ARCHITECTURE: "AMD64" },
  { PROCESSOR_ARCHITECTURE: "unknown-processor" },
  {}
]) {
  const value = env.npm_config_arch || env.ELECTRON_ARCH || env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || "unknown-node";
  assert.throws(() => electronArch(env, "win32", "unknown-node"), (error) => {
    assert.equal(error.message, `Unknown Electron architecture: ${value}`);
    return true;
  });
  console.log(`ok rejects ${value}`);
}
