export function sharedBufferQueueBytes(): number {
  const SHARED_BUFFER_QUEUE_BYTES = 64 * 1024;
  return SHARED_BUFFER_QUEUE_BYTES;
}

export interface BufferedSplice {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface BufferedCommit {
  readonly base: number;
  readonly text: string;
  readonly splices: readonly BufferedSplice[];
}

export function exceedsBufferQueue(held: number, incoming: number): boolean {
  return held + incoming > sharedBufferQueueBytes();
}

export interface SharedTextBuffer {
  readonly revision: number;
  readonly painted: string;
  readonly text: () => string;
  readonly dirty: () => boolean;
  readonly begin: () => void;
  readonly replace: (from: number, to: number, insert: string) => void;
  readonly plan: () => BufferedCommit;
  readonly commit: () => BufferedCommit;
  readonly cancel: () => void;
}

export function createSharedTextBuffer(revision: number, painted: string): SharedTextBuffer {
  let value = painted, origins: (number | null)[] = Array.from({ length: painted.length }, (_, index) => index), open = false;
  function plan(): BufferedCommit {
    const splices: BufferedSplice[] = [];
    let old = 0, start = 0;
    for (let index = 0; index <= origins.length; index++) {
      const origin = index === origins.length ? painted.length : origins[index];
      if (origin === null || origin === undefined) continue;
      if (origin !== old || index !== start) splices.push({ from: old, to: origin, insert: value.slice(start, index) });
      old = origin + 1;
      start = index + 1;
    }
    return { base: revision, text: value, splices };
  }
  return {
    revision, painted, text: () => value, dirty: () => open, begin: () => { open = true; },
    replace: (from, to, insert) => {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) {
        throw new RangeError("Native target outside buffered text");
      }
      const nextValue = value.slice(0, from) + insert + value.slice(to);
      const nextOrigins = origins.slice(0, from).concat(Array<null>(insert.length).fill(null), origins.slice(to));
      value = nextValue; origins = nextOrigins; open = true;
    },
    plan,
    commit: () => { const result = plan(); open = false; return result; },
    cancel: () => {
      const restored = Array.from({ length: painted.length }, (_, index) => index);
      value = painted; origins = restored; open = false;
    }
  };
}
