export interface DocumentSource<O, A = unknown> {
  readonly id: string;
  readonly takes: (opening: O) => boolean;
  readonly open: (opening: O) => A | Promise<A>;
}

export interface DocumentSources<O, A = unknown> {
  readonly register: (source: DocumentSource<O, A>) => () => void;
  readonly taking: (opening: O) => DocumentSource<O, A> | null;
  readonly ids: () => readonly string[];
}

const SOURCE_FUNCTIONS: readonly ("takes" | "open")[] = Object.freeze(["takes", "open"]);

function refuse(message: string): never {
  throw new Error("Document sources: " + message);
}

export function createDocumentSources<O, A = unknown>(): DocumentSources<O, A> {
  const registered: DocumentSource<O, A>[] = [];

  function register(source: DocumentSource<O, A>): () => void {
    if (!source || typeof source !== "object") refuse("a source must be an object");
    if (typeof source.id !== "string" || !source.id) refuse("a source needs an id");
    for (const name of SOURCE_FUNCTIONS) {
      if (typeof source[name] !== "function") refuse("the " + source.id + " source has no " + name + " function");
    }
    if (registered.some(function (s) { return s.id === source.id; })) refuse("a source called " + source.id + " is already registered");
    const held = Object.freeze({ ...source });
    registered.unshift(held);
    return function () {
      const at = registered.indexOf(held);
      if (at !== -1) registered.splice(at, 1);
    };
  }

  function taking(opening: O): DocumentSource<O, A> | null {
    for (const source of registered) if (source.takes(opening)) return source;
    return null;
  }

  return Object.freeze({
    register: register,
    taking: taking,
    ids: function () { return Object.freeze(registered.map(function (s) { return s.id; })); }
  });
}
