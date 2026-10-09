import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createQuitWatchdog } = require(path.join(here, "..", "quit-watchdog.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let first = null;
        for (const [id, t] of timers) if (t.at <= end && (!first || t.at < first[1].at)) first = [id, t];
        if (!first) break;
        timers.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = end;
    },
    pending() { return timers.size; }
  };
}

test("with nothing waiting, it gives up after the delay and not before", () => {
  const clock = fakeClock();
  let expired = 0;
  createQuitWatchdog(3000, () => false, () => { expired++; }, clock);
  clock.advance(2999);
  assert.equal(expired, 0);
  clock.advance(1);
  assert.equal(expired, 1);
  clock.advance(10000);
  assert.equal(expired, 1);
});

test("while a quit is still waiting on the user, it keeps waiting", () => {
  const clock = fakeClock();
  let waiting = true;
  let expired = 0;
  createQuitWatchdog(3000, () => waiting, () => { expired++; }, clock);
  clock.advance(20000);
  assert.equal(expired, 0);
  waiting = false;
  clock.advance(3000);
  assert.equal(expired, 1);
});

test("a user who answers after 4 s still gets the full delay for the quit to finish", () => {
  const clock = fakeClock();
  let waiting = true;
  let expired = 0;
  const dog = createQuitWatchdog(3000, () => waiting, () => { expired++; }, clock);
  clock.advance(4000);
  waiting = false;
  dog.restart();
  clock.advance(2999);
  assert.equal(expired, 0);
  clock.advance(1);
  assert.equal(expired, 1);
});

test("restart gives a fresh delay even when nothing was waiting", () => {
  const clock = fakeClock();
  let expired = 0;
  const dog = createQuitWatchdog(3000, () => false, () => { expired++; }, clock);
  clock.advance(2500);
  dog.restart();
  clock.advance(2999);
  assert.equal(expired, 0);
  clock.advance(1);
  assert.equal(expired, 1);
});

test("once stopped it never fires, and restart does nothing", () => {
  const clock = fakeClock();
  let expired = 0;
  const dog = createQuitWatchdog(3000, () => false, () => { expired++; }, clock);
  dog.stop();
  dog.restart();
  clock.advance(10000);
  assert.equal(expired, 0);
  assert.equal(clock.pending(), 0);
});

test("after it fires, restart does nothing", () => {
  const clock = fakeClock();
  let expired = 0;
  const dog = createQuitWatchdog(3000, () => false, () => { expired++; }, clock);
  clock.advance(3000);
  dog.restart();
  clock.advance(10000);
  assert.equal(expired, 1);
});

test("with the real timers it fires", async () => {
  let expired = 0;
  createQuitWatchdog(20, () => false, () => { expired++; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(expired, 1);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
