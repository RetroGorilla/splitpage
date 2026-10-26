export interface MergeOffer {
  readonly offer: (currentFile: unknown, home: unknown) => Promise<void>;
  readonly reset: () => void;
}

let held: MergeOffer | null = null;

export function handMergeOfferTo(next: MergeOffer | null): void {
  held = next;
}

export function offerFileMerge(currentFile: unknown, home: unknown): Promise<void> {
  return held ? held.offer(currentFile, home) : Promise.resolve();
}

export function resetMergeOffer(): void {
  if (held) held.reset();
}
