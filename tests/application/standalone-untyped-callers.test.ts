import { test } from "node:test";
import assert from "node:assert/strict";
import { typedStandaloneInventory, untypedStandaloneAccesses } from "./session-caller-scan.ts";
import { capabilityPortCallers } from "./capability-caller-scan.ts";

test("untyped app tests reach standalone members only through the standalone door", () => {
  assert.deepEqual(untypedStandaloneAccesses(), {});
});

test("the untyped inventory follows imported and returned aliases and computed member access", () => {
  const probe = `
    import { liveSession as active, standaloneSession } from "../bootstrap/wiring/session-owner.ts";
    import * as bridge from "../bootstrap/wiring/session-owner.ts";
    const session = active();
    const door = bridge.liveSession;
    active().noteEdit();
    session.absorbDisk({});
    door()["adopt"]({});
    bridge.liveSession().settle("disk");
    const { stamp: mark } = session;
    mark({});
    standaloneSession().noteEdit();
    session.generation();
    const unrelated = { noteEdit() {} };
    unrelated.noteEdit();
  `;
  assert.deepEqual(untypedStandaloneAccesses(probe), {
    "src/test/session-caller-probe.mjs": ["absorbDisk", "adopt", "noteEdit", "settle", "stamp"]
  });
});

for (const [name, source] of [
  ["computed literal binding names", 'const { ["noteEdit"]: edit } = liveSession();'],
  ["destructuring assignment", 'let edit; ({ noteEdit: edit } = liveSession());'],
  ["nested binding patterns", 'const { session: { noteEdit: edit } } = { session: liveSession() };']
]) {
  test("the untyped inventory detects " + name, () => {
    assert.deepEqual(untypedStandaloneAccesses(`
      import { liveSession } from "../bootstrap/wiring/session-owner.ts";
      ${source}
    `), { "src/test/session-caller-probe.mjs": ["noteEdit"] });
  });
}

test("a rest binding called held is not a read of the standalone held member", () => {
  assert.deepEqual(untypedStandaloneAccesses(`
    import { liveSession } from "../bootstrap/wiring/session-owner.ts";
    const { ...held } = liveSession();
    held.generation();
  `), {});
});

const UNSEEN_COMPUTED_KEYS = [
  { name: "a non-literal key held in a variable", source: 'const key = "noteEdit"; liveSession()[key]();' },
  { name: "a non-literal key built by concatenation", source: 'liveSession()["note" + "Edit"]();' }
];

for (const limit of UNSEEN_COMPUTED_KEYS) {
  test("declared scan limit: " + limit.name, () => {
    assert.deepEqual(untypedStandaloneAccesses(`
      import { liveSession } from "../bootstrap/wiring/session-owner.ts";
      ${limit.source}
    `), {});
  });
}

const TYPED_SCAN_LIMITS = [
  { name: "a receiver deliberately erased to any", source: 'const erased = standaloneSession() as any; erased.stamp(null!);' },
  { name: "a receiver lookup widened to string", source: 'const door = "standalone" + "Session"; bridge[door]().stamp(null!);' },
  { name: "a reflective lookup returning an untyped callback", source: 'Reflect.get(standaloneSession(), "stamp")(null!);' }
];

const SAVE_SCAN_LIMITS = [
  { name: "reflective lookup of an untyped file writer", source: 'Reflect.get(fileTargets, "writeToHandle")(null!, "body");' }
];

for (const limit of SAVE_SCAN_LIMITS) {
  test("declared typed save scan limit: " + limit.name, () => {
    assert.deepEqual(capabilityPortCallers(["adapters/files/file-target.ts#writeToHandle"], {
      path: "starters/save-type-probe.ts", source: `
        import * as fileTargets from "../adapters/files/file-target.ts";
        ${limit.source}
      `
    }), { "adapters/files/file-target.ts#writeToHandle": {} });
  });
}

for (const limit of TYPED_SCAN_LIMITS) {
  test("declared typed scan limit: " + limit.name, () => {
    const found = typedStandaloneInventory({ "starters/session-type-probe.ts": `
      import { standaloneSession } from "../bootstrap/wiring/session-owner.ts";
      import * as bridge from "../bootstrap/wiring/session-owner.ts";
      ${limit.source}
    ` });
    assert.deepEqual(found.members, { stamp: {}, amend: {}, noteEdit: {}, held: {} });
    assert.deepEqual(found.dynamicAccesses, {});
    assert.deepEqual(found.typePositions, {});
  });
}
