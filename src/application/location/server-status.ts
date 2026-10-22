import type { KeyValueStorage } from "../recovery/conflict-stash.ts";

export const SERVER_RESUME_KEY = "splitpage-server-resume";
export const SERVER_BOOKMARKS_KEY = "splitpage-server-bookmarks";

export interface ServerMode {
  readonly available: boolean;
  readonly readOnly: boolean;
  readonly checked: boolean;
  readonly authRequired: boolean;
  readonly reviewAvailable: boolean;
  readonly version: string | null;
  readonly links: boolean;
  readonly linksPersist: boolean;
}

export interface Bookmark {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly url: string;
  readonly [field: string]: unknown;
}

export type ServerStatusChange = "mode" | "link" | "session" | "bookmarks";

export interface ServerStatusPorts {
  readonly storage: () => KeyValueStorage | null | undefined;
}

export interface ServerStatus {
  readonly mode: () => ServerMode;
  readonly applyHealth: (health: unknown) => void;
  readonly recordMode: (fields: Partial<ServerMode>) => void;
  readonly forgetMode: () => void;
  readonly linkTurnedOff: () => boolean;
  readonly turnLinkOff: () => boolean;
  readonly sessionExpired: () => boolean;
  readonly expireSession: () => boolean;
  readonly bookmarks: () => readonly Bookmark[];
  readonly bookmarkById: (id: unknown) => Bookmark | null;
  readonly loadBookmarks: () => void;
  readonly saveBookmarks: () => boolean;
  readonly addBookmarks: (added: readonly Bookmark[]) => void;
  readonly removeBookmark: (id: unknown) => void;
  readonly onChange: (listener: (change: ServerStatusChange) => void) => () => void;
}

const UNCHECKED: ServerMode = Object.freeze({
  available: false,
  readOnly: false,
  checked: false,
  authRequired: false,
  reviewAvailable: false,
  version: null,
  links: false,
  linksPersist: false
});

const MODE_FIELDS: readonly (keyof ServerMode)[] = Object.freeze(["available", "readOnly", "checked", "authRequired", "reviewAvailable", "version", "links", "linksPersist"]);

function field(health: unknown, name: string): unknown {
  return health && typeof health === "object" ? (health as Record<string, unknown>)[name] : undefined;
}

function isBookmark(b: unknown): b is Bookmark {
  return !!b && typeof b === "object" && typeof (b as { url?: unknown }).url === "string";
}

function storedBookmarks(store: KeyValueStorage | null): Bookmark[] {
  try {
    const raw = store ? store.getItem(SERVER_BOOKMARKS_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter(isBookmark) : [];
  } catch {
    return [];
  }
}

export function createServerStatus(ports: ServerStatusPorts): ServerStatus {
  const listeners = new Set<(change: ServerStatusChange) => void>();
  let mode: ServerMode = UNCHECKED;
  let linkOff = false;
  let expired = false;
  let marks: readonly Bookmark[] = Object.freeze([]);

  function announce(change: ServerStatusChange): void {
    listeners.forEach(function (listener) { listener(change); });
  }

  function setMode(next: ServerMode): void {
    mode = Object.freeze(next);
    announce("mode");
  }

  function setMarks(next: readonly Bookmark[]): void {
    marks = Object.freeze(next.slice());
    announce("bookmarks");
  }

  function recordMode(fields: Partial<ServerMode>): void {
    const next: Record<string, unknown> = { ...mode };
    Object.keys(fields).forEach(function (k) {
      if (MODE_FIELDS.indexOf(k as keyof ServerMode) === -1) throw new Error("recordMode: a server mode has no field " + JSON.stringify(k));
      const value = (fields as Record<string, unknown>)[k];
      if (k === "version" ? value !== null && typeof value !== "string" : typeof value !== "boolean") {
        throw new Error("recordMode: " + k + " is " + (k === "version" ? "a string or null" : "true or false"));
      }
      next[k] = value;
    });
    setMode(next as unknown as ServerMode);
  }

  function storage(): KeyValueStorage | null {
    try { return ports.storage() || null; } catch { return null; }
  }

  return Object.freeze({
    mode: function () { return mode; },
    applyHealth: function (health: unknown) {
      const version = field(health, "version");
      setMode({
        available: !!(health && field(health, "ok")),
        readOnly: !!(health && field(health, "readOnly")),
        authRequired: !!(health && field(health, "authRequired")),
        reviewAvailable: !!(health && field(health, "reviewAvailable")),
        version: typeof version === "string" && version ? version : null,
        links: !!(health && Number(field(health, "links")) >= 1),
        linksPersist: !!(health && field(health, "linksPersist") === true),
        checked: true
      });
    },
    recordMode: recordMode,
    forgetMode: function () { setMode(UNCHECKED); },
    linkTurnedOff: function () { return linkOff; },
    turnLinkOff: function () {
      if (linkOff) return false;
      linkOff = true;
      announce("link");
      return true;
    },
    sessionExpired: function () { return expired; },
    expireSession: function () {
      if (expired) return false;
      expired = true;
      announce("session");
      return true;
    },
    bookmarks: function () { return marks; },
    bookmarkById: function (id: unknown) {
      for (const b of marks) {
        if (b.id === id) return b;
      }
      return null;
    },
    loadBookmarks: function () {
      setMarks(storedBookmarks(storage()));
    },
    saveBookmarks: function () {
      const store = storage();
      if (!store) return false;
      try {
        store.setItem(SERVER_BOOKMARKS_KEY, JSON.stringify(marks));
        return true;
      } catch {
        return false;
      }
    },
    addBookmarks: function (added: readonly Bookmark[]) {
      if (!added.every(isBookmark)) throw new Error("addBookmarks: a bookmark is an object with a url");
      setMarks(marks.concat(added));
    },
    removeBookmark: function (id: unknown) {
      setMarks(marks.filter(function (b) { return b.id !== id; }));
    },
    onChange: function (listener: (change: ServerStatusChange) => void) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
}
