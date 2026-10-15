import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT_CLICK_ORDER, ROOT_MOUSEDOWN_ORDER, createRootRouter } from "../../../src/features/routing/root-router.ts";
import { owned } from "../../../src/features/routing/owned.ts";

test("routes run in the declared order and stop at the first that handles the event", () => {
  const seen: string[] = [];
  const router = createRootRouter(["a", "b", "c"] as const);
  router.route("c", () => { seen.push("c"); return true; });
  router.route("a", () => { seen.push("a"); return false; });
  router.route("b", () => { seen.push("b"); return true; });
  router.handle({});
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(router.routed(), ["a", "b", "c"]);
});

test("the gate runs first and a refused event reaches no route", () => {
  let refuse = true;
  let routed = 0;
  const router = createRootRouter(["a"] as const, () => refuse);
  router.route("a", () => { routed++; return true; });
  router.handle({});
  assert.equal(routed, 0);
  refuse = false;
  router.handle({});
  assert.equal(routed, 1);
});

test("a slot takes one handler; unrouting frees it, and a stale unroute does not remove its successor", () => {
  const router = createRootRouter(["a"] as const);
  const first = (): boolean => true;
  const off = router.route("a", first);
  assert.throws(() => router.route("a", () => true), /already taken/);
  off();
  assert.deepEqual(router.routed(), []);
  const second = (): boolean => true;
  router.route("a", second);
  off();
  assert.deepEqual(router.routed(), ["a"]);
});

test("unknown and repeated slots are refused", () => {
  const router = createRootRouter(["a"] as const);
  assert.throws(() => router.route("b" as "a", () => true), /no root route slot/);
  assert.throws(() => createRootRouter(["a", "a"]), /listed twice/);
});

test("the click order lists the thirteen delegated routes once", () => {
  assert.equal(ROOT_CLICK_ORDER.length, 13);
  assert.equal(new Set(ROOT_CLICK_ORDER).size, 13);
});

test("the click and mousedown orders keep the ledger's B02 to B57 order", () => {
  assert.deepEqual([...ROOT_CLICK_ORDER], [
    "rows-add",
    "toolbar",
    "video",
    "comments",
    "tags-jump",
    "comments-jump",
    "tags",
    "history-restore",
    "rows-scene",
    "rows-menu",
    "media-picker",
    "gallery",
    "media-link"
  ]);
  assert.deepEqual([...ROOT_MOUSEDOWN_ORDER], ["tags-anchor"]);
});

test("owned replaces its owner, unrouting and disposing the previous one first, and stop is idempotent", () => {
  const log: string[] = [];
  const slot = owned<{ dispose: () => void; name: string }>();
  const make = (name: string) => () => ({ name, dispose: () => { log.push(`dispose ${name}`); } });
  const routes = (owner: { name: string }) => [() => { log.push(`unroute ${owner.name}`); }];
  slot.replace(make("one"), routes);
  assert.equal(slot.owner()?.name, "one");
  slot.replace(make("two"), routes);
  assert.deepEqual(log, ["unroute one", "dispose one"]);
  slot.stop();
  slot.stop();
  assert.deepEqual(log, ["unroute one", "dispose one", "unroute two", "dispose two"]);
  assert.equal(slot.owner(), null);
});

test("owned stops a new owner whose routes fail to register", () => {
  const log: string[] = [];
  const slot = owned<{ dispose: () => void }>();
  assert.throws(() => slot.replace(() => ({ dispose: () => { log.push("dispose"); } }), () => { throw new Error("taken"); }), /taken/);
  assert.deepEqual(log, ["dispose"]);
  assert.equal(slot.owner(), null);
});
