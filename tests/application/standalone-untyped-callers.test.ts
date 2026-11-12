import { test } from "node:test";
import assert from "node:assert/strict";
import { untypedStandaloneAccesses } from "./session-caller-scan.ts";

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
