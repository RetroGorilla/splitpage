import type * as Y from "yjs";
import { mapValue } from "../../schema.ts";
import type { SchemaReplica } from "../../schema.ts";
import { records } from "../../proj/value.ts";
import type { ProjectionBag } from "../../proj/value.ts";
import type { PerfStructureView } from "../operations.ts";
import { isBeatStatusEvent, resolveBeatStatus } from "../../marks/status-resolution.ts";
import type { BeatStatusEvent } from "../../marks/status-resolution.ts";

export class IndexedStructureProjection {
  private readonly events = new Map<string, Map<string, BeatStatusEvent>>();
  private readonly targets = new Map<string, string>();
  private readonly values = new Map<string, { stored: string; value: string }>();
  private readonly status: Y.Map<BeatStatusEvent>;
  private readonly retired: Y.Map<unknown>;
  private readonly changes: (event: Y.YMapEvent<BeatStatusEvent>) => void;
  private readonly retirements: (event: Y.YMapEvent<unknown>) => void;
  statusRecordsRead = 0;
  readonly replica: SchemaReplica;

  constructor(replica: SchemaReplica) {
    this.replica = replica;
    this.status = replica.doc.getMap<BeatStatusEvent>("statusEvents");
    this.retired = replica.doc.getMap("retiredStatus");
    for (const [id, event] of this.status) if (isBeatStatusEvent(event)) this.put(id, event);
    this.changes = event => {
      for (const key of event.keysChanged) {
        const id = String(key);
        const old = this.targets.get(id);
        const value = this.status.get(id);
        if (old) { this.events.get(old)?.delete(id); this.values.delete(old); }
        if (isBeatStatusEvent(value)) { this.statusRecordsRead++; this.put(id, value); }
        else this.targets.delete(id);
      }
    };
    this.retirements = event => { for (const key of event.keysChanged) { const target = this.targets.get(String(key)); if (target) this.values.delete(target); } };
    this.status.observe(this.changes);
    this.retired.observe(this.retirements);
  }

  private put(id: string, event: BeatStatusEvent): void {
    const entries = this.events.get(event.target) ?? new Map<string, BeatStatusEvent>();
    entries.set(id, event); this.events.set(event.target, entries); this.targets.set(id, event.target); this.values.delete(event.target);
  }

  private value(id: string, beat: Y.Map<unknown>): string {
    const stored = String(beat.get("status"));
    const cached = this.values.get(id);
    if (cached?.stored === stored) return cached.value;
    const events = this.events.get(id) ?? new Map<string, BeatStatusEvent>();
    this.statusRecordsRead += events.size;
    const value = resolveBeatStatus(events, this.retired, stored);
    if (events.size) this.values.set(id, { stored, value });
    return value;
  }

  view(document: ProjectionBag): PerfStructureView {
    const result: PerfStructureView = { groups: [], recovery: [] }, destinations = new Map<string, PerfStructureView["groups"][number]>();
    for (const row of records(document.rows)) {
      const id = String(row.id), beat = mapValue(this.replica.doc.getMap("beats").get(id));
      if (mapValue(beat.get("removals")).size) { result.recovery.push(id); continue; }
      const joins = mapValue(beat.get("joins"));
      const key = [...joins.keys()].filter(key => !this.replica.doc.getMap("retiredJoins").has(key)).sort()[0];
      const join = key ? joins.get(key) as { into: string; glue: string } : undefined;
      const target = join ? destinations.get(join.into) : undefined;
      const status = this.value(id, beat);
      if (target && join) {
        target.members.push(id); target.narration += join.glue + String(row.audioText ?? "");
        target.visual = [target.visual, String(row.visualText ?? "")].filter(Boolean).join("<br>");
        if (["todo", "ready", "shot"].indexOf(status) > ["todo", "ready", "shot"].indexOf(target.status)) target.status = status;
        destinations.set(id, target);
      } else {
        const group = { id, members: [id], narration: String(row.audioText ?? ""), visual: String(row.visualText ?? ""), status };
        result.groups.push(group); destinations.set(id, group);
      }
    }
    return result;
  }

  destroy(): void { this.status.unobserve(this.changes); this.retired.unobserve(this.retirements); }
}
