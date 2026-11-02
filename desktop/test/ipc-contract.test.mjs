import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFixtures } from "../../tools/ts-fixtures.mjs";

const configPath = fileURLToPath(new URL("../../tsconfig.desktop.json", import.meta.url));
const fixture = fileURLToPath(new URL("../ipc-contract-check.ts", import.meta.url)).replaceAll("\\", "/");
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys);
assert.ok(config);
assert.deepEqual(config.errors, []);

const prelude = `import type { DesktopIpcWrappers } from "./ipc-setup.ts";
import type { DesktopChannelRow, DesktopDraftReadHeader } from "../shared/desktop-contract.d.ts";
import type { DesktopIpcEvent, DesktopFileIpcDependencies, DesktopMainTab } from "./ipc-boundaries.d.ts";
import type { BrowserWindow } from "electron";
declare const wrappers: DesktopIpcWrappers;
declare const deps: DesktopFileIpcDependencies;
declare const event: DesktopIpcEvent;
declare const tab: DesktopMainTab;
declare const readHeader: DesktopDraftReadHeader;
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
deps.dialog.showOpenDialog(undefined, {});
deps.dialog.showSaveDialog(undefined, { defaultPath: undefined, filters: undefined });
deps.dialog.showMessageBoxSync(undefined, { message: "x" });
const absentKeep: Pick<DesktopMainTab, "keepDraftOnClose"> = {};
const refusal: DesktopChannelRow = { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: [], allowedOrigins: [], refusal: null };`;
assert.deepEqual(diagnostics(valid), []);

const CASES = [
  {
    "source": "wrappers.ipcHandle(\"splitpage:draft-take\", async () => ({}));",
    "code": 2322,
    "at": "({})",
    "about": "DesktopWireTakenDraft"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:draft-take\", async () => ({ corrupt: false }));",
    "code": 2322,
    "at": "({ corrupt: false })",
    "about": "unsupported"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:write-file\", async () => ({}));",
    "code": 2322,
    "at": "({})",
    "about": "size"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:route-open\", async () => ({ where: \"unrecognized\" }));",
    "code": 2322,
    "at": "({ where: \"unrecognized\" })",
    "about": "where"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:history-copy\", async () => ({ ok: false, copied: 0 }));",
    "code": 2322,
    "at": "({ ok: false, copied: 0 })",
    "about": "code"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:draft-write\", async () => null);",
    "code": 2322,
    "at": "null",
    "about": "DesktopWireDraftWrite"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:draft-discard\", async () => null);",
    "code": 2322,
    "at": "null",
    "about": "DesktopWireDraftDiscard"
  },
  {
    "source": "const row: DesktopChannelRow = { name: \"splitpage:get-app-version-sync\", direction: \"sendSync\", argsSchema: [], allowedOrigins: [], refusal: false };",
    "code": 2322,
    "at": "row",
    "about": "refusal"
  },
  {
    "source": "const row: DesktopChannelRow = { name: \"splitpage:get-app-version-sync\", direction: \"sendSync\", argsSchema: [], allowedOrigins: [] };",
    "code": 2322,
    "at": "row",
    "about": "refusal"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:read-file\", async () => null);",
    "code": 2322,
    "at": "null",
    "about": "DesktopWireFile"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:stat-file\", async () => ({ ok: true }));",
    "code": 2322,
    "at": "({ ok: true })",
    "about": "lastModified"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:read-file\", async (_event, id: number) => ({ id, name: \"a\" }));",
    "code": 2345,
    "at": "async (_event, id: number) => ({ id, name: \"a\" })",
    "about": "parameters 'id'"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:set-theme\", async () => undefined);",
    "code": 2345,
    "at": "\"splitpage:set-theme\"",
    "about": "splitpage:set-theme"
  },
  {
    "source": "wrappers.ipcOn(\"splitpage:set-theme\", (_event, mode: number) => { mode.toFixed(); });",
    "code": 2345,
    "at": "(_event, mode: number) => { mode.toFixed(); }",
    "about": "parameters 'mode'"
  },
  {
    "source": "wrappers.ipcOnSync(\"splitpage:is-test-mode-sync\", () => \"yes\");",
    "code": 2322,
    "at": "\"yes\"",
    "about": "boolean"
  },
  {
    "source": "wrappers.ipcHandle(\"splitpage:missing\", async () => null);",
    "code": 2345,
    "at": "\"splitpage:missing\"",
    "about": "splitpage:missing"
  },
  {
    "source": "const row: DesktopChannelRow = { name: \"splitpage:missing\", direction: \"invoke\", argsSchema: [], allowedOrigins: [] };",
    "code": 2820,
    "at": "name",
    "about": "splitpage:missing"
  },
  {
    "source": "const title: string = readHeader.title;",
    "code": 2322,
    "at": "title",
    "about": "unknown"
  },
  {
    "source": "const kind = readHeader.origin.kind;",
    "code": 18046,
    "at": "readHeader.origin",
    "about": "unknown"
  },
  {
    "source": "const parent: BrowserWindow = deps.dialogParentFor(event);",
    "code": 2322,
    "at": "parent",
    "about": "undefined"
  },
  {
    "source": "const keep: boolean = tab.keepDraftOnClose;",
    "code": 2322,
    "at": "keep",
    "about": "undefined"
  }
];

for (const expected of CASES) {
  const errors = diagnostics(expected.source);
  assert.equal(errors.length, 1, expected.source + "\n" + errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("\n"));
  const error = errors[0];
  const offset = expected.source.indexOf(expected.at);
  assert.ok(offset >= 0, expected.source);
  assert.equal(error.file?.fileName, fixture, expected.source);
  assert.equal(error.code, expected.code, expected.source);
  assert.equal(error.start, prelude.length + offset, expected.source);
  assert.equal(error.length, expected.at.length, expected.source);
  assert.ok(ts.flattenDiagnosticMessageText(error.messageText, " ").includes(expected.about), expected.source);
}

const preloadPath = "desktop/preload.ts";
const preloadSource = readFileSync(new URL("../preload.ts", import.meta.url), "utf8");
function preloadDiagnostics(source) {
  return ts.getPreEmitDiagnostics(compileFixtures({ [preloadPath]: source }, { config: "tsconfig.desktop.json" }).program);
}
assert.deepEqual(preloadDiagnostics(preloadSource), []);
const brokenReviver = preloadSource.replace('entry = { ...entry, bytes: new Uint8Array(entry.bytes) };', 'entry = { ...entry, bytes: "wrong" };');
assert.notEqual(brokenReviver, preloadSource);
const reviverErrors = preloadDiagnostics(brokenReviver);
assert.equal(reviverErrors.length, 1);
const reviverError = reviverErrors[0];
assert.ok(reviverError.file?.fileName.replaceAll("\\", "/").endsWith("/" + preloadPath));
assert.equal(reviverError.code, 2322);
assert.equal(reviverError.start, brokenReviver.indexOf('bytes: "wrong"'));
assert.equal(reviverError.length, "bytes".length);
assert.ok(ts.flattenDiagnosticMessageText(reviverError.messageText, " ").includes("Uint8Array"));

const tabstripPath = "desktop/tabstrip-preload.ts";
const tabstripSource = readFileSync(new URL("../tabstrip-preload.ts", import.meta.url), "utf8");
function tabstripDiagnostics(source) {
  return ts.getPreEmitDiagnostics(compileFixtures({ [tabstripPath]: source }, { config: "tsconfig.desktop.json" }).program);
}
assert.deepEqual(tabstripDiagnostics(tabstripSource), []);
const brokenTabId = tabstripSource.replace('send("splitpage:tabstrip-activate", tabId);', 'send("splitpage:tabstrip-activate", 123);');
assert.notEqual(brokenTabId, tabstripSource);
const tabIdErrors = tabstripDiagnostics(brokenTabId);
assert.equal(tabIdErrors.length, 1);
const tabIdError = tabIdErrors[0];
assert.ok(tabIdError.file?.fileName.replaceAll("\\", "/").endsWith("/" + tabstripPath));
assert.equal(tabIdError.code, 2345);
assert.equal(tabIdError.start, brokenTabId.indexOf('123);'));
assert.equal(tabIdError.length, 3);
assert.ok(ts.flattenDiagnosticMessageText(tabIdError.messageText, " ").includes("string"));

console.log("ALL PASS (strict IPC arguments, results, directions, contract coverage and file revival)");
