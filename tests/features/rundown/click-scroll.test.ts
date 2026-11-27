import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { animateRundownClick } from "../../../src/features/rundown/click-scroll.ts";
import { fakeDocument } from "../fakes.ts";

function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  const events = new EventTarget();
  const source = fakeDocument();
  let nextFrame = 0;
  let x = 10;
  let y = 100;
  let reduced = false;
  const view = {
    get scrollX() { return x; },
    get scrollY() { return y; },
    performance: { now: () => 1000 },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    scrollTo: (options: ScrollToOptions) => { x = options.left ?? x; y = options.top ?? y; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  } as unknown as Window;
  const row = document.createElement("div");
  const container = document.createElement("div");
  container.append(row);
  document.body.append(container);
  row.scrollIntoView = () => { x = 50; y = 1100; };
  const frame = (elapsed: number) => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(1000 + elapsed);
  };
  return {
    row, container, view, frames, events, document: source.document,
    position: () => [x, y],
    reduce: () => { reduced = true; },
    scroll: (top: number) => { y = top; },
    frame,
    start: (elapsed = 0) => {
      const cancel = animateRundownClick(row, view, source.document);
      frame(elapsed);
      return cancel;
    }
  };
}

test("a Rundown click eases out for 200 ms and lands exactly at the existing jump destination", () => {
  const env = setup();
  animateRundownClick(env.row, env.view, env.document);
  assert.deepEqual(env.position(), [10, 100]);
  env.frame(0);
  env.frame(100);
  assert.deepEqual(env.position(), [45, 975]);
  env.frame(200);
  assert.deepEqual(env.position(), [50, 1100]);
  env.frame(217);
  env.frame(234);
  assert.equal(env.frames.size, 0);
});

test("a delayed first Rundown frame still eases through an intermediate position", () => {
  const env = setup();
  env.start(225);
  assert.deepEqual(env.position(), [10, 100]);
  env.frame(325);
  assert.deepEqual(env.position(), [45, 975]);
  env.frame(425);
  assert.deepEqual(env.position(), [50, 1100]);
  env.frame(442);
  env.frame(459);
  assert.equal(env.frames.size, 0);
});

test("reduced motion uses the existing jump immediately without scheduling frames", () => {
  const env = setup();
  env.reduce();
  animateRundownClick(env.row, env.view, env.document);
  assert.deepEqual(env.position(), [50, 1100]);
  assert.equal(env.frames.size, 0);
});

test("turning on reduced motion takes effect on the next navigation", () => {
  const env = setup();
  env.start();
  env.frame(200);
  env.frame(217);
  env.frame(234);
  env.reduce();
  env.scroll(4000);
  animateRundownClick(env.row, env.view, env.document);
  assert.deepEqual(env.position(), [50, 1100]);
  assert.equal(env.frames.size, 0);
});

test("an upward click survives scroll anchoring and remeasures the native destination after layout changes", () => {
  const env = setup();
  env.scroll(4000);
  env.row.scrollIntoView = () => { env.scroll(0); };
  env.start();
  env.scroll(4003);
  env.events.dispatchEvent(new Event("scroll"));
  env.frame(100);
  assert.deepEqual(env.position(), [10, 500]);
  assert.equal(env.frames.size, 1);
  env.row.scrollIntoView = () => { env.scroll(25); };
  env.frame(200);
  assert.deepEqual(env.position(), [10, 25]);
  env.frame(217);
  env.frame(234);
  assert.equal(env.frames.size, 0);
});

test("Rundown stays centered through an ancestor's transform after the scroll eases out", () => {
  const env = setup();
  const animation = {
    pending: false,
    playState: "running",
    effect: {
      getComputedTiming: () => ({ endTime: 180 }),
      getKeyframes: () => [{ transform: "translateY(26px)" }, { transform: "none" }]
    }
  };
  Object.defineProperty(env.container, "getAnimations", { value: () => [animation] });
  env.start();
  env.frame(200);
  assert.deepEqual(env.position(), [50, 1100]);
  assert.equal(env.frames.size, 1);

  animation.playState = "finished";
  env.row.scrollIntoView = () => { env.scroll(1098); };
  env.frame(250);
  assert.deepEqual(env.position(), [50, 1098]);
  env.frame(267);
  env.frame(284);
  assert.equal(env.frames.size, 0);
});

for (const event of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown", "beforeinput"]) {
  test("user " + event + " cancels a Rundown click without moving again", () => {
    const env = setup();
    env.start();
    env.frame(100);
    env.events.dispatchEvent(new Event(event));
    env.frame(200);
    assert.deepEqual(env.position(), [45, 975]);
    assert.equal(env.frames.size, 0);
  });
}

test("a user scroll cancels even when the next animation frame precedes its scroll event", () => {
  const env = setup();
  env.start();
  env.frame(100);
  env.events.dispatchEvent(new Event("wheel"));
  env.scroll(700);
  env.frame(200);
  assert.deepEqual(env.position(), [45, 700]);
  assert.equal(env.frames.size, 0);
});

test("animation scroll events do not cancel but user scroll input does", () => {
  const env = setup();
  env.start();
  env.frame(100);
  env.events.dispatchEvent(new Event("scroll"));
  assert.equal(env.frames.size, 1);
  env.events.dispatchEvent(new Event("wheel"));
  env.scroll(700);
  env.events.dispatchEvent(new Event("scroll"));
  assert.equal(env.frames.size, 0);
  env.frame(200);
  assert.deepEqual(env.position(), [45, 700]);
});

test("a replacement click starts from the current position and the cancelled callback cannot write", () => {
  const env = setup();
  const cancel = env.start();
  const stale = [...env.frames.values()][0];
  env.frame(100);
  cancel();
  env.row.scrollIntoView = () => { env.scroll(2100); };
  animateRundownClick(env.row, env.view, env.document);
  stale?.(1200);
  assert.deepEqual(env.position(), [45, 975]);
  env.frame(100);
  assert.deepEqual(env.position(), [45, 975]);
  env.frame(300);
  assert.deepEqual(env.position(), [45, 2100]);
  env.frame(317);
  env.frame(334);
  assert.equal(env.frames.size, 0);
});

test("disposing or removing the target stops all later movement", () => {
  for (const remove of [false, true]) {
    const env = setup();
    const cancel = env.start();
    env.frame(100);
    if (remove) env.row.remove();
    else cancel();
    env.frame(200);
    assert.deepEqual(env.position(), [45, 975]);
    assert.equal(env.frames.size, 0);
  }
});
