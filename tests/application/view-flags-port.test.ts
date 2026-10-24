import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { startPreferences, viewFlags } from "../../src/legacy/preferences-bridge.ts";

test("the find flags port reads and writes the current legacy view flags across restarts", () => {
  const { flags } = sharedPorts();
  const start = (): (() => void) => startPreferences({ storage: () => null, announce: () => {} });
  let stop = start();
  try {
    assert.equal(flags.findOpen(), false);
    viewFlags().setFindOpen(true);
    assert.equal(flags.findOpen(), true);
    viewFlags().setFindOpen(false);
    assert.equal(flags.findOpen(), false);
    flags.setFindOpen(true);
    assert.equal(viewFlags().findOpen(), true);
    flags.setFindOpen(false);
    assert.equal(viewFlags().findOpen(), false);

    const first = viewFlags();
    first.setFindOpen(true);
    stop();
    stop = start();
    assert.equal(flags.findOpen(), false);
    flags.setFindOpen(true);
    assert.equal(viewFlags().findOpen(), true);
    flags.setFindOpen(false);
    assert.equal(viewFlags().findOpen(), false);
    assert.equal(first.findOpen(), true);
    viewFlags().setFindOpen(true);
    assert.equal(flags.findOpen(), true);
  } finally {
    stop();
  }
});
