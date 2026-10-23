import { registryKey } from "../../core/document/tags.ts";
import type { Frozen, Seal } from "../../core/document/freeze.ts";
import type { DocumentShape, DocumentTag, ValidatedDocument } from "../../core/document/validated.ts";
import { tagCategory } from "../../core/production/looks.ts";
import type { TagCategoryLook } from "../../core/production/looks.ts";
import type { ProductionReaders } from "../../core/production/ports.ts";
import { registryEntryOf } from "../../core/production/records.ts";
import { deriveProductionIndex, planRegistryHealing, refreshedProductionIndex, registrySignature } from "../../core/production/tags.ts";
import type { CueSnapshot, ProductionEntry, ProductionIndex } from "../../core/production/tags.ts";
import type { PresentedProductionEntry, ProductionIndexOwner, TagRecordsPlan } from "../../core/production/index.ts";

interface HeldIndex {
  readonly core: ProductionIndex;
  readonly entries: readonly PresentedProductionEntry[];
  readonly state: ValidatedDocument;
}

export function createProductionIndex(readers: ProductionReaders, seal: Seal): ProductionIndexOwner {
  let prodIndex: HeldIndex | null = null;
  let prodIndexDerived = 0;
  let cueSnapshot: CueSnapshot | null = null;

  function presentEntry(e: Frozen<ProductionEntry>): PresentedProductionEntry {
    return {
      key: e.key,
      id: e.id,
      cat: tagCategory(e.catId) as TagCategoryLook,
      name: e.name,
      mentions: e.mentions,
      orphaned: e.orphaned,
      owner: e.owner,
      notes: e.notes,
      status: e.status
    };
  }

  function holdIndex(core: ProductionIndex, entries: readonly PresentedProductionEntry[], state: ValidatedDocument): HeldIndex {
    prodIndex = { core: seal(core), entries: seal(entries), state: state };
    return prodIndex;
  }

  function productionIndex(doc: ValidatedDocument | null | undefined): HeldIndex | { core: null; entries: PresentedProductionEntry[] } {
    if (!doc) return { core: null, entries: [] };
    const held = prodIndex;
    const kept = held && held.state === doc ? refreshedProductionIndex(held.core, doc, readers) : null;
    if (held && kept && kept === held.core) return held;
    if (held && kept) return holdIndex(kept, held.entries, held.state);
    prodIndexDerived++;
    const core = deriveProductionIndex(doc, readers);
    return holdIndex(core, core.entries.map(presentEntry), doc);
  }

  function adoptRegisteredIds(ix: HeldIndex, doc: DocumentShape): void {
    const ids: Record<string, string | undefined> = Object.create(null), left: Record<string, boolean> = Object.create(null);
    ix.core.unregistered.forEach(function (t) {
      const key = registryKey(t.catId, t.name);
      const reg = registryEntryOf(doc, t.catId, t.name);
      if (reg) ids[key] = reg.id;
      else left[key] = true;
    });
    function withId<T extends { readonly key: string; readonly id: string | null }>(e: T): T {
      return e.key in ids ? Object.assign({}, e, { id: ids[e.key] }) : e;
    }
    function registeredFirst<T extends { readonly key: string; readonly id: string | null }>(entries: readonly T[]): T[] {
      const stay: T[] = [], after: T[] = [];
      entries.forEach(function (e) { (e.key in left ? after : stay).push(withId(e)); });
      return stay.concat(after);
    }
    const core = Object.assign({}, ix.core, {
      entries: registeredFirst(ix.core.entries),
      unregistered: ix.core.unregistered.filter(function (t) { return registryKey(t.catId, t.name) in left; }),
      tagSig: registrySignature(doc.productionTags)
    });
    holdIndex(core, registeredFirst(ix.entries), ix.state);
  }

  return {
    entries: function (doc) { return productionIndex(doc).entries.slice(); },
    current: function (doc) { return productionIndex(doc).core; },
    derived: function () { return prodIndexDerived; },
    resetDerived: function () { prodIndexDerived = 0; },
    recordsPlan: function (doc, viewed): TagRecordsPlan | null {
      if (!doc) return null;
      const ix = productionIndex(viewed);
      const plan = planRegistryHealing(doc, readers, cueSnapshot, ix.core as ProductionIndex);
      return {
        apply: plan.count ? function (into: DocumentShape): number {
          if (!ix.core) throw new TypeError("The viewed document has no production index");
          plan.retitle.forEach(function (r) { (into.productionTags[r.at] as DocumentTag).name = r.name; });
          plan.register.forEach(function (t) { into.productionTags.push(t); });
          adoptRegisteredIds(ix, into);
          if (plan.retitle.length) prodIndex = null;
          return plan.count;
        } : null,
        commit: function () { cueSnapshot = plan.cues; }
      };
    }
  };
}
