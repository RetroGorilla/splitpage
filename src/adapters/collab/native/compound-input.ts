function dataField(input: object, key: string): PropertyDescriptor {
  const field = Object.getOwnPropertyDescriptor(input, key);
  if (!field || !("value" in field)) throw new TypeError("Command fields must be data");
  return field;
}

export function copyNativeCompoundInput(value: unknown): unknown {
  const copies = new WeakMap<object, object>();
  function copyArray(input: readonly unknown[]): unknown[] {
    const keys = new Set(Reflect.ownKeys(input)), length: unknown = dataField(input, "length").value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || keys.size !== length + 1 || !keys.has("length")) {
      throw new TypeError("Command lists must be dense");
    }
    const result: unknown[] = [];
    copies.set(input, result);
    for (let index = 0; index < length; index++) {
      const key = String(index);
      if (!keys.has(key)) throw new TypeError("Command lists must be dense");
      const field = dataField(input, key);
      Object.defineProperty(result, key, { ...field, value: copy(field.value) });
    }
    const currentLength: unknown = dataField(input, "length").value, currentKeys = Reflect.ownKeys(input);
    if (currentLength !== length || currentKeys.length !== keys.size || !currentKeys.every(key => keys.has(key))) {
      throw new TypeError("Command list changed while being read");
    }
    return result;
  }

  function copy(input: unknown): unknown {
    if (input === undefined || typeof input === "function") throw new TypeError("Invalid command field");
    if (input === null || typeof input !== "object") return input;
    const known = copies.get(input);
    if (known) return known;
    if (Array.isArray(input)) return copyArray(input);
    const result = Object.create(null) as object;
    copies.set(input, result);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") throw new TypeError("Invalid command field name");
      const field = dataField(input, key);
      Object.defineProperty(result, key, { ...field, value: copy(field.value) });
    }
    return result;
  }
  try { return copy(value); } catch { return undefined; }
}
