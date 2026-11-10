import { identityEntries, identityGet, identityHas, wireIdentity } from "../../readers/identity.ts";
import type * as Y from "yjs";
import type { SchemaReplica } from "../../schema.ts";
import type { ProjectionBag } from "../../proj/value.ts";
import type { PerfStructureView } from "../operations.ts";
import { readStatusEvent, resolveBeatStatus } from "../../marks/status-resolution.ts";
import type { BeatStatusEvent } from "../../marks/status-resolution.ts";
import { perfReaderView } from "../../readers/perf.ts";
import { rootMap } from "../../readers/records.ts";

export class IndexedStructureProjection {
  private readonly events = new Map<string, Map<string, BeatStatusEvent>>();
  private readonly targets = new Map<string, string>();
  private readonly values = new Map<string, { stored: string; value: string }>();
  private readonly status: Y.Map<unknown> | null;
  private readonly retired: Y.Map<unknown> | Set<string>;
  private readonly changes: (event: Y.YMapEvent<unknown>) => void;
  private readonly retirements: (event: Y.YMapEvent<unknown>) => void;
  statusRecordsRead = 0;
  readonly replica: SchemaReplica;

  constructor(replica: SchemaReplica) {
    this.replica = replica;
    this.status = rootMap(replica.doc, "statusEvents");
    this.retired = rootMap(replica.doc, "retiredStatus") ?? new Set<string>();
    for (const [id, raw] of identityEntries(this.status)) { const event = readStatusEvent(raw); if (event) this.put(id, event); }
    this.changes = event => {
      for (const key of event.keysChanged) {
        const id = wireIdentity(String(key)), old = this.targets.get(id), value = readStatusEvent(identityGet(this.status, id));
        if (old !== undefined) { this.events.get(old)?.delete(id); this.values.delete(old); }
        if (value) { this.statusRecordsRead++; this.put(id, value); }
        else this.targets.delete(id);
      }
    };
    this.retirements = event => { for (const key of event.keysChanged) { const target = this.targets.get(wireIdentity(String(key))); if (target !== undefined) this.values.delete(target); } };
    this.status?.observe(this.changes);
    if (!(this.retired instanceof Set)) this.retired.observe(this.retirements);
  }

  private put(id: string, event: BeatStatusEvent): void {
    const entries = this.events.get(event.target) ?? new Map<string, BeatStatusEvent>();
    entries.set(id, event); this.events.set(event.target, entries); this.targets.set(id, event.target); this.values.delete(event.target);
  }

  private value(id: string, stored: string): string {
    const cached = this.values.get(id);
    if (cached?.stored === stored) return cached.value;
    const events = this.events.get(id) ?? new Map<string, BeatStatusEvent>();
    this.statusRecordsRead += events.size;
    const value = resolveBeatStatus(events, { has: id => this.retired instanceof Set ? this.retired.has(id) : identityHas(this.retired, id) }, stored);
    if (events.size) this.values.set(id, { stored, value });
    return value;
  }

  view(document: ProjectionBag): PerfStructureView {
    return perfReaderView(this.replica, document, (id, stored) => this.value(id, stored));
  }

  destroy(): void { this.status?.unobserve(this.changes); if (!(this.retired instanceof Set)) this.retired.unobserve(this.retirements); }
}
