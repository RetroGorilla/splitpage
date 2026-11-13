import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const MODULE = fileURLToPath(new URL("../../../src/core/collab/recovery.ts", import.meta.url));
const NOTE = new URL("../../../docs/collaboration/stage-2-recovery-model.md", import.meta.url);

const ENTRIES: Readonly<Record<string, readonly string[]>> = {
  "crossing-tag": ["field", "from", "occurrence", "rowId", "tag", "to", "words"],
  "deleted-tag": ["field", "from", "occurrence", "rowId", "tag", "to", "words"],
  "gallery-overflow": ["beat", "itemId", "rowId", "slot"],
  "removed-beat": ["buffer?", "members", "removal?", "row"],
  "removed-heading": ["heading", "removal?"],
  "scene-with-no-beats": ["beforeRowId", "heading"],
  "unprojectable-fragment": ["field", "from", "html", "owner", "reason", "segment", "to"]
};

const FRAGMENT_REASONS = ["duplicate-boundary", "foreign-segment", "invalid-beat-id", "invalid-prefix", "missing-beat", "missing-boundary", "unowned-beat", "wrong-shape-beat"];

const COPIES = ["derivation", "local"];

interface Declared { readonly kinds: Map<string, readonly string[]>; readonly reasons: readonly string[] }

function literals(type: ts.Type): string[] {
  return (type.isUnion() ? type.types : [type]).map(member => {
    assert.ok(member.isStringLiteral(), "a kind or reason that is not a string literal");
    return member.value;
  });
}

function declared(): Declared {
  const program = ts.createProgram([MODULE], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true, noEmit: true, strict: true, types: [] });
  const source = program.getSourceFile(MODULE);
  assert.ok(source);
  assert.deepEqual(ts.getPreEmitDiagnostics(program, source).map(value => ts.flattenDiagnosticMessageText(value.messageText, "\n")), []);
  const checker = program.getTypeChecker(), module = checker.getSymbolAtLocation(source);
  assert.ok(module);
  const exported = checker.getExportsOfModule(module).find(symbol => symbol.name === "SharedRecoveryEntry");
  assert.ok(exported);
  const union = checker.getDeclaredTypeOfSymbol(exported);
  assert.ok(union.isUnion());
  const kinds = new Map<string, readonly string[]>(), reasons: string[] = [];
  for (const member of union.types) {
    const kind = member.getProperty("kind");
    assert.ok(kind);
    const fields = checker.getPropertiesOfType(member).filter(field => field.name !== "kind")
      .map(field => field.name + (field.flags & ts.SymbolFlags.Optional ? "?" : "")).sort();
    for (const name of literals(checker.getTypeOfSymbolAtLocation(kind, source))) {
      assert.ok(!kinds.has(name), `${name} is declared twice`);
      kinds.set(name, fields);
    }
    const reason = member.getProperty("reason");
    if (reason) reasons.push(...literals(checker.getTypeOfSymbolAtLocation(reason, source)));
  }
  return { kinds, reasons: reasons.sort() };
}

interface Section { readonly kinds: readonly string[]; readonly lines: readonly string[] }

function sections(): Section[] {
  const text = readFileSync(NOTE, "utf8").replaceAll("\r\n", "\n");
  const start = text.indexOf("\n## Entry kinds\n");
  assert.ok(start >= 0, "the note has an Entry kinds section");
  const end = text.indexOf("\n## ", start + 1);
  const body = text.slice(start, end < 0 ? undefined : end);
  return body.split("\n### ").slice(1).map(part => {
    const [heading = "", ...lines] = part.split("\n");
    return { kinds: [...heading.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? ""), lines };
  });
}

function bullet(section: Section, label: string): string {
  const found = section.lines.filter(line => line.startsWith(`- ${label}:`));
  assert.equal(found.length, 1, `${section.kinds.join(", ")}: one "${label}" line`);
  return found[0] ?? "";
}

test("the recovery entry union has exactly the pinned kinds, each with its pinned fields", () => {
  const { kinds } = declared();
  assert.deepEqual(Object.fromEntries([...kinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), ENTRIES);
});

test("an unprojectable fragment has exactly the pinned reasons", () => {
  assert.deepEqual(declared().reasons, FRAGMENT_REASONS);
});

test("the recovery model note classifies every kind once, with its fields and whether every copy shows it", () => {
  const found = sections(), named = found.flatMap(section => section.kinds);
  assert.deepEqual([...named].sort(), Object.keys(ENTRIES).sort());
  for (const section of found) {
    const carries = [...bullet(section, "Carries").replaceAll(/\([^)]*\)/g, "").matchAll(/`([^`]+)`/g)].map(match => match[1] ?? "").sort();
    for (const kind of section.kinds) assert.deepEqual(carries, (ENTRIES[kind] ?? []).map(field => field.replace("?", "")).sort(), kind);
    const copies = bullet(section, "Copies").slice("- Copies: ".length).split(/[ .,;]/)[0] ?? "";
    assert.ok(COPIES.includes(copies), `${section.kinds.join(", ")}: copies is ${copies}`);
    for (const label of ["Produced", "Restore today", "Restore should mean", "Undo of restore"]) assert.ok(bullet(section, label).length > label.length + 4, label);
  }
});

test("the recovery model note names every fragment reason", () => {
  const fragment = sections().find(section => section.kinds.includes("unprojectable-fragment"));
  assert.ok(fragment);
  const named = fragment.lines.filter(line => line.startsWith("| `")).map(line => /^\| `([^`]+)`/.exec(line)?.[1] ?? "").sort();
  assert.deepEqual(named, FRAGMENT_REASONS);
});
