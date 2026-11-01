import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const configPath = fileURLToPath(new URL("../../tsconfig.desktop.json", import.meta.url));
const fixture = fileURLToPath(new URL("../ipc-contract-check.ts", import.meta.url)).replaceAll("\\", "/");
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys);
assert.ok(config);
assert.deepEqual(config.errors, []);

const prelude = `import type { DesktopIpcWrappers } from "./ipc-setup.ts";
import type { DesktopChannelRow } from "../shared/desktop-contract.d.ts";
declare const wrappers: DesktopIpcWrappers;
`;

function diagnostics(source) {
  const host = ts.createCompilerHost(config.options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fixture
    ? ts.createSourceFile(name, prelude + source, languageVersion)
    : read(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [fixture], options: config.options, host });
  return ts.getPreEmitDiagnostics(program);
}

const valid = `wrappers.ipcHandle("splitpage:read-file", async (_event, id) => ({ id, name: "a", bytes: new Uint8Array(), lastModified: 1, size: 0 }));
wrappers.ipcOn("splitpage:set-theme", (_event, mode) => { mode.toUpperCase(); });
wrappers.ipcOnSync("splitpage:is-test-mode-sync", () => false);`;
assert.deepEqual(diagnostics(valid), []);

for (const source of [
  'wrappers.ipcHandle("splitpage:read-file", async () => null);',
  'wrappers.ipcHandle("splitpage:stat-file", async () => ({ ok: true }));',
  'wrappers.ipcHandle("splitpage:read-file", async (_event, id: number) => ({ id, name: "a" }));',
  'wrappers.ipcHandle("splitpage:set-theme", async () => undefined);',
  'wrappers.ipcOn("splitpage:set-theme", (_event, mode: number) => { mode.toFixed(); });',
  'wrappers.ipcOnSync("splitpage:is-test-mode-sync", () => "yes");',
  'wrappers.ipcHandle("splitpage:missing", async () => null);',
  'const row: DesktopChannelRow = { name: "splitpage:missing", direction: "invoke", argsSchema: [], allowedOrigins: [] };'
]) {
  const errors = diagnostics(source);
  assert.ok(errors.some((error) => error.file?.fileName === fixture), source);
}

console.log("ALL PASS (strict IPC arguments, results, directions and contract coverage)");
