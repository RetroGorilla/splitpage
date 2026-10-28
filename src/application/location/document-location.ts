export type HomeKind = "none" | "file" | "import";

export interface Home {
  readonly kind: HomeKind;
  readonly [field: string]: unknown;
}

export type HomeFields = Readonly<Record<string, unknown>>;

export type LocationChange = "home" | "writtenOut";

export interface DocumentLocation {
  readonly home: () => Home;
  readonly setHome: (kind: string, fields?: HomeFields | null) => Home;
  readonly restoreHome: (record: Home) => Home;
  readonly amendHome: (record: Home, fields: HomeFields) => Home;
  readonly fileHome: () => Home | null;
  readonly importHome: () => Home | null;
  readonly writtenOut: () => boolean;
  readonly markWrittenOut: (writtenOut: boolean) => void;
  readonly onChange: (listener: (change: LocationChange) => void) => () => void;
}

type Shape = Readonly<Record<string, unknown>>;

const FIELDS: Readonly<Record<HomeKind, Shape>> = Object.freeze({
  none: {},
  file: { handle: null, format: null, name: null, lastModified: null, diskBase: null },
  import: { handle: null, format: null, name: null, lastModified: null, size: null, inPlace: false, dirty: false, diskBase: null }
});

const REQUIRED: Readonly<Record<HomeKind, readonly string[]>> = Object.freeze({
  none: [],
  file: ["format"],
  import: ["name"]
});

const AMENDABLE: Readonly<Record<HomeKind, readonly string[]>> = Object.freeze({
  none: [],
  file: ["diskBase", "lastModified"],
  import: ["dirty", "lastModified", "size", "inPlace", "diskBase"]
});

export const HOME_KINDS: readonly HomeKind[] = Object.freeze(["none", "file", "import"]);

function isKind(kind: string): kind is HomeKind {
  return Object.prototype.hasOwnProperty.call(FIELDS, kind);
}

function refuseWrite(_target: Record<string, unknown>, field: string | symbol): boolean {
  throw new TypeError("A home's " + String(field) + " changes through the document location owner (amendHome)");
}

export function createDocumentLocation(): DocumentLocation {
  const readOnly: ProxyHandler<Record<string, unknown>> = { set: refuseWrite, defineProperty: refuseWrite, deleteProperty: refuseWrite };
  const recordOf = new WeakMap<object, Record<string, unknown>>();
  const listeners = new Set<(change: LocationChange) => void>();

  function announce(change: LocationChange): void {
    listeners.forEach(function (listener) { listener(change); });
  }

  function viewOf(rec: Record<string, unknown>): Home {
    const view = new Proxy(rec, readOnly) as unknown as Home;
    recordOf.set(view, rec);
    return view;
  }

  let home: Home = viewOf({ kind: "none" });
  let writtenOut = false;

  function buildHome(kind: string, fields: HomeFields | null | undefined): Record<string, unknown> {
    if (!isKind(kind)) throw new Error("setHome: unknown kind " + JSON.stringify(kind));
    const shape = FIELDS[kind];
    const given = fields || {};
    if (given["kind"] !== undefined && given["kind"] !== kind) {
      throw new Error("setHome: kind " + JSON.stringify(given["kind"]) + " given for a " + kind +
                      " home — a file's format is `format`");
    }
    Object.keys(given).forEach(function (k) {
      if (k !== "kind" && !Object.prototype.hasOwnProperty.call(shape, k)) {
        throw new Error("setHome: a " + kind + " home has no field " + JSON.stringify(k));
      }
    });
    const rec: Record<string, unknown> = { kind: kind };
    Object.keys(shape).forEach(function (k) {
      rec[k] = given[k] === undefined ? shape[k] : given[k];
    });
    REQUIRED[kind].forEach(function (k) {
      if (rec[k] === null || rec[k] === undefined || rec[k] === "") {
        throw new Error("setHome: a " + kind + " home needs " + JSON.stringify(k));
      }
    });
    return rec;
  }

  function setHome(kind: string, fields?: HomeFields | null): Home {
    home = viewOf(buildHome(kind, fields));
    announce("home");
    return home;
  }

  function restoreHome(record: Home): Home {
    if (!record || !recordOf.has(record)) throw new Error("restoreHome: not a home record");
    home = record;
    announce("home");
    return home;
  }

  function amendHome(record: Home, fields: HomeFields): Home {
    const rec = record ? recordOf.get(record) : undefined;
    if (!rec) throw new Error("amendHome: not a home record");
    const kind = rec["kind"] as HomeKind;
    const allowed = AMENDABLE[kind];
    Object.keys(fields || {}).forEach(function (k) {
      if (allowed.indexOf(k) === -1) {
        throw new Error("amendHome: a " + kind + " home's " + JSON.stringify(k) + " is set when the home is made, not amended");
      }
    });
    Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
    if (record === home) announce("home");
    return record;
  }

  return Object.freeze({
    home: function () { return home; },
    setHome: setHome,
    restoreHome: restoreHome,
    amendHome: amendHome,
    fileHome: function () { return home.kind === "file" ? home : null; },
    importHome: function () { return home.kind === "import" ? home : null; },
    writtenOut: function () { return writtenOut; },
    markWrittenOut: function (on: boolean) {
      const next = !!on;
      if (next === writtenOut) return;
      writtenOut = next;
      announce("writtenOut");
    },
    onChange: function (listener: (change: LocationChange) => void) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
}
