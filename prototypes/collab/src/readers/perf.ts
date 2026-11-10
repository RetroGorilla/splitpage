import type { SchemaReplica } from "../schema.ts";
import type { PerfStructureView } from "../perf/operations.ts";
import type { ProjectionBag } from "../proj/value.ts";
import { firstLiveJoin, readBeatRecord, readWireRecord, rootMap } from "./records.ts";
import { readerJoinGroups } from "./joins.ts";
import { readRemovalRecord, removalIds } from "./removals.ts";
import type { ReaderJoinRecord } from "./records.ts";

export function perfReaderView(replica: SchemaReplica, document: ProjectionBag, status: (id: string, stored: string) => string): PerfStructureView {
  const rows = new Map<string, { narration: string; visual: string; status: string }>(), joins = new Map<string, ReaderJoinRecord>(), removed = new Set<string>();
  const retired = rootMap(replica.doc, "retiredJoins") ?? new Set<string>();
  for (const raw of Array.isArray(document.rows) ? document.rows as unknown[] : []) {
    const row = readWireRecord(raw); if (!row || typeof row.id !== "string" || rows.has(row.id)) continue;
    const id = row.id, beat = readBeatRecord(rootMap(replica.doc, "beats")?.get(id));
    if (removalIds(beat.removals).some(key => readRemovalRecord(rootMap(replica.doc, "removalRecords")?.get(key)))) removed.add(id);
    const join = firstLiveJoin(beat, retired); if (join) joins.set(id, join);
    rows.set(id, { narration: typeof row.audioText === "string" ? row.audioText : "", visual: typeof row.visualText === "string" ? row.visualText : "", status: status(id, beat.status ?? "undefined") });
  }
  const result: PerfStructureView = { groups: [], recovery: [] }, order = new Map([...rows.keys()].map((id, index) => [id, index]));
  for (const group of readerJoinGroups([...rows.keys()], joins, removed)) {
    const root = rows.get(group.root); if (!root) continue;
    if (removed.has(group.root)) { result.recovery.push(group.root); continue; }
    const output = { id: group.root, members: group.members, narration: root.narration, visual: "", status: root.status };
    for (const id of group.members.slice(1)) {
      const row = rows.get(id); if (!row) continue;
      output.narration += (joins.get(id)?.glue ?? "") + row.narration;
      const ranks = ["todo", "ready", "shot"];
      if (ranks.indexOf(row.status) > ranks.indexOf(output.status)) output.status = row.status;
    }
    output.visual = [...group.members].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map(id => rows.get(id)?.visual).filter(Boolean).join("<br>");
    result.groups.push(output);
  }
  return result;
}
