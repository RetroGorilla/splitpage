import test from "node:test";
import assert from "node:assert/strict";
import { editorOpenActions, galleryActions } from "../../../src/features/gallery/actions.ts";
import { galleryActions as baseGalleryActions } from "./fixtures/annotate-5590ff04.mjs";
import { editorOpenActions as baseEditorOpenActions } from "./fixtures/picture-link-5590ff04.mjs";

type Factories = { galleryActions: typeof galleryActions; editorOpenActions: typeof editorOpenActions };
type Trace = unknown[][];
type InputCase = { label: string; make: (trace: Trace) => unknown; mounted?: boolean; callbackThrows?: boolean };

const base: Factories = {
  galleryActions: baseGalleryActions,
  editorOpenActions: baseEditorOpenActions
} as Factories;

function observe(factories: Factories, kind: "annotation" | "picture", sample: InputCase) {
  const trace: Trace = [];
  const callback = (...args: unknown[]): boolean => {
    trace.push(["callback", ...args]);
    if (sample.callbackThrows) throw new RangeError("callback refused");
    return true;
  };
  const [action] = kind === "annotation"
    ? factories.galleryActions(() => {
      trace.push(["current"]);
      return sample.mounted === false ? null : { openAnnotator: callback, refreshAnnotator: () => {} };
    })
    : factories.editorOpenActions(callback);
  assert.ok(action);
  const input = sample.make(trace);
  try {
    const result = action.run("button", input);
    return { trace, result, error: null };
  } catch (error) {
    return { trace, error: error instanceof Error ? [error.name, error.message] : error };
  }
}

function accessorCase(label: string, row: unknown[], slot: unknown[], proxy = false): InputCase {
  return {
    label,
    make(trace) {
      const reads = { rowId: 0, slot: 0 };
      const object = Object.defineProperties({}, {
        rowId: { get() { trace.push(["get", "rowId"]); return row[Math.min(reads.rowId++, row.length - 1)]; } },
        slot: { get() { trace.push(["get", "slot"]); return slot[Math.min(reads.slot++, slot.length - 1)]; } },
        key: { get() { trace.push(["get", "key"]); return "link-key"; } }
      });
      return proxy ? new Proxy(object, {
        get(target, property, receiver) {
          trace.push(["proxy", String(property)]);
          return Reflect.get(target, property, receiver) as unknown;
        }
      }) : object;
    }
  };
}

test("annotation snapshots rowId then slot once before validation", () => {
  const factories = { galleryActions, editorOpenActions };
  assert.deepEqual(observe(factories, "annotation", accessorCase("changing", ["r1", 17], [2, "invalid"])), {
    trace: [["get", "rowId"], ["get", "slot"], ["current"], ["callback", "r1", 2]], result: undefined, error: null
  });
  assert.deepEqual(observe(factories, "annotation", accessorCase("invalid row", [17], [2])), {
    trace: [["get", "rowId"], ["get", "slot"]], error: ["TypeError", "annotate-picture needs rowId as text"]
  });
});

test("picture-link retains validation reads followed by fresh callback reads", () => {
  assert.deepEqual(observe({ galleryActions, editorOpenActions }, "picture", accessorCase("changing proxy", ["r1", 17], [2, "invalid"], true)), {
    trace: [["proxy", "rowId"], ["get", "rowId"], ["proxy", "slot"], ["get", "slot"],
      ["proxy", "rowId"], ["get", "rowId"], ["proxy", "slot"], ["get", "slot"], ["proxy", "key"], ["get", "key"],
      ["callback", 17, "invalid", "link-key"]], result: undefined, error: null
  });
});

test("gallery actions match base reads, callback values, order and errors over seeded inputs", () => {
  const samples: InputCase[] = [
    ...[undefined, null, "row", 0, false, () => {}].map((value, index) => ({ label: `non-object ${index}`, make: () => value })),
    { label: "empty", make: () => ({}) },
    { label: "inherited fields", make: () => Object.create({ rowId: "inherited", slot: 1 }) as unknown },
    { label: "array fields", make: () => Object.assign([], { rowId: "array", slot: 0 }) },
    { label: "unmounted", mounted: false, make: () => ({ rowId: "r1", slot: 0 }) },
    { label: "callback throws", callbackThrows: true, make: () => ({ rowId: "r1", slot: 0, key: "key" }) },
    ...["rowId", "slot", "key"].map((field): InputCase => ({
      label: `throwing ${field}`,
      make(trace) {
        return new Proxy({ rowId: "r1", slot: 1 }, {
          get(target, property, receiver) {
            trace.push(["get", String(property)]);
            if (property === field) throw new SyntaxError(`cannot read ${field}`);
            return Reflect.get(target, property, receiver) as unknown;
          }
        });
      }
    }))
  ];
  let seed = 0xc2a11;
  const next = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const rows: unknown[] = ["r1", "r2", "", null, undefined, 5, false, {}, Symbol.for("row")];
  const slots: unknown[] = [0, 2, -1, NaN, Infinity, "0", null, undefined, {}, 1n];
  const keys: unknown[] = [undefined, "key", 42, null, { token: "key" }];
  for (let index = 0; index < 128; index++) {
    const row = rows[next() % rows.length];
    const slot = slots[next() % slots.length];
    const key = keys[next() % keys.length];
    samples.push({ label: `plain ${index}`, make: () => ({ rowId: row, slot, key }) });
    samples.push(accessorCase(`accessor ${index}`, [row, rows[next() % rows.length]], [slot, slots[next() % slots.length]], index % 2 === 0));
  }
  for (const kind of ["annotation", "picture"] as const) {
    for (const sample of samples) {
      assert.deepEqual(observe({ galleryActions, editorOpenActions }, kind, sample), observe(base, kind, sample), `${kind}: ${sample.label}`);
    }
  }
});
