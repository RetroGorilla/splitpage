import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountScreenStateOwner, screenStateOwner, stopScreenStateOwner } from "../../src/bootstrap/wiring/screen-state.ts";
import { askingFromLauncher, launcherShown, screen } from "../../src/bootstrap/wiring/ports/screen.ts";
import type { ScreenStatePorts } from "../../src/application/screen-state.ts";

const ports: ScreenStatePorts = {
  document: { current: () => null },
  flags: () => ({ tourOpen: () => false, writerOpen: () => false, brollPageOpen: () => false }),
  prompterOpen: () => false,
  page: { dialogShown: () => false, launcherShown: () => true }
};

test("the screen port refuses before the screen state starts and after it stops", () => {
  stopScreenStateOwner();
  assert.throws(() => screenStateOwner(), /not started/);
  assert.throws(() => screen(), /not started/);
  assert.throws(() => askingFromLauncher(() => 1), /not started/);
  assert.throws(() => launcherShown(), /not started/);
  const owner = mountScreenStateOwner(ports);
  assert.equal(screenStateOwner(), owner);
  assert.equal(screen().loading, true);
  assert.equal(screen().launcher, true);
  assert.equal(askingFromLauncher(() => screen().launcher), false);
  assert.equal(launcherShown(), true);
  stopScreenStateOwner();
  assert.throws(() => screen(), /not started/);
});

test("mounting again replaces the started screen state", () => {
  const first = mountScreenStateOwner(ports);
  const second = mountScreenStateOwner(ports);
  assert.notEqual(first, second);
  assert.equal(screenStateOwner(), second);
  stopScreenStateOwner();
});
