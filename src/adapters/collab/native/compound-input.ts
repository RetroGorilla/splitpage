export function copyNativeCompoundInput(value: unknown): unknown {
  const copies = new WeakMap<object, object>();
  function copy(input: unknown): unknown {
    if (input === undefined || typeof input === "function") throw new TypeError("Invalid command field");
    if (input === null || typeof input !== "object") return input;
    const known = copies.get(input);
    if (known) return known;
    const result: object = Array.isArray(input) ? [] : Object.create(null) as object;
    copies.set(input, result);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") throw new TypeError("Invalid command field name");
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !("value" in field)) throw new TypeError("Command fields must be data");
      Object.defineProperty(result, key, { ...field, value: copy(field.value) });
    }
    return result;
  }
  try { return copy(value); } catch { return undefined; }
}
