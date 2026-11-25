import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountJoinDialog } from "../../../src/features/collaboration/join.ts";
import { mountLeaveDialog } from "../../../src/features/collaboration/leave.ts";
import { PERSON_COLORS } from "../../../src/core/document/person-colors.ts";

test("the Join screen shows the preview, saves identity and cancels the active download", async t => {
  const names: string[] = [], colours: (string | null)[] = [];
  let cancelled = false;
  t.after(mountJoinDialog({
    editor: () => "Anonymous",
    identity: {
      myColor: () => "", setCommentAuthor: name => { names.push(name); }, setMyColor: colour => { colours.push(colour); }
    },
    check: async () => ({
      kind: "ready", title: "Shared scene", beats: 4, pictures: 2,
      join(signal, progress) {
        progress(2);
        return new Promise(resolve => signal.addEventListener("abort", () => {
          cancelled = true;
          resolve("cancelled");
        }, { once: true }));
      }
    }),
    settled: () => {}
  }, { kind: "browser", invitation: false }).dispose);
  await Promise.resolve();
  assert.equal(document.querySelector("#join-script-summary h3")?.textContent, "Shared scene");
  assert.equal(document.querySelector("#join-script-summary p")?.textContent, "4 beats · 2 pictures");
  assert.equal(document.querySelectorAll(".swatch-dot").length, PERSON_COLORS.length);
  const name = document.querySelector<HTMLInputElement>("#join-script-name");
  const colour = document.querySelectorAll<HTMLInputElement>("input[name=join-colour]")[1];
  assert.ok(name && colour);
  name.value = "  Guest Editor  ";
  colour.checked = true;
  document.querySelector<HTMLButtonElement>("#join-script-modal [type=submit]")?.click();
  assert.deepEqual(names, ["Guest Editor"]);
  assert.deepEqual(colours, [PERSON_COLORS[1]]);
  assert.match(document.querySelector("[role=status]")?.textContent ?? "", /Downloading pictures.*2 remaining/);
  document.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.click();
  assert.equal(cancelled, true);
  assert.equal(document.querySelector("#join-script-modal"), null);
});

for (const [reason, message] of [
  ["bad-link", "This invitation link is invalid."],
  ["invitation-revoked", "This invitation link has been reset or revoked."],
  ["script-deleted", "This shared script was deleted."],
  ["unsupported-version", "This shared script needs a newer version of Splitpage."],
  ["relay-unreachable", "Could not reach the relay."],
  ["script-too-large-for-connection", "This script is too large to load over this connection."]
] as const) {
  test("the Join screen explains " + reason, async t => {
    t.after(mountJoinDialog({
      editor: () => "Guest Editor",
      identity: { myColor: () => "", setCommentAuthor() {}, setMyColor() {} },
      check: async () => ({ kind: "failed", reason }),
      settled: () => {}
    }, { kind: "browser", invitation: false }).dispose);
    await Promise.resolve();
    assert.ok(document.querySelector("#join-script-status")?.textContent?.startsWith(message));
    const retryable = reason === "relay-unreachable" || reason === "script-too-large-for-connection";
    assert.equal(document.querySelector<HTMLButtonElement>("#join-script-modal [type=submit]")?.hidden, !retryable);
  });
}

test("Leave only disconnects after Save a copy first succeeds", async t => {
  const leave = t.mock.fn(async () => true);
  let saved = false;
  t.after(mountLeaveDialog({ leave, saveCopy: async () => saved }).dispose);
  const button = document.querySelector<HTMLButtonElement>("[data-save-copy]");
  assert.ok(button);
  assert.equal(button.textContent, "Save a copy first…");
  button.click();
  await Promise.resolve();
  assert.equal(leave.mock.callCount(), 0);
  assert.equal(button.disabled, false);
  saved = true;
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(leave.mock.callCount(), 1);
  assert.equal(document.querySelector("#leave-script-modal"), null);
});

test("cancelling the file-copy choice leaves the Leave dialog open without an error", async t => {
  const leave = t.mock.fn(async () => "cancelled" as const);
  const dialog = mountLeaveDialog({ leave, saveCopy: async () => true });
  t.after(dialog.dispose);
  const button = document.querySelector<HTMLButtonElement>("[data-leave-script]");
  assert.ok(button);
  button.click();
  await Promise.resolve();
  assert.equal(leave.mock.callCount(), 1);
  assert.equal(dialog.signal.aborted, false);
  assert.equal(button.disabled, false);
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelector("#leave-script-modal [role=status]")?.textContent, "");
});

test("Try again checks the original browser invitation and joins after recovery", async t => {
  const request = { kind: "browser", invitation: { script: "script", token: "a".repeat(43) } } as const;
  let reachable = false;
  const join = t.mock.fn(async () => null);
  t.after(mountJoinDialog({
    editor: () => "Guest Editor",
    identity: { myColor: () => "", setCommentAuthor() {}, setMyColor() {} },
    async check(invite) {
      assert.equal(invite, request);
      return reachable ? { kind: "ready", title: "Shared scene", beats: 1, pictures: 0, join }
        : { kind: "failed", reason: "relay-unreachable" };
    },
    settled() {}
  }, request).dispose);
  await Promise.resolve();
  const submit = document.querySelector<HTMLButtonElement>("#join-script-modal [type=submit]");
  assert.ok(submit);
  assert.equal(submit.textContent, "Try again");
  assert.equal(submit.hidden, false);
  reachable = true;
  submit.click();
  await Promise.resolve();
  assert.equal(submit.textContent, "Join script");
  assert.equal(document.querySelector("#join-script-summary h3")?.textContent, "Shared scene");
  submit.click();
  await Promise.resolve();
  assert.equal(join.mock.callCount(), 1);
  assert.equal(document.querySelector("#join-script-modal"), null);
});
