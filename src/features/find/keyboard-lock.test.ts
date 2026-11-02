import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { captureFindEscape } from "./keyboard-lock.ts";

test("Find captures only Escape in fullscreen and cancels a pending lock when closed", async () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const calls: unknown[] = [];
  let finish: () => void = () => {};
  Object.defineProperty(win.document, "fullscreenElement", { value: win.document.documentElement });
  Object.defineProperty(win.navigator, "keyboard", { value: {
    lock: (keys: string[]) => { calls.push(keys); return new Promise<void>(resolve => { finish = resolve; }); },
    unlock: () => { calls.push("unlock"); }
  } });
  const close = captureFindEscape(win);
  assert.deepEqual(calls, [["Escape"]]);
  close(); close();
  finish(); await Promise.resolve();
  assert.deepEqual(calls, [["Escape"], "unlock"]);
  win.close();
});

test("Find follows fullscreen changes only during its lifetime and ignores stale request failures", async () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  let fullscreen: Element | null = null;
  let rejectOld: (error: Error) => void = () => {};
  let locks = 0, unlocks = 0;
  Object.defineProperty(win.document, "fullscreenElement", { get: () => fullscreen });
  Object.defineProperty(win.navigator, "keyboard", { value: {
    lock: () => { locks++; return locks === 1 ? new Promise<void>((_, reject) => { rejectOld = reject; }) : Promise.resolve(); },
    unlock: () => { unlocks++; }
  } });
  const changed = () => win.document.dispatchEvent(new win.Event("fullscreenchange"));
  const close = captureFindEscape(win);
  assert.equal(locks, 0);
  fullscreen = win.document.documentElement; changed();
  fullscreen = null; changed();
  fullscreen = win.document.documentElement; changed();
  rejectOld(new Error("aborted")); await Promise.resolve();
  close(); changed();
  assert.equal(locks, 2);
  assert.equal(unlocks, 2);
  win.close();
});

test("unsupported and refused Keyboard Lock leave Find's normal Escape handlers available", async () => {
  for (const mode of ["unsupported", "reject", "throw"] as const) {
    const win = jsdomWindow() as unknown as Window & typeof globalThis;
    Object.defineProperty(win.document, "fullscreenElement", { value: win.document.documentElement });
    let unlocks = 0;
    if (mode !== "unsupported") Object.defineProperty(win.navigator, "keyboard", { value: {
      lock: () => { if (mode === "throw") throw new Error("refused"); return Promise.reject(new Error("refused")); },
      unlock: () => { unlocks++; }
    } });
    let escapes = 0;
    win.addEventListener("keydown", () => { escapes++; });
    const close = captureFindEscape(win);
    await Promise.resolve();
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    close();
    assert.equal(escapes, 1, mode);
    assert.equal(unlocks, 0, mode);
    win.close();
  }
});
