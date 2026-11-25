import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mountSharedPopover } from "../../../src/features/collaboration/shared-popover.ts";
import type { SharedPopoverPorts } from "../../../src/features/collaboration/ports.ts";
import { fakeSharedPopover } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function setup(t: TestContext, overrides: Partial<SharedPopoverPorts> = {}) {
  const h = viewHarness();
  const realm = globalThis as unknown as Record<string, unknown>;
  const saved = { window: realm.window, document: realm.document };
  Object.assign(realm, { window: h.window, document: h.document });
  const open = new WeakSet<Element>();
  const matches = h.window.HTMLElement.prototype.matches;
  Object.defineProperty(h.window.HTMLElement.prototype, "matches", {
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    }
  });
  h.window.HTMLElement.prototype.showPopover = function () { open.add(this); };
  h.window.HTMLElement.prototype.hidePopover = function () { open.delete(this); };
  const { collaboration, ports } = fakeSharedPopover(overrides);
  const popover = mountSharedPopover(ports);
  t.after(() => { popover.dispose(); Object.assign(realm, saved); h.window.close(); });
  const button = (action: string): HTMLButtonElement => {
    const control = h.document.querySelector<HTMLButtonElement>(`[data-sharing="${action}"]`);
    assert.ok(control, action);
    return control;
  };
  const connect = () => collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  collaboration.enter();
  return { ...h, popover, button, connect, collaboration };
}

test("a guest sees no owner controls, and removal hides owner controls and describes the retained work", t => {
  let role: "guest" | "owner" = "guest";
  const h = setup(t, { membership: () => ({ role, link: null }) });
  h.connect();
  h.popover.open();
  const ownerControls = ["copy", "reset", "stop"];
  assert.ok(ownerControls.every(action => h.button(action).hidden));
  assert.equal(h.button("save").textContent, "Save a copy…");
  role = "owner";
  h.collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 1 });
  assert.ok(ownerControls.every(action => !h.button(action).hidden));
  h.collaboration.setRefusal("script-deleted");
  assert.ok(ownerControls.every(action => h.button(action).hidden));
  assert.equal(h.document.querySelector("[data-connection]")?.textContent, "Access removed · local work kept");
  assert.equal(h.button("save").hidden, false);
  assert.equal(h.button("leave").hidden, false);
});

test("an owner without a link sees the reset hint and cannot stop sharing offline", t => {
  const h = setup(t, { membership: () => ({ role: "owner", link: null }) });
  h.popover.open();
  assert.equal(h.button("copy").disabled, true);
  assert.equal(h.el("shared-copy-hint").hidden, false);
  assert.match(h.el("shared-copy-hint").textContent ?? "", /Use Reset link/);
  assert.equal(h.button("stop").disabled, true);
  assert.equal(h.el("shared-stop-hint").hidden, false);
  assert.match(h.el("shared-stop-hint").textContent ?? "", /Connect to the relay/);
  h.connect();
  assert.equal(h.button("stop").disabled, false);
  assert.equal(h.el("shared-stop-hint").hidden, true);
});

test("double-click while reset is in flight runs one request", async t => {
  const requests: string[] = [];
  const pending = deferred<undefined>();
  const h = setup(t, {
    membership: () => ({ role: "owner", link: null }),
    manage(operation) { requests.push(operation); return pending.promise; }
  });
  h.connect();
  h.popover.open();
  h.button("reset").click();
  assert.equal(h.button("reset").disabled, true);
  h.fire(h.button("reset"), "click");
  assert.deepEqual(requests, ["reset"]);
  pending.resolve(undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.button("reset").disabled, false);
});

test("promotion availability starts hidden on every open and ignores an earlier check", async t => {
  const checks: ReturnType<typeof deferred<boolean>>[] = [];
  const h = setup(t, {
    membership: () => ({ role: "guest", link: null }),
    canManage() { const check = deferred<boolean>(); checks.push(check); return check.promise; }
  });
  h.popover.open();
  checks[0]?.resolve(true);
  await Promise.resolve();
  assert.equal(h.button("promote").hidden, false);

  h.button("close").click();
  h.popover.open();
  assert.equal(h.button("promote").hidden, true);
  h.button("close").click();
  h.popover.open();
  checks[1]?.resolve(true);
  checks[2]?.resolve(false);
  await Promise.resolve();
  assert.equal(checks.length, 3);
  assert.equal(h.button("promote").hidden, true);
});
