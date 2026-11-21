function dataField(input: object, key: string): PropertyDescriptor {
  const field = Object.getOwnPropertyDescriptor(input, key);
  if (!field || !("value" in field)) throw new TypeError("Command fields must be data");
  return field;
}

export function copyNativeDenseList(input: unknown): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new TypeError("Expected a plain command list");
  const keys = new Set(Reflect.ownKeys(input)), length: unknown = dataField(input, "length").value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || keys.size !== length + 1 || !keys.has("length")) {
    throw new TypeError("Command lists must be dense");
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const key = String(index);
    if (!keys.has(key)) throw new TypeError("Command lists must be dense");
    const field = dataField(input, key);
    if (!field.enumerable) throw new TypeError("Command list entries must be enumerable");
    result.push(field.value);
  }
  return result;
}

export function copyNativeCompoundInput(value: unknown, retain?: (input: object) => boolean): unknown {
  const copies = new WeakMap<object, object>();
  function copy(input: unknown): unknown {
    if (input === undefined || typeof input === "function") throw new TypeError("Invalid command field");
    if (input === null || typeof input !== "object") return input;
    if (retain?.(input)) return input;
    const known = copies.get(input);
    if (known) return known;
    if (Array.isArray(input)) {
      const result = copyNativeDenseList(input);
      copies.set(input, result);
      for (const [index, item] of result.entries()) result[index] = copy(item);
      return result;
    }
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
