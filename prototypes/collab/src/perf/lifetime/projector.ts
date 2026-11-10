import type * as Y from "yjs";
import { mapValue } from "../../schema.ts";
import type { SchemaReplica } from "../../schema.ts";
import { records } from "../../proj/value.ts";
import type { ProjectionBag } from "../../proj/value.ts";
import type { PerfStructureView } from "../operations.ts";

interface LifetimeStatusEvent { target: string; value: string; prior: string; parents: string[] }

export class IndexedStructureProjection {
  private readonly events = new Map<string, Map<string, LifetimeStatusEvent>>();
  private readonly targets = new Map<string, string>();
  private readonly values = new Map<string, string>();
  private readonly status: Y.Map<LifetimeStatusEvent>;
  private readonly retired: Y.Map<unknown>;
  private readonly changes: (event: Y.YMapEvent<LifetimeStatusEvent>) => void;
  private readonly retirements: (event: Y.YMapEvent<unknown>) => void;
  statusRecordsRead = 0;
  readonly replica: SchemaReplica;

  constructor(replica: SchemaReplica) {
    this.replica = replica;
    this.status = replica.doc.getMap<LifetimeStatusEvent>("statusEvents");
    this.retired = replica.doc.getMap("retiredStatus");
    for (const [id, event] of this.status) this.put(id, event);
    this.changes = event => {
      for (const key of event.keysChanged) {
        const id = String(key);
        const old = this.targets.get(id);
        const value = this.status.get(id);
        if (old && old !== value?.target) { this.events.get(old)?.delete(id); this.values.delete(old); this.targets.delete(id); }
        if (value) this.put(id, value);
      }
    };
    this.retirements = event => { for (const key of event.keysChanged) { const target = this.targets.get(String(key)); if (target) this.values.delete(target); } };
    this.status.observe(this.changes);
    this.retired.observe(this.retirements);
  }

  private put(id: string, event: LifetimeStatusEvent): void {
    const entries = this.events.get(event.target) ?? new Map<string, LifetimeStatusEvent>();
    entries.set(id, event); this.events.set(event.target, entries); this.targets.set(id, event.target); this.values.delete(event.target);
  }

  private value(id: string, beat: Y.Map<unknown>): string {
    const cached = this.values.get(id);
    if (cached !== undefined) return cached;
    const events = [...(this.events.get(id) ?? [])];
    this.statusRecordsRead += events.length;
    const parents = new Set(events.flatMap(([, event]) => event.parents));
    const frontier = events.filter(([key]) => !parents.has(key));
    const choices = frontier.map(([key, event]) => this.retired.has(key) ? event.prior : event.value);
    const value = frontier.length ? new Set(choices).size === 1 ? choices[0] ?? "todo" : frontier[0]?.[1].prior ?? "todo" : String(beat.get("status"));
    if (frontier.length) this.values.set(id, value);
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
