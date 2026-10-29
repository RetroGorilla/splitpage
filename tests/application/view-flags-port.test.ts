import "../../src/test/_dom.mjs";
import { flags as portFlags } from "../../src/bootstrap/wiring/ports/preferences.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import { startPreferences, viewFlags } from "../../src/bootstrap/wiring/preferences-owner.ts";

test("the find flags port reads and writes the current legacy view flags across restarts", () => {
  const flags = portFlags;
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
