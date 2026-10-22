import test from "node:test";
import assert from "node:assert/strict";
import { createViewLifetime } from "../../../src/features/common/view-lifetime.ts";

test("guard: replaces connectivity checks, receives each target and stops running after disposal", () => {
  const document = new EventTarget();
  const window = Object.assign(new EventTarget(), { document }) as unknown as Window;
  const target = new EventTarget();
  const checked: EventTarget[] = [];
  let allowed = true;
  let calls = 0;
  const life = createViewLifetime(window, (current) => {
    checked.push(current);
    return allowed;
  });
  let held: EventListener | undefined;
  const add = target.addEventListener.bind(target);
  target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
    assert.equal(typeof listener, "function");
    held = listener as EventListener;
    add(type, listener, options);
  };
  for (const current of [target, window, document]) life.listen(current, "click", () => { calls++; });
  for (const current of [target, window, document]) current.dispatchEvent(new Event("click"));
  assert.equal(calls, 3);
  allowed = false;
  for (const current of [target, window, document]) current.dispatchEvent(new Event("click"));
  assert.equal(calls, 3);
  assert.deepEqual(checked, [target, window, document, target, window, document]);
  life.dispose();
  allowed = true;
  assert.ok(held);
  held(new Event("click"));
  assert.equal(calls, 3);
  assert.equal(checked.length, 6);
});
