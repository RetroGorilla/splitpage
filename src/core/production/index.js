import { registryKey } from "../document/tags.ts";
import { groupTagsByCategory, tagCategory } from "./looks.ts";
import { registryEntryOf } from "./records.ts";
import { deriveProductionIndex, planRegistryHealing, refreshedProductionIndex, registrySignature } from "./tags.ts";

const indexes = new WeakMap();

export function productionIndexFor(readers, seal) {
  let seals = indexes.get(readers);
  if (!seals) {
    seals = new WeakMap();
    indexes.set(readers, seals);
  }
  let index = seals.get(seal);
  if (!index) {
    index = createProductionIndex(readers, seal);
    seals.set(seal, index);
  }
  return index;
}

export function productionEntries(doc, readers, seal) {
  return productionIndexFor(readers, seal).entries(doc);
}

export function currentProductionIndex(doc, readers, seal) {
  return productionIndexFor(readers, seal).current(doc);
}

export function tagsByCategory(doc, readers, seal, all) {
  return groupTagsByCategory(all || productionEntries(doc, readers, seal));
}

export function tagRecordsPlan(doc, viewed, readers, seal) {
  return productionIndexFor(readers, seal).recordsPlan(doc, viewed);
}

export function createProductionIndex(readers, seal) {
  let prodIndex = null;
  let prodIndexDerived = 0;
  let cueSnapshot = null;

  function presentEntry(e) {
    return {
      key: e.key,
      id: e.id,
      cat: tagCategory(e.catId),
      name: e.name,
      mentions: e.mentions,
      orphaned: e.orphaned,
      owner: e.owner,
      notes: e.notes,
      status: e.status
    };
  }

  function holdIndex(core, entries, state) {
    prodIndex = { core: seal(core), entries: seal(entries), state: state };
    return prodIndex;
  }

  function productionIndex(doc) {
    if (!doc) return { core: null, entries: [] };
    const kept = prodIndex && prodIndex.state === doc ? refreshedProductionIndex(prodIndex.core, doc, readers) : null;
    if (kept && kept === prodIndex.core) return prodIndex;
    if (kept) return holdIndex(kept, prodIndex.entries, prodIndex.state);
    prodIndexDerived++;
    const core = deriveProductionIndex(doc, readers);
    return holdIndex(core, core.entries.map(presentEntry), doc);
  }

  function adoptRegisteredIds(ix, doc) {
    const ids = Object.create(null), left = Object.create(null);
    ix.core.unregistered.forEach(function (t) {
      const key = registryKey(t.catId, t.name);
      const reg = registryEntryOf(doc, t.catId, t.name);
      if (reg) ids[key] = reg.id;
      else left[key] = true;
    });
    function withId(e) {
      return e.key in ids ? Object.assign({}, e, { id: ids[e.key] }) : e;
    }
    function registeredFirst(entries) {
      const stay = [], after = [];
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
    recordsPlan: function (doc, viewed) {
      if (!doc) return null;
      const ix = productionIndex(viewed);
      const plan = planRegistryHealing(doc, readers, cueSnapshot, ix.core);
      return {
        apply: plan.count ? function (into) {
          plan.retitle.forEach(function (r) { into.productionTags[r.at].name = r.name; });
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
