import { compareLocalChanges, compareNotices } from "../native-notice/compare.ts";
import type { NoticeClash, NoticeLocalChange, NoticeReading } from "../native-notice/compare.ts";
import type { Ledger, Loss, LossKind } from "../../test/native-notice/model.ts";

export function retainedByCut(loss: Loss): boolean {
  return (loss.cause === "cut" || loss.cause === "cut-undo") &&
    (loss.kind === "visual" || loss.kind === "record" || loss.kind === "marks" && loss.column === "visual");
}

function changes(model: Ledger, person: number): NoticeLocalChange[] {
  return model.pending(person).flatMap<NoticeLocalChange>(({ effect, undone }) => {
    if (effect.action === "create" && effect.from) return [{ kind: "split", id: effect.id, parent: effect.from }];
    if (effect.action === "delete" && effect.above) {
      const above = effect.above;
      return effect.ids.slice(0, 1).map(id => ({ kind: "displaced", id, above }));
    }
    if (undone?.action === "delete") return undone.ids.map(id => ({ kind: "double-undo", id }));
    if (effect.action !== "edit") return [];
    const { kind, id } = effect;
    switch (kind) {
      case "narration":
      case "visual": return effect.token ? [{ kind, id, text: effect.token, ...(effect.erased ? { erased: true } : {}) }] : [];
      case "marks": return effect.column && effect.mark ? [{ kind, id, column: effect.column, mark: effect.mark }] : [];
      case "record": return [{ kind, id, field: effect.field ?? "status" }];
      case "join": return [{ kind, id }];
    }
  });
}

const key = ({ id, kind }: Pick<Loss, "id" | "kind">) => id + "/" + kind;
const kind = (entry: string) => entry.slice(entry.lastIndexOf("/") + 1) as LossKind;

function keys(clashes: readonly NoticeClash[], losses: readonly Loss[]): Set<string> {
  return new Set(clashes.map(clash => {
    const landing = clash.kind === "displaced" && clash.near &&
      losses.find(loss => loss.kind === "displaced" && loss.near === clash.near);
    return key(landing || clash);
  }));
}

export function scoreNotice(found: Set<string>, losses: readonly Loss[], counts: Set<string>, side: string): void {
  const truth = new Set(losses.map(key));
  if (found.size) {
    counts.add(side + "/banner");
    if (!truth.size) counts.add(side + "/false banner");
  }
  for (const entry of truth) counts.add(side + (found.has(entry) ? "/hit/" : "/miss/") + kind(entry));
  for (const entry of found) if (!truth.has(entry)) counts.add(side + "/false/" + kind(entry));
}

export function scoreOffline(base: NoticeReading, mine: NoticeReading, settled: NoticeReading, model: Ledger,
  person: number, losses: readonly Loss[], counts: Set<string>): void {
  scoreNotice(keys(compareNotices(base, mine, settled), losses), losses, counts, "base");
  scoreNotice(keys(compareLocalChanges(mine, settled, changes(model, person)), losses), losses, counts, "journal");
}
