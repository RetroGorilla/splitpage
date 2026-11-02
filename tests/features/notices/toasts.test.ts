import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createToasts } from "../../../src/features/notices/toasts.ts";

function setup() {
  document.body.innerHTML = '<div id="toast-status" role="status" aria-atomic="false" aria-relevant="additions"></div>' +
    '<div id="toast-alert" role="alert" aria-atomic="false" aria-relevant="additions"></div><div id="toast-host"></div>';
  return { host: document.getElementById("toast-host") as HTMLElement, toasts: createToasts(window) };
}

test("a toast is added to the host with its kind, and fades out by itself", async () => {
  const { host, toasts } = setup();
  const notice = toasts.show("Saved", "ok");
  const el = host.firstElementChild as HTMLElement;
  assert.equal(el.className, "toast ok");
  assert.equal(el.textContent, "Saved");
  assert.equal(notice.isConnected, true);
  notice.dismiss();
  assert.ok(el.classList.contains("is-leaving"));
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(host.children.length, 0);
});

test("a sticky toast allows selecting its message and is dismissed by its accessible button", () => {
  const { host, toasts } = setup();
  toasts.show("Paused", "warn", true);
  const el = host.firstElementChild as HTMLElement;
  assert.equal(el.className, "toast warn is-sticky");
  assert.equal(el.hasAttribute("title"), false);
  el.click();
  assert.equal(el.classList.contains("is-leaving"), false);
  const dismiss = el.querySelector<HTMLButtonElement>('.toast-dismiss');
  assert.ok(dismiss);
  assert.equal(dismiss.type, "button");
  assert.equal(dismiss.getAttribute("aria-label"), "Dismiss");
  dismiss.click();
  assert.ok(el.classList.contains("is-leaving"));
});

test("an action toast runs its action once, dismisses itself", () => {
  const { host, toasts } = setup();
  let ran = 0;
  toasts.showAction("Deleted", "warn", "Undo", () => { ran++; });
  const el = host.firstElementChild as HTMLElement;
  assert.equal(el.className, "toast warn has-action");
  assert.equal(el.hasAttribute("title"), false);
  const button = el.querySelector(".toast-action") as HTMLButtonElement;
  assert.equal(button.textContent, "Undo");
  button.click();
  assert.equal(ran, 1);
  assert.ok(el.classList.contains("is-leaving"));
});

test("a sticky action toast can be dismissed without running its action", () => {
  const { host, toasts } = setup();
  let ran = 0;
  toasts.showAction("Redraw", "error", "Redraw", () => { ran++; }, true);
  const el = host.firstElementChild as HTMLElement;
  assert.ok(el.classList.contains("is-sticky"));
  assert.ok(el.classList.contains("has-action"));
  el.click();
  assert.equal(el.classList.contains("is-leaving"), false);
  const dismiss = el.querySelector<HTMLButtonElement>(".toast-dismiss");
  assert.ok(dismiss);
  dismiss.click();
  assert.ok(el.classList.contains("is-leaving"));
  assert.equal(ran, 0);
});

test("a plain toast has a keyboard focusable dismiss button", () => {
  const { host, toasts } = setup();
  toasts.show("Saved", "ok");
  const dismiss = host.querySelector<HTMLButtonElement>('.toast-dismiss');
  assert.ok(dismiss);
  dismiss.focus();
  assert.equal(document.activeElement, dismiss);
  dismiss.click();
  assert.ok(host.firstElementChild?.classList.contains("is-leaving"));
});

test("repeated plain refusals share a notice but distinct kinds, persistence and actions do not", () => {
  const { host, toasts } = setup();
  const first = toasts.show("Close Present first.", "warn");
  assert.equal(toasts.show("Close Present first.", "warn"), first);
  assert.equal(host.children.length, 1);
  assert.notEqual(toasts.show("Close Present first.", "error"), first);
  assert.notEqual(toasts.show("Close Present first.", "warn", true), first);
  const action = toasts.showAction("Close Present first.", "warn", "Undo", () => {});
  assert.notEqual(action, first);
  assert.notEqual(toasts.showAction("Close Present first.", "warn", "Undo", () => {}), action);
  first.dismiss();
  assert.notEqual(toasts.show("Close Present first.", "warn"), first);
});

test("plain, sticky and action messages announce once without their controls or repeated refusals", async () => {
  const { toasts } = setup();
  const status = document.getElementById("toast-status");
  const alert = document.getElementById("toast-alert");
  assert.ok(status && alert);
  const messages: string[] = [];
  const observer = new window.MutationObserver(records => {
    for (const record of records) for (const added of record.addedNodes) messages.push(added.textContent || "");
  });
  observer.observe(status, { childList: true, subtree: true, characterData: true });
  observer.observe(alert, { childList: true, subtree: true, characterData: true });
  const plain = toasts.show("Saved", "ok");
  const sticky = toasts.show("Paused", "warn", true);
  const action = toasts.showAction("Deleted", "warn", "Undo", () => {}, true);
  const error = toasts.show("Could not open", "error", true);
  toasts.show("Paused", "warn", true);
  assert.equal(status.textContent, "SavedPausedDeleted");
  assert.equal(alert.textContent, "Could not open");
  for (const notice of [plain, sticky, action, error]) notice.dismiss();
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.deepEqual(messages, ["Saved", "Paused", "Deleted", "Could not open"]);
  observer.disconnect();
});
