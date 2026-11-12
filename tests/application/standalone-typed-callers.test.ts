import { test } from "node:test";
import assert from "node:assert/strict";
import { typedStandaloneInventory } from "./session-caller-scan.ts";

const ACCESSES = {
  stamp: {
    "application/identity/document-identity.ts": 2,
    "bootstrap/wiring/file-saving.ts": 1,
    "bootstrap/wiring/ports/document-identity.ts": 1,
    "bootstrap/wiring/session-owner.ts": 3,
    "features/tags/production-tags.ts": 1
  },
  amend: {
    "bootstrap/wiring/session-owner.ts": 2,
    "bootstrap/wiring/writer.ts": 1
  },
  noteEdit: {
    "bootstrap/wiring/desktop.ts": 1,
    "bootstrap/wiring/imports.ts": 1,
    "bootstrap/wiring/session-owner.ts": 2,
    "features/imports/imports.ts": 1
  },
  held: {
    "application/editing/undo/undo.ts": 2,
    "application/production/broll-records.ts": 1,
    "application/save/project-files.ts": 1,
    "application/session/session-merge.ts": 2,
    "application/transitions/transitions.ts": 3,
    "bootstrap/wiring/editor-owners.ts": 2,
    "bootstrap/wiring/editor.ts": 4,
    "bootstrap/wiring/session-owner.ts": 3,
    "bootstrap/wiring/transition-owners.ts": 1
  }
};

const POSITIONS = {
  "application/editing/undo/undo.ts": 4,
  "application/identity/ports.ts": 2,
  "application/production/broll-records.ts": 2,
  "application/recovery/drafts-ports.ts": 2,
  "application/recovery/drafts.ts": 1,
  "application/save/file-saving-ports.ts": 2,
  "application/save/project-files.ts": 2,
  "application/session/document-merge.ts": 2,
  "application/session/document-session.ts": 14,
  "application/session/session-merge-ports.ts": 10,
  "application/transitions/local-files-ports.ts": 4,
  "application/transitions/ports.ts": 4,
  "bootstrap/wiring/ports/document.ts": 4,
  "bootstrap/wiring/session-owner.ts": 9,
  "features/imports/ports.ts": 2,
  "features/tags/ports.ts": 2,
  "features/tags/production-tags.ts": 5
};

const PORTS = {
  "application/production/broll-records.ts#RecordsReconcilerPorts.held": true,
  "application/editing/undo/undo.ts#UndoPorts.held": true,
  "application/save/project-files.ts#ProjectFilesPorts.heldDocument": true,
  "application/session/session-merge-ports.ts#SessionMergeSession.held": true
};

let inventory: ReturnType<typeof typedStandaloneInventory> | null = null;

function current() {
  inventory ??= typedStandaloneInventory();
  return inventory;
}

for (const member of ["stamp", "amend", "noteEdit", "held"] as const) {
  test("typed inventory: " + member + " reads stay in the audited modules regardless of receiver or carrier spelling", () => {
    assert.deepEqual(current().members[member], ACCESSES[member]);
  });
}

test("typed inventory: standalone type positions include bare annotations and resolved aliases", () => {
  assert.deepEqual(current().typePositions, POSITIONS);
});

test("typed inventory: the four held port declarations resolve to the standalone held method", () => {
  assert.deepEqual(current().portMemberTypes, PORTS);
});

const IMPORTS = `
  import type { StandaloneDocumentSession as Session } from "../application/session/document-session.ts";
  import type { UndoPorts } from "../application/editing/undo/undo.ts";
  import { standaloneSession } from "../bootstrap/wiring/session-owner.ts";
`;

for (const [name, source, member, count, positions] of [
  ["a renamed full-session receiver", "function inspect(renamed: Session) { renamed.stamp(null!); }", "stamp", 1, 1],
  ["a Pick receiver", 'function inspect(renamed: Pick<Session, "amend">) { renamed.amend(null!); }', "amend", 1, 2],
  ["an indexed callback under another name", 'function inspect(renamed: Session["noteEdit"]) { renamed(); }', "noteEdit", 1, 2],
  ["a method call on an indexed callback", 'function inspect(renamed: Session["held"]) { renamed.call(null); }', "held", 1, 2],
  ["an optional Pick receiver", 'function inspect(renamed: Pick<Session, "held"> | null) { renamed?.held(); }', "held", 1, 3],
  ["a literal element key", 'function inspect(renamed: Session) { renamed["held"](); }', "held", 1, 1],
  ["an alias of the returned session", "const renamed = standaloneSession(); renamed.amend(null!);", "amend", 1, 0],
  ["a destructured port under another name", "function inspect(renamed: UndoPorts) { const { held: read } = renamed; read(); }", "held", 2, 0],
  ["a nested binding", "function inspect(renamed: Session) { const { value: { held: read } } = { value: renamed }; read(); }", "held", 2, 1],
  ["a computed literal binding", 'function inspect(renamed: Session) { const { ["held"]: read } = renamed; read(); }', "held", 2, 1],
  ["a parameter binding", 'function inspect({ held: read }: Pick<Session, "held">) { read(); }', "held", 2, 2],
  ["a loop binding", "function inspect(renamed: Session) { for (const { held: read } of [renamed]) read(); }", "held", 2, 1],
  ["an assignment binding", "function inspect(renamed: Session) { let read; ({ held: read } = renamed); }", "held", 1, 1],
  ["a local type alias", "type Local = Session; function inspect(renamed: Local) { renamed.held(); }", "held", 1, 2],
  ["a ReturnType carrier", 'function inspect(renamed: ReturnType<typeof standaloneSession>) { renamed["held"](); }', "held", 1, 1]
] as const) {
  test("typed scan self-test: " + name, () => {
    const found = typedStandaloneInventory({ "starters/session-type-probe.ts": IMPORTS + source });
    assert.deepEqual(found.members, {
      stamp: member === "stamp" ? { "starters/session-type-probe.ts": count } : {},
      amend: member === "amend" ? { "starters/session-type-probe.ts": count } : {},
      noteEdit: member === "noteEdit" ? { "starters/session-type-probe.ts": count } : {},
      held: member === "held" ? { "starters/session-type-probe.ts": count } : {}
    });
    assert.deepEqual(found.typePositions, positions ? { "starters/session-type-probe.ts": positions } : {});
  });
}

test("typed scan self-test: a rest element named held and unrelated matching words read no standalone member", () => {
  const found = typedStandaloneInventory({ "starters/session-type-probe.ts": IMPORTS + `
    function inspect(renamed: Session) { const { ...held } = renamed; Object.keys(held); }
    const unrelated = { held() {}, stamp() {}, amend() {}, noteEdit() {} };
    unrelated.held(); unrelated.stamp(); unrelated.amend(); unrelated.noteEdit();
  ` });
  assert.deepEqual(found.members, { stamp: {}, amend: {}, noteEdit: {}, held: {} });
  assert.deepEqual(found.typePositions, { "starters/session-type-probe.ts": 1 });
});

test("typed scan self-test: JavaScript receives the standalone method type through the named door", () => {
  const found = typedStandaloneInventory({ "starters/session-type-probe.js": `
    import { standaloneSession } from "../bootstrap/wiring/session-owner.ts";
    const renamed = standaloneSession();
    renamed.held();
  ` });
  assert.deepEqual(found.members, { stamp: {}, amend: {}, noteEdit: {}, held: { "starters/session-type-probe.js": 1 } });
  assert.deepEqual(found.typePositions, {});
});

test("typed scan self-test: a bare standalone annotation counts without a member read", () => {
  const found = typedStandaloneInventory({ "starters/session-type-probe.ts": IMPORTS + `
    function inspect(renamed: Session) { return renamed; }
  ` });
  assert.deepEqual(found.members, { stamp: {}, amend: {}, noteEdit: {}, held: {} });
  assert.deepEqual(found.typePositions, { "starters/session-type-probe.ts": 1 });
});

for (const [name, annotation, alias, allowed] of [
  ["an indexed declaration", 'Session["held"]', "", true],
  ["a local alias", "Local", 'type Local = Session["held"];', true],
  ["a ReturnType declaration", 'ReturnType<typeof standaloneSession>["held"]', "", true],
  ["an alias of a different method", "Local", 'type Local = Session["stamp"];', false],
  ["a retyped function", "() => null", "", false]
] as const) {
  test("held declaration self-test: " + name, () => {
    const probes = Object.fromEntries(([
      ["application/production/broll-records.ts", "RecordsReconcilerPorts", "held", "../session/document-session.ts", "../../bootstrap/wiring/session-owner.ts"],
      ["application/editing/undo/undo.ts", "UndoPorts", "held", "../../session/document-session.ts", "../../../bootstrap/wiring/session-owner.ts"],
      ["application/save/project-files.ts", "ProjectFilesPorts", "heldDocument", "../session/document-session.ts", "../../bootstrap/wiring/session-owner.ts"],
      ["application/session/session-merge-ports.ts", "SessionMergeSession", "held", "./document-session.ts", "../../bootstrap/wiring/session-owner.ts"]
    ] as const).map(([path, owner, field, contract, door]) => [path, `
      import type { StandaloneDocumentSession as Session } from "${contract}";
      import { standaloneSession } from "${door}";
      ${alias}
      export interface ${owner} { readonly ${field}: ${annotation} }
    `] as const));
    const found = typedStandaloneInventory(probes);
    assert.deepEqual(found.portMemberTypes, {
      "application/production/broll-records.ts#RecordsReconcilerPorts.held": allowed,
      "application/editing/undo/undo.ts#UndoPorts.held": allowed,
      "application/save/project-files.ts#ProjectFilesPorts.heldDocument": allowed,
      "application/session/session-merge-ports.ts#SessionMergeSession.held": allowed
    });
  });
}
