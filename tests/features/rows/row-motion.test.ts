import "../../../src/test/_dom.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { rowMotionKey, withRowMotion } from "../../../src/features/rows/row-motion.js";

interface Played {
  readonly node: Element;
  readonly frames: Record<string, unknown>[];
  readonly options: { duration: number; easing: string };
}

type AnimatableProto = { animate?: unknown; getBoundingClientRect: () => DOMRect };

const proto = Element.prototype as unknown as AnimatableProto;
const win = window as unknown as { matchMedia?: unknown };

function setup(t: TestContext, options: { visible?: boolean; reduced?: boolean; animate?: boolean } = {}): Played[] {
  const played: Played[] = [];
  const savedAnimate = proto.animate;
  const savedRect = proto.getBoundingClientRect;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  if (options.animate !== false) {
    proto.animate = function (this: Element, frames: Record<string, unknown>[], opts: Played["options"]) {
      played.push({ node: this, frames, options: opts });
      return {};
    };
  } else {
    delete proto.animate;
  }
  proto.getBoundingClientRect = function (this: Element) {
    return { top: Number(this.getAttribute("data-top") ?? 0), left: 0, width: 100, height: 20 } as DOMRect;
  };
  Object.defineProperty(document, "hidden", { configurable: true, value: options.visible === false });
  win.matchMedia = (query: string) => ({ matches: options.reduced === true && query.includes("reduce") });
  t.after(() => {
    if (savedAnimate === undefined) delete proto.animate;
    else proto.animate = savedAnimate;
    proto.getBoundingClientRect = savedRect;
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else delete (document as unknown as { hidden?: boolean }).hidden;
    delete win.matchMedia;
    document.head.querySelectorAll("style[data-motion-test]").forEach((style) => style.remove());
  });
  return played;
}

function rows(tops: Record<string, number>): HTMLElement {
  const host = document.createElement("div");
  for (const [id, top] of Object.entries(tops)) host.appendChild(row(id, top));
  return host;
}

function row(id: string, top: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.setAttribute("data-id", id);
  el.setAttribute("data-top", String(top));
  return el;
}

function byId(host: Element, id: string): Element {
  return host.querySelector('[data-id="' + id + '"]') as Element;
}

test("rowMotionKey: names rows by id and hidden-shot strips by their ids", () => {
  const r = document.createElement("div");
  r.className = "row other";
  r.setAttribute("data-id", "r7");
  assert.equal(rowMotionKey(r), "row:r7");
  const strip = document.createElement("div");
  strip.className = "hidden-shot-strip";
  strip.setAttribute("data-ids", "a,b");
  assert.equal(rowMotionKey(strip), "strip:a,b");
});

test("rowMotionKey: gives no key to other elements or to nothing", () => {
  assert.equal(rowMotionKey(document.createElement("div")), null);
  assert.equal(rowMotionKey(null), null);
  assert.equal(rowMotionKey(undefined), null);
  assert.equal(rowMotionKey({}), null);
});

test("withRowMotion: slides a moved row from its old place and ignores moves under one pixel", (t) => {
  const played = setup(t);
  const host = rows({ a: 0, b: 20, c: 40 });
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "a").setAttribute("data-top", "40");
    byId(host, "b").setAttribute("data-top", "0");
    byId(host, "c").setAttribute("data-top", "40.5");
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 2);
  assert.equal(played[0]?.node, byId(host, "a"));
  assert.deepEqual(played[0]?.frames, [{ transform: "translateY(-40px)" }, { transform: "translateY(0)" }]);
  assert.equal(played[1]?.node, byId(host, "b"));
  assert.deepEqual(played[1]?.frames, [{ transform: "translateY(20px)" }, { transform: "translateY(0)" }]);
  assert.equal(played[0]?.options.duration, 180);
});

test("withRowMotion: reads the move and enter durations from the page styles", (t) => {
  const played = setup(t);
  const style = document.createElement("style");
  style.setAttribute("data-motion-test", "");
  style.textContent = ":root { --dur-move: 90ms; --dur-enter: 0.4s; }";
  document.head.appendChild(style);
  const host = rows({ a: 0, b: 20 });
  withRowMotion(host, () => {
    byId(host, "a").setAttribute("data-top", "20");
    host.appendChild(row("n", 60));
  });
  const moved = played.find((p) => p.node === byId(host, "a"));
  const entered = played.find((p) => p.node === byId(host, "n"));
  assert.equal(moved?.options.duration, 90);
  assert.equal(entered?.options.duration, 400);
});

test("withRowMotion: fades in a row that was added and plays nothing for a removed row", (t) => {
  const played = setup(t);
  const host = rows({ a: 0, b: 20 });
  withRowMotion(host, () => {
    host.appendChild(row("n", 40));
  });
  assert.equal(played.length, 1);
  assert.equal(played[0]?.node, byId(host, "n"));
  assert.deepEqual(played[0]?.frames, [
    { opacity: 0, transform: "translateY(-6px)" },
    { opacity: 1, transform: "translateY(0)" }
  ]);
  played.length = 0;
  withRowMotion(host, () => {
    byId(host, "b").remove();
  });
  assert.equal(played.length, 0);
});

test("withRowMotion: moves rows below a removed row up without fading anything", (t) => {
  const played = setup(t);
  const host = rows({ a: 0, b: 20, c: 40 });
  withRowMotion(host, () => {
    byId(host, "b").remove();
    byId(host, "c").setAttribute("data-top", "20");
  });
  assert.equal(played.length, 1);
  assert.equal(played[0]?.node, byId(host, "c"));
  assert.deepEqual(played[0]?.frames[0], { transform: "translateY(20px)" });
});

test("withRowMotion: treats more than four added rows as a bulk change and skips the fade", (t) => {
  const played = setup(t);
  const host = rows({ a: 0 });
  withRowMotion(host, () => {
    byId(host, "a").setAttribute("data-top", "100");
    for (let i = 0; i < 5; i++) host.appendChild(row("n" + i, 20 * i));
  });
  assert.equal(played.length, 1);
  assert.equal(played[0]?.node, byId(host, "a"));
});

test("withRowMotion: four added rows still fade in", (t) => {
  const played = setup(t);
  const host = rows({ a: 0 });
  withRowMotion(host, () => {
    for (let i = 0; i < 4; i++) host.appendChild(row("n" + i, 20 + 20 * i));
  });
  assert.equal(played.length, 4);
});

test("withRowMotion: treats an empty list before or after as a bulk change", (t) => {
  const played = setup(t);
  const empty = rows({});
  withRowMotion(empty, () => {
    empty.appendChild(row("a", 0));
  });
  assert.equal(played.length, 0);
  const full = rows({ a: 0 });
  withRowMotion(full, () => {
    byId(full, "a").remove();
  });
  assert.equal(played.length, 0);
});

test("withRowMotion: treats more than twelve removed rows as a bulk change and skips the fade", (t) => {
  const played = setup(t);
  const tops: Record<string, number> = { keep: 0 };
  for (let i = 0; i < 13; i++) tops["x" + i] = 20 + 20 * i;
  const host = rows(tops);
  withRowMotion(host, () => {
    for (let i = 0; i < 13; i++) byId(host, "x" + i).remove();
    host.appendChild(row("n", 20));
  });
  assert.equal(played.length, 0);
});

test("withRowMotion: tracks hidden-shot strips by their ids", (t) => {
  const played = setup(t);
  const host = document.createElement("div");
  const strip = document.createElement("div");
  strip.className = "hidden-shot-strip";
  strip.setAttribute("data-ids", "a,b");
  strip.setAttribute("data-top", "0");
  host.appendChild(strip);
  host.appendChild(row("r", 20));
  withRowMotion(host, () => {
    strip.setAttribute("data-top", "20");
    byId(host, "r").setAttribute("data-top", "0");
  });
  assert.equal(played.length, 2);
  assert.equal(played[0]?.node, strip);
});

test("withRowMotion: ignores children that are not rows or strips and a repeated key", (t) => {
  const played = setup(t);
  const host = rows({ a: 0 });
  const other = document.createElement("div");
  other.setAttribute("data-top", "5");
  host.appendChild(other);
  host.appendChild(row("a", 99));
  withRowMotion(host, () => {
    byId(host, "a").setAttribute("data-top", "10");
  });
  assert.equal(played.length, 1);
  assert.deepEqual(played[0]?.frames[0], { transform: "translateY(-10px)" });
});

test("withRowMotion: only paints when nothing changed", (t) => {
  const played = setup(t);
  const host = rows({ a: 0, b: 20 });
  let paints = 0;
  withRowMotion(host, () => { paints++; });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: paints once and animates nothing under reduced motion", (t) => {
  const played = setup(t, { reduced: true });
  const host = rows({ a: 0, b: 20 });
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "a").setAttribute("data-top", "40");
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: paints once and animates nothing while the page is hidden", (t) => {
  const played = setup(t, { visible: false });
  const host = rows({ a: 0, b: 20 });
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "a").setAttribute("data-top", "40");
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: paints once and animates nothing where elements cannot animate", (t) => {
  const played = setup(t, { animate: false });
  const host = rows({ a: 0, b: 20 });
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "a").setAttribute("data-top", "40");
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: paints once without a list element", (t) => {
  setup(t);
  let paints = 0;
  withRowMotion(null, () => { paints++; });
  assert.equal(paints, 1);
});

test("withRowMotion: paints once and measures nothing for a list over 200 children", (t) => {
  const played = setup(t);
  const tops: Record<string, number> = {};
  for (let i = 0; i < 201; i++) tops["r" + i] = i * 20;
  const host = rows(tops);
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "r0").setAttribute("data-top", "500");
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: skips the animation when the repaint grows the list past 200 children", (t) => {
  const played = setup(t);
  const tops: Record<string, number> = {};
  for (let i = 0; i < 200; i++) tops["r" + i] = i * 20;
  const host = rows(tops);
  withRowMotion(host, () => {
    byId(host, "r0").setAttribute("data-top", "500");
    host.appendChild(row("extra", 9999));
  });
  assert.equal(played.length, 0);
});

test("withRowMotion: still paints once when measuring before the repaint fails", (t) => {
  const played = setup(t);
  const host = rows({ a: 0 });
  const measure = proto.getBoundingClientRect;
  let paints = 0;
  proto.getBoundingClientRect = function () { throw new Error("no layout"); };
  withRowMotion(host, () => {
    paints++;
    proto.getBoundingClientRect = measure;
  });
  assert.equal(paints, 1);
  assert.equal(played.length, 0);
});

test("withRowMotion: a failing animation never breaks the repaint", (t) => {
  setup(t);
  proto.animate = function () { throw new Error("no animation"); };
  const host = rows({ a: 0, b: 20 });
  let paints = 0;
  withRowMotion(host, () => {
    paints++;
    byId(host, "a").setAttribute("data-top", "40");
  });
  assert.equal(paints, 1);
});
