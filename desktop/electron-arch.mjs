import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function electronArch(env, platform, nodeArch) {
  let arch = env.npm_config_arch || env.ELECTRON_ARCH;
  if (!arch && platform === "win32") {
    const processor = env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE;
    if (processor) {
      const windowsArches = { AMD64: "x64", ARM64: "arm64", x86: "ia32", ARM: "armv7l" };
      arch = Object.hasOwn(windowsArches, processor) ? windowsArches[processor] : processor;
    }
  }
  arch ||= nodeArch;
  if (arch === "arm") arch = "armv7l";
  if (!["x64", "arm64", "ia32", "armv7l"].includes(arch)) {
    throw new Error(`Unknown Electron architecture: ${arch}`);
  }
  return arch;
}

function main() {
  process.env.npm_config_arch = electronArch(process.env, process.platform, process.arch);
  const here = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [resolve(here, "node_modules/electron/install.js")], {
    cwd: here,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
