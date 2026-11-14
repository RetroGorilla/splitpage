import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { bootEntrySwitchFixture, stopEntrySwitchFixture } from "./shared-entry-switch-support.ts";
import { OWNER_ENTRY_METHODS, ENTRY_CAPABILITIES, COMMON_CAPABILITIES, ENTRY_CASES } from "./shared-entry-inventory.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { capabilities } from "../../src/bootstrap/wiring/ports/capabilities.ts";
import { holdSessionCommands } from "../../src/bootstrap/wiring/session-owner.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

test("C8 the entry matrix classifies every transition and capability method, including inherited methods", () => {
  const files = ["src/application/transitions/transitions.ts", "src/bootstrap/wiring/ports/capabilities.ts"] as const;
  const program = ts.createProgram(files, { noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext });
  const checker = program.getTypeChecker();
  function methods(file: string, name: string) {
    const source = program.getSourceFile(file); assert.ok(source);
    const module = checker.getSymbolAtLocation(source); assert.ok(module);
    const symbol = checker.getExportsOfModule(module).find(item => item.name === name); assert.ok(symbol, name);
    return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)).map(item => item.name).sort();
  }
  const owners = Object.keys(OWNER_ENTRY_METHODS).sort(), permissions = [...ENTRY_CAPABILITIES, ...COMMON_CAPABILITIES].sort();
  assert.deepEqual(methods(files[0], "Transitions"), owners);
  assert.deepEqual(Object.keys(documentTransitions()).sort(), owners);
  assert.deepEqual(methods(files[1], "EntryCapabilityPort"), permissions);
  assert.deepEqual(Object.keys(capabilities).sort(), permissions);
  for (const [name, kind] of Object.entries(OWNER_ENTRY_METHODS)) if (kind === "replace") assert.ok(ENTRY_CASES.some(entry => entry.owner === name), name);
  for (const name of ENTRY_CAPABILITIES) assert.ok(ENTRY_CASES.some(entry => entry.capability === name), name);
  assert.equal(new Set(ENTRY_CASES.map(entry => entry.name)).size, ENTRY_CASES.length);
});

test("C8 unheld capabilities retain their mode answers and a switch hold leaves common permissions alone", () => {
  for (const name of [...COMMON_CAPABILITIES, ...ENTRY_CAPABILITIES]) {
    assert.deepEqual(capabilities[name](), { allowed: true });
  }
  const release = holdSessionCommands("session-switching", "entries");
  try {
    for (const name of ENTRY_CAPABILITIES) assert.deepEqual(capabilities[name](), { allowed: false, reason: "session-switching" });
    for (const name of COMMON_CAPABILITIES) assert.deepEqual(capabilities[name](), { allowed: true });
  } finally { release(); }
  for (const name of ENTRY_CAPABILITIES) assert.deepEqual(capabilities[name](), { allowed: true });
});
