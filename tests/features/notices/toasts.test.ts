import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createToasts } from "../../../src/features/notices/toasts.ts";

function setup() {
  document.body.innerHTML = '<div id="toast-host"></div>';
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

test("a sticky toast stays until it is clicked", () => {
  const { host, toasts } = setup();
  toasts.show("Paused", "warn", true);
  const el = host.firstElementChild as HTMLElement;
  assert.equal(el.className, "toast warn is-sticky");
  assert.equal(el.title, "Click to dismiss");
  el.click();
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

test("a sticky action toast keeps its dismiss-on-click", () => {
  const { host, toasts } = setup();
  toasts.showAction("Redraw", "error", "Redraw", () => {}, true);
  const el = host.firstElementChild as HTMLElement;
  assert.ok(el.classList.contains("is-sticky"));
  assert.ok(el.classList.contains("has-action"));
  assert.equal(el.title, "Click to dismiss");
});
