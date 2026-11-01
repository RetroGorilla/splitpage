import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const configPath = fileURLToPath(new URL("../../tsconfig.desktop.json", import.meta.url));
const fixture = fileURLToPath(new URL("../ipc-contract-check.ts", import.meta.url)).replaceAll("\\", "/");
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys);
assert.ok(config);
assert.deepEqual(config.errors, []);

const prelude = `import type { DesktopIpcWrappers } from "./ipc-setup.ts";
import type { DesktopChannelRow, DesktopDraftReadHeader } from "../shared/desktop-contract.d.ts";
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
wrappers.ipcOnSync("splitpage:is-test-mode-sync", () => false);
const header: DesktopDraftReadHeader = { format: "splitpage-draft", formatVersion: 1, tabId: "t", state: { bytes: 2, sha256: "s" }, origin: 42 };
wrappers.ipcHandle("splitpage:write-file", async () => ({ size: 1 }));
wrappers.ipcHandle("splitpage:draft-take", async () => ({ corrupt: true }));
wrappers.ipcHandle("splitpage:draft-take", async () => ({ unsupported: true }));
wrappers.ipcHandle("splitpage:draft-take", async () => ({ header, stateJson: "{}", baseJson: null, baseProblem: null, usedPrevGeneration: false }));
const refusal: DesktopChannelRow = { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: [], allowedOrigins: [], refusal: null };`;
assert.deepEqual(diagnostics(valid), []);

for (const source of [
  'wrappers.ipcHandle("splitpage:draft-take", async () => ({}));',
  'wrappers.ipcHandle("splitpage:draft-take", async () => ({ corrupt: false }));',
  'wrappers.ipcHandle("splitpage:write-file", async () => ({}));',
  'wrappers.ipcHandle("splitpage:route-open", async () => ({ where: "unrecognized" }));',
  'wrappers.ipcHandle("splitpage:history-copy", async () => ({ ok: false, copied: 0 }));',
  'wrappers.ipcHandle("splitpage:draft-write", async () => null);',
  'wrappers.ipcHandle("splitpage:draft-discard", async () => null);',
  'const row: DesktopChannelRow = { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: [], allowedOrigins: [], refusal: false };',
  'const row: DesktopChannelRow = { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: [], allowedOrigins: [] };',
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
