export const DOCUMENT_GUARD_PARAM = "document-guard";

export class DocumentWriteError extends TypeError {
  constructor(key: PropertyKey) {
    super("The document is read-only outside a session command: a write to " + String(key) + " was refused");
    this.name = "DocumentWriteError";
  }
}

export function createDocumentGuard(enabled: boolean, report: (error: unknown) => void) {
let quiet = 0;

function refuse(key: PropertyKey): never {
  const error = new DocumentWriteError(key);
  if (!quiet) report(error);
  throw error;
}

function quietly<T>(run: () => T): T {
  quiet++;
  try {
    return run();
  } finally {
    quiet--;
  }
}

const views = new WeakMap<object, object>();
const raws = new WeakMap<object, object>();

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function fixed(target: object, key: PropertyKey): boolean {
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  return !!own && own.configurable === false && own.writable === false;
}

const READ_ONLY: ProxyHandler<object> = {
  get: function (target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (!isObject(value) || fixed(target, key)) return value;
    return viewOf(value);
  },
  set: function (_target, key) { return refuse(key); },
  deleteProperty: function (_target, key) { return refuse(key); },
  defineProperty: function (_target, key) { return refuse(key); },
  setPrototypeOf: function () { return refuse("its prototype"); },
  preventExtensions: function () { return refuse("its extensibility"); }
};

function viewOf<T>(value: T): T {
  if (!isObject(value) || raws.has(value) || typeof value === "function") return value;
  let view = views.get(value);
  if (!view) {
    view = new Proxy(value, READ_ONLY);
    views.set(value, view);
    raws.set(view, value);
  }
  return view as T;
}

function isDocumentView(value: unknown): boolean {
  return isObject(value) && raws.has(value);
}

function rawOf<T>(value: T): T {
  if (!isObject(value)) return value;
  const raw = raws.get(value);
  return (raw ?? value) as T;
}

function sweep(container: object, seen: WeakSet<object>): void {
  if (seen.has(container)) return;
  seen.add(container);
  const bag = container as Record<string, unknown>;
  Object.keys(bag).forEach(function (key) {
    const value = bag[key];
    if (!isObject(value)) return;
    const raw = rawOf(value);
    if (raw !== value) bag[key] = raw;
    sweep(raw, seen);
  });
}

function unwrapAll<T>(value: T): T {
  const raw = rawOf(value);
  if (isObject(raw)) sweep(raw, new WeakSet());
  return raw;
}

function same<T>(value: T): T {
  return value;
}


  const documentGuardOn = enabled;
  return { documentGuardOn, documentView: documentGuardOn ? viewOf : same, unwrapped: documentGuardOn ? unwrapAll : same, quietly, rawOf, isDocumentView };
}

let started: ReturnType<typeof createDocumentGuard> | null = null;
export let documentGuardOn = false;

export function startDocumentGuard(enabled: boolean, report: (error: unknown) => void): () => void {
  const mine = createDocumentGuard(enabled, report);
  started = mine;
  documentGuardOn = mine.documentGuardOn;
  return () => { if (started === mine) { started = null; documentGuardOn = false; } };
}

export function documentView<T>(doc: T): T { return started ? started.documentView(doc) : doc; }
export function unwrapped<T>(value: T): T { return started ? started.unwrapped(value) : value; }
export function quietly<T>(run: () => T): T { return started ? started.quietly(run) : run(); }
export function rawOf<T>(value: T): T { return started ? started.rawOf(value) : value; }
export function isDocumentView(value: unknown): boolean { return started ? started.isDocumentView(value) : false; }
