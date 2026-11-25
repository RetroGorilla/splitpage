import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mountSharedPopover } from "../../../src/features/collaboration/shared-popover.ts";
import type { SharedPopoverPorts } from "../../../src/features/collaboration/ports.ts";
import type { PresencePeer } from "../../../src/application/collaboration/presence.ts";
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
  const saved = { window: realm.window, document: realm.document, HTMLElement: realm.HTMLElement };
  Object.assign(realm, { window: h.window, document: h.document, HTMLElement: h.window.HTMLElement });
  const open = new WeakSet<Element>();
  const matches = h.window.HTMLElement.prototype.matches;
  Object.defineProperty(h.window.HTMLElement.prototype, "matches", {
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    }
  });
  h.window.HTMLElement.prototype.showPopover = function () { open.add(this); this.style.display = "block"; };
  h.window.HTMLElement.prototype.hidePopover = function () { open.delete(this); this.style.display = ""; };
  const { collaboration, ports, management, receivePeers } = fakeSharedPopover(overrides);
  const popover = mountSharedPopover(ports);
  t.after(() => { popover.dispose(); Object.assign(realm, saved); h.window.close(); });
  const button = (action: string): HTMLButtonElement => {
    const control = h.document.querySelector<HTMLButtonElement>(`[data-sharing="${action}"]`);
    assert.ok(control, action);
    return control;
  };
  const connect = () => collaboration.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  collaboration.enter();
  return { ...h, popover, button, connect, collaboration, management, receivePeers };
}

test("a guest sees no owner controls, and removal hides owner controls and describes the retained work", t => {
  let role: "guest" | "owner" = "guest";
  const h = setup(t, { membership: () => ({ role, link: null }) });
  h.connect();
  h.popover.open();
  const ownerControls = ["copy", "reset", "password", "stop"];
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
    async manage(operation) {
      requests.push(operation);
      if (operation === "reset") await pending.promise;
    }
  });
  h.connect();
  h.popover.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  h.button("reset").click();
  assert.equal(h.button("reset").disabled, true);
  h.fire(h.button("reset"), "click");
  assert.deepEqual(requests, ["check-link", "reset"]);
  pending.resolve(undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.button("reset").disabled, false);
});

test("the password controls let a connected owner require or remove the password", async t => {
  let required = false;
  const h = setup(t, { membership: () => ({ role: "owner", link: null, passwordRequired: required }) });
  const button = h.button("password");
  const here = h.el("shared-here-title").parentElement;
  assert.equal(here?.hidden, true);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  h.connect();
  h.popover.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(here?.hidden, false);
  assert.equal(here?.nextElementSibling, button.parentElement);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Require a password");
  button.click();
  const dialog = h.el("link-password-modal");
  const input = dialog.querySelector<HTMLInputElement>("input[type=password]");
  const form = dialog.querySelector<HTMLFormElement>("form");
  assert.ok(input && form);
  form.requestSubmit();
  assert.deepEqual(h.management, [["check-link"]]);
  input.value = "A link password";
  form.requestSubmit();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.management.at(-1), ["set-password", "A link password"]);
  assert.equal(input.value, "");
  required = true;
  h.popover.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(button.textContent, "Change password…");
  button.click();
  const remove = h.el("link-password-modal").querySelector<HTMLButtonElement>("[data-remove-password]");
  assert.ok(remove);
  assert.equal(remove.hidden, false);
  remove.click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.management.at(-1), ["remove-password"]);
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

test("the pill caps initials and the people list jumps to the latest beat", t => {
  const first = { name: "Ada Gray", color: "#80BDFB", view: "split", beat: "a", side: "audioText", caret: null } as const;
  const peers: PresencePeer[] = [1, 2, 3, 4].map(clientId => ({ clientId, ...first }));
  let notify = () => {};
  const jumps: [string, string][] = [];
  const h = setup(t, {
    presence: {
      peers: () => peers.slice(),
      onChange(listener) { notify = listener; return () => {}; }
    },
    revealBeat(id, side) { jumps.push([id, side]); }
  });
  h.connect();
  assert.equal(h.document.querySelectorAll("#shared-pill .person-avatar").length, 3);
  assert.match(h.el("shared-pill").textContent ?? "", /\+1$/);
  h.popover.open();
  const button = h.document.querySelector<HTMLButtonElement>("[data-here-now] button");
  const initial = h.document.querySelector("#shared-pill .person-avatar");
  assert.ok(button);
  assert.ok(initial);
  peers[0] = { clientId: 1, ...first, beat: "b" };
  notify();
  assert.equal(h.document.querySelector("[data-here-now] button"), button);
  assert.equal(h.document.querySelector("#shared-pill .person-avatar"), initial);
  button.click();
  assert.deepEqual(jumps, [["b", "audioText"]]);
});

test("the Shared popover wraps Tab only on phones, keeps focus when a peer leaves and returns it on Escape", t => {
  const h = setup(t);
  h.connect();
  h.receivePeers([{ clientId: 1, name: "Guest", color: "#80BDFB", view: "split", beat: "a", side: "audioText", caret: null }]);
  const trigger = h.el("shared-pill");
  trigger.focus();
  h.popover.open();
  const close = h.button("close");
  const panel = h.el("shared-popover");
  const root = h.el("root");
  assert.equal(h.document.activeElement, close);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const key = (key: string, shiftKey = false) => h.document.activeElement?.dispatchEvent(
    new h.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  assert.equal(panel.hasAttribute("aria-modal"), false);
  assert.equal(key("Tab", true), true);
  h.button("leave").focus();
  assert.equal(key("Tab"), true);
  close.focus();
  Object.defineProperty(h.window, "innerWidth", { value: 760 });
  h.fire(h.window, "resize");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(root.hasAttribute("inert"), true);
  assert.equal(key("Tab", true), false);
  assert.equal(h.document.activeElement, h.button("leave"));
  assert.equal(key("Tab"), false);
  assert.equal(h.document.activeElement, close);
  h.document.querySelector<HTMLButtonElement>("[data-here-now] button")?.focus();
  h.receivePeers([]);
  assert.equal(h.document.activeElement, close);
  key("Escape");
  assert.equal(h.document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(panel.hasAttribute("aria-modal"), false);
  assert.equal(root.hasAttribute("inert"), false);
});
