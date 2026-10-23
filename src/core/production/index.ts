import { registryKey } from "../document/tags.ts";
import type { Frozen, Seal } from "../document/freeze.ts";
import type { DocumentShape, DocumentTag, ValidatedDocument } from "../document/validated.ts";
import { groupTagsByCategory, tagCategory } from "./looks.ts";
import type { TagCategoryLook } from "./looks.ts";
import type { ProductionReaders } from "./ports.ts";
import { registryEntryOf } from "./records.ts";
import { deriveProductionIndex, planRegistryHealing, refreshedProductionIndex, registrySignature } from "./tags.ts";
import type { CueSnapshot, ProductionEntry, ProductionIndex } from "./tags.ts";

export type PresentedProductionEntry = Omit<Frozen<ProductionEntry>, "catId"> & { readonly cat: TagCategoryLook };

export interface TagRecordsPlan {
  readonly apply: ((into: DocumentShape) => number) | null;
  readonly commit: () => void;
}

export interface ProductionIndexOwner {
  readonly entries: (doc: ValidatedDocument | null | undefined) => PresentedProductionEntry[];
  readonly current: (doc: ValidatedDocument | null | undefined) => ProductionIndex | null;
  readonly derived: () => number;
  readonly resetDerived: () => void;
  readonly recordsPlan: (doc: ValidatedDocument | null | undefined, viewed: ValidatedDocument | null | undefined) => TagRecordsPlan | null;
}

interface HeldIndex {
  readonly core: ProductionIndex;
  readonly entries: readonly PresentedProductionEntry[];
  readonly state: ValidatedDocument;
}

const indexes = new WeakMap<ProductionReaders, WeakMap<Seal, ProductionIndexOwner>>();

export function productionIndexFor(readers: ProductionReaders, seal: Seal): ProductionIndexOwner {
  let seals = indexes.get(readers);
  if (!seals) {
    seals = new WeakMap<Seal, ProductionIndexOwner>();
    indexes.set(readers, seals);
  }
  let index = seals.get(seal);
  if (!index) {
    index = createProductionIndex(readers, seal);
    seals.set(seal, index);
  }
  return index;
}

export function productionEntries(doc: ValidatedDocument | null | undefined, readers: ProductionReaders, seal: Seal): PresentedProductionEntry[] {
  return productionIndexFor(readers, seal).entries(doc);
}

export function currentProductionIndex(doc: ValidatedDocument | null | undefined, readers: ProductionReaders, seal: Seal): ProductionIndex | null {
  return productionIndexFor(readers, seal).current(doc);
}

export function tagsByCategory(doc: ValidatedDocument | null | undefined, readers: ProductionReaders, seal: Seal, all?: readonly PresentedProductionEntry[] | null): { cat: TagCategoryLook; items: PresentedProductionEntry[] }[] {
  return groupTagsByCategory(all || productionEntries(doc, readers, seal));
}

export function tagRecordsPlan(doc: ValidatedDocument | null | undefined, viewed: ValidatedDocument | null | undefined, readers: ProductionReaders, seal: Seal): TagRecordsPlan | null {
  return productionIndexFor(readers, seal).recordsPlan(doc, viewed);
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
          plan.retitle.forEach(function (r) { (into.productionTags[r.at] as DocumentTag).name = r.name; });
          plan.register.forEach(function (t) { into.productionTags.push(t); });
          if (!ix.core) throw new TypeError("The viewed document has no production index");
          adoptRegisteredIds(ix, into);
          if (plan.retitle.length) prodIndex = null;
          return plan.count;
        } : null,
        commit: function () { cueSnapshot = plan.cues; }
      };
    }
  };
}
