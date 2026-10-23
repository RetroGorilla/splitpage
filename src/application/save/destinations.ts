import type { SaveJob, WriterResult } from "./coordinator.ts";
import type { AutoSaveTarget } from "./status.ts";

export interface SaveDestination<R, P = unknown> {
  readonly id: string;
  readonly takes: (request: R, place: P) => boolean;
  readonly autoSaveTarget: (place: P) => AutoSaveTarget;
  readonly write: (job: SaveJob<R>) => Promise<WriterResult>;
}

export interface SaveDestinations<R, P = unknown> {
  readonly register: (destination: SaveDestination<R, P>) => () => void;
  readonly taking: (request: R, place: P) => SaveDestination<R, P> | null;
  readonly ids: () => readonly string[];
}

const DESTINATION_FUNCTIONS: readonly ("takes" | "autoSaveTarget" | "write")[] = Object.freeze(["takes", "autoSaveTarget", "write"]);

function refuse(message: string): never {
  throw new Error("Save destinations: " + message);
}

export function createSaveDestinations<R, P = unknown>(): SaveDestinations<R, P> {
  const registered: SaveDestination<R, P>[] = [];

  function register(destination: SaveDestination<R, P>): () => void {
    if (!destination || typeof destination !== "object") refuse("a destination must be an object");
    if (typeof destination.id !== "string" || !destination.id) refuse("a destination needs an id");
    for (const name of DESTINATION_FUNCTIONS) {
      if (typeof destination[name] !== "function") refuse("the " + destination.id + " destination has no " + name + " function");
    }
    if (registered.some(function (d) { return d.id === destination.id; })) refuse("a destination called " + destination.id + " is already registered");
    const held = Object.freeze({ ...destination });
    registered.unshift(held);
    return function () {
      const at = registered.indexOf(held);
      if (at !== -1) registered.splice(at, 1);
    };
  }

  function taking(request: R, place: P): SaveDestination<R, P> | null {
    for (const destination of registered) if (destination.takes(request, place)) return destination;
    return null;
  }

  return Object.freeze({
    register: register,
    taking: taking,
    ids: function () { return Object.freeze(registered.map(function (d) { return d.id; })); }
  });
}
