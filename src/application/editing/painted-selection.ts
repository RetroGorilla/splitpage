import type { PaintedText } from "./ports.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";

export function followPaintedCaret(before: PaintedText | null,
  after: readonly { readonly key: string; readonly base: PaintedText | null; readonly length: number }[], offset: number, fallback: string,
  unit: (reference: SharedContentRef) => string = reference => reference,
  additional?: () => typeof after): { readonly key: string; readonly offset: number } | null {
  const same = after.find(field => field.key === fallback);
  if (!before || same && !same.base) return same ? { key: same.key, offset: Math.min(offset, same.length) } : null;
  if (offset === 0) return same ? { key: same.key, offset: 0 } : null;
  const locations = new Map<string, { readonly key: string; readonly offset: number }>();
  function index(fields: typeof after): void {
    for (const field of fields) if (field.base) for (let next = 0; next < field.base.text.length; next++) {
      const reference = field.base.identity(next), identity = reference ? unit(reference) : null;
      if (identity && !locations.has(identity)) locations.set(identity, { key: field.key, offset: next + 1 });
    }
  }
  index(after);
  let expanded = false;
  for (let at = offset - 1; at >= 0; at--) {
    const reference = before.identity(at), identity = reference ? unit(reference) : null;
    if (identity && !locations.has(identity) && additional && !expanded) { index(additional()); expanded = true; }
    const location = identity ? locations.get(identity) : null;
    if (location) return location;
  }
  return same ? { key: same.key, offset: 0 } : null;
}
