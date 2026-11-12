export const SHARED_BUFFER_QUEUE_BYTES = 64 * 1024;

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
  return held + incoming > SHARED_BUFFER_QUEUE_BYTES;
}

export class SharedTextBuffer {
  readonly revision: number;
  readonly painted: string;
  private value: string;
  private origins: (number | null)[];
  private open = false;

  constructor(revision: number, painted: string) {
    this.revision = revision;
    this.painted = painted;
    this.value = painted;
    this.origins = Array.from({ length: painted.length }, (_, index) => index);
  }

  text(): string { return this.value; }
  dirty(): boolean { return this.open; }
  begin(): void { this.open = true; }

  replace(from: number, to: number, insert: string): void {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > this.value.length) {
      throw new RangeError("Native target outside buffered text");
    }
    this.open = true;
    this.value = this.value.slice(0, from) + insert + this.value.slice(to);
    this.origins.splice(from, to - from, ...Array<null>(insert.length).fill(null));
  }

  plan(): BufferedCommit {
    const splices: BufferedSplice[] = [];
    let old = 0, start = 0;
    for (let index = 0; index <= this.origins.length; index++) {
      const origin = index === this.origins.length ? this.painted.length : this.origins[index];
      if (origin === null || origin === undefined) continue;
      if (origin !== old || index !== start) splices.push({ from: old, to: origin, insert: this.value.slice(start, index) });
      old = origin + 1;
      start = index + 1;
    }
    return { base: this.revision, text: this.value, splices };
  }

  commit(): BufferedCommit {
    const plan = this.plan();
    this.open = false;
    return plan;
  }

  cancel(): void {
    this.value = this.painted;
    this.origins = Array.from({ length: this.painted.length }, (_, index) => index);
    this.open = false;
  }
}
