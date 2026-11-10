import { localReplicaKey } from "./store.ts";
import type { LocalReplicaScope } from "./store.ts";

export class LocalWritableTab {
  private held = false;
  private release: (() => void) | null = null;
  private pending: Promise<void> | null = null;
  private ended = false;
  explanation = "This instance is open for editing in another tab. Retry after that tab closes.";

  owns(): boolean { return this.held; }

  async acquire(scope: LocalReplicaScope, hydrate: () => Promise<void>, wait = false): Promise<boolean> {
    if (this.held || this.pending) throw new Error("Ownership already requested");
    let decide: (value: boolean) => void = () => { throw new Error("Missing ownership decision"); };
    let fail: (error: unknown) => void = () => { throw new Error("Missing ownership rejection"); };
    const decision = new Promise<boolean>((resolve, reject) => { decide = resolve; fail = reject; });
    this.pending = navigator.locks.request(`splitpage:${localReplicaKey(scope)}`, { ifAvailable: !wait }, async lock => {
      if (!lock) { decide(false); return; }
      const lifetime = new Promise<void>(resolve => { this.release = resolve; });
      try {
        await hydrate();
        if (this.ended) throw new Error("Ownership ended during hydration");
        this.held = true;
        decide(true);
        await lifetime;
      } catch (error) { fail(error); }
      finally { this.held = false; this.release = null; }
    });
    void this.pending.then(() => { this.pending = null; }, fail);
    return decision;
  }

  async dispose(): Promise<void> {
    this.ended = true;
    this.held = false;
    this.release?.();
    await this.pending;
  }
}
