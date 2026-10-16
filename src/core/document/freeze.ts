export type Frozen<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> }
      : T;

export type Seal = <T>(value: T) => Frozen<T>;

export function deepFreeze<T>(value: T): Frozen<T> {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const v = pending.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    Object.freeze(v);
    for (const k of Object.keys(v)) pending.push((v as Record<string, unknown>)[k]);
  }
  return value as Frozen<T>;
}

export function noFreeze<T>(value: T): Frozen<T> {
  return value as Frozen<T>;
}

const LOCKED = new WeakSet<object>();
const LOCKED_COPY = new WeakMap<object, object>();

function named(key: PropertyKey): string {
  return typeof key === "symbol" ? key.toString() : "'" + key + "'";
}

function unchanged(target: object, key: PropertyKey, next: PropertyDescriptor): boolean {
  const now = Reflect.getOwnPropertyDescriptor(target, key);
  return !!now && "value" in now && !now.configurable && !now.writable &&
    next.configurable !== true && next.writable !== true && next.get === undefined && next.set === undefined &&
    (next.enumerable === undefined || next.enumerable === now.enumerable) &&
    (!("value" in next) || Object.is(next.value, now.value));
}

const REFUSE_WRITES: ProxyHandler<object> = {
  set: function (_target, key) {
    throw new TypeError("Cannot assign to read only property " + named(key) + " of a cached value");
  },
  deleteProperty: function (_target, key) {
    throw new TypeError("Cannot delete property " + named(key) + " of a cached value");
  },
  defineProperty: function (target, key, next) {
    if (unchanged(target, key, next)) return Reflect.defineProperty(target, key, next);
    throw new TypeError("Cannot define property " + named(key) + ", a cached value is not extensible");
  },
  setPrototypeOf: function () {
    throw new TypeError("Cannot define property __proto__, a cached value is not extensible");
  }
};

function lockable(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function lock(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (LOCKED.has(value)) return value;
  const known = LOCKED_COPY.get(value);
  if (known) return known;
  if (!lockable(value)) return value;
  const list = Array.isArray(value);
  const shell: object = list ? [] : Object.create(Object.getPrototypeOf(value) as object | null) as object;
  const locked = new Proxy(shell, REFUSE_WRITES);
  LOCKED.add(locked);
  LOCKED_COPY.set(value, locked);
  for (const key of Reflect.ownKeys(value)) {
    if (list && key === "length") continue;
    const own = Reflect.getOwnPropertyDescriptor(value, key);
    Reflect.defineProperty(shell, key, {
      value: lock(Reflect.get(value, key)),
      enumerable: !!own && own.enumerable === true,
      writable: false,
      configurable: false
    });
  }
  if (list) Reflect.set(shell, "length", (value as unknown[]).length);
  Object.freeze(shell);
  return locked;
}

export function deepLock<T>(value: T): Frozen<T> {
  return lock(value) as Frozen<T>;
}
