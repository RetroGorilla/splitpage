import { goldenNames, image, jsonCopy, readGolden } from "./golden-helpers.mjs";

const NOT_CASES = new Set(["merge-list-mergers", "merge-state-fields"]);

export function mergeGoldenInputs() {
  return goldenNames("merge-").filter((n) => !NOT_CASES.has(n)).map((name) => ({ name, inputs: readGolden(name).inputs }));
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIST_KEYS = ["rows", "comments", "people", "productionTags", "brollShots"];
const PROTO_IDS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"];
const ODD_LISTS = [() => ({}), () => "x", () => 7, () => null, () => true, () => ({ 0: { id: "r1" }, length: 1 })];
const ODD_ITEMS = [() => null, () => "x", () => 5, () => true, () => [], () => ["r1"]];
const ODD_VALUES = [
  () => null, () => "", () => " ", () => 0, () => -1, () => 3.7, () => 1e21, () => true, () => false,
  () => ({}), () => [], () => ["x"], () => [null], () => ({ id: "x" }), () => ({ sha256: "f".repeat(64) })
];

function collectStrings(value, into) {
  if (typeof value === "string") { into.add(value); return; }
  if (!value || typeof value !== "object") return;
  for (const v of Object.values(value)) collectStrings(v, into);
}

function nodesOf(value, into, path) {
  if (!value || typeof value !== "object") return into;
  into.push({ node: value, path });
  for (const [k, v] of Object.entries(value)) nodesOf(v, into, path + "." + k);
  return into;
}

export function mergeCorpus(seed, count) {
  const rnd = seededRandom(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const chance = (p) => rnd() < p;
  const goldens = mergeGoldenInputs();
  const strings = new Set();
  goldens.forEach((g) => collectStrings(g.inputs, strings));
  const pics = [image("png", 9, 4), image("gif", 3, 3), image("jpeg", 12, 7)];
  pics.forEach((p) => {
    strings.add('<img src="' + p.dataUrl + '">');
    strings.add('<img class="comment-img" data-blob="' + p.sha256 + '" data-w="3" data-h="3" data-mime="' + p.record.mime + '">');
  });
  const pool = [...strings].sort();
  const items = {};
  goldens.forEach((g) => [g.inputs.base, g.inputs.mine, g.inputs.theirs].forEach((d) => {
    if (!d) return;
    LIST_KEYS.forEach((k) => {
      if (!Array.isArray(d[k])) return;
      items[k] = (items[k] || []).concat(d[k]);
    });
  }));
  const keys = [...new Set(goldens.flatMap((g) => nodesOf(g.inputs, [], "").flatMap((n) => Object.keys(n.node))))]
    .filter((k) => !/^\d+$/.test(k)).sort();

  function anyValue() {
    if (chance(0.55)) return pick(pool);
    if (chance(0.3)) return jsonCopy(pick(items[pick(LIST_KEYS)] || [null]));
    return pick(ODD_VALUES)();
  }

  function listOf(doc) {
    const lists = [];
    nodesOf(doc, [], "").forEach((n) => {
      for (const [k, v] of Object.entries(n.node)) if (Array.isArray(v)) lists.push({ owner: n.node, key: k });
    });
    return lists;
  }

  const MUTATIONS = [
    ["set", 4, (doc) => {
      const n = pick(nodesOf(doc, [], ""));
      const k = Array.isArray(n.node) && n.node.length && chance(0.7) ? Math.floor(rnd() * n.node.length) : pick(keys);
      n.node[k] = anyValue();
    }],
    ["delete", 2, (doc) => {
      const n = pick(nodesOf(doc, [], ""));
      const ks = Object.keys(n.node);
      if (!ks.length) return;
      if (Array.isArray(n.node)) n.node.splice(Math.floor(rnd() * n.node.length), 1);
      else delete n.node[pick(ks)];
    }],
    ["list-shape", 1, (doc) => {
      const lists = listOf(doc);
      if (!lists.length) return;
      const l = pick(lists);
      l.owner[l.key] = pick(ODD_LISTS)();
    }],
    ["odd-item", 1, (doc) => {
      const lists = listOf(doc);
      if (!lists.length) return;
      const l = pick(lists);
      l.owner[l.key].splice(Math.floor(rnd() * (l.owner[l.key].length + 1)), 0, pick(ODD_ITEMS)());
    }],
    ["add-item", 3, (doc) => {
      const k = pick(LIST_KEYS);
      if (!Array.isArray(doc[k])) return;
      const it = jsonCopy(pick(items[k] || [{}]));
      if (it && typeof it === "object" && chance(0.5)) it.id = chance(0.3) ? pick(PROTO_IDS) : "z" + Math.floor(rnd() * 6);
      doc[k].splice(Math.floor(rnd() * (doc[k].length + 1)), 0, it);
    }],
    ["proto-id", 1, (doc) => {
      const k = pick(LIST_KEYS);
      const list = Array.isArray(doc[k]) ? doc[k].filter((x) => x && typeof x === "object") : [];
      if (list.length) pick(list).id = pick(PROTO_IDS);
    }],
    ["reply", 2, (doc) => {
      const cs = Array.isArray(doc.comments) ? doc.comments.filter((c) => c && typeof c === "object") : [];
      if (!cs.length) return;
      const c = pick(cs);
      if (!Array.isArray(c.replies)) c.replies = [];
      const r = { id: chance(0.5) ? "rp" + Math.floor(rnd() * 4) : pick(PROTO_IDS), body: pick(pool) };
      if (chance(0.6)) r.createdAt = "2026-03-0" + (1 + Math.floor(rnd() * 9)) + "T09:00:00.000Z";
      if (chance(0.5)) r.author = pick(pool);
      c.replies.push(r);
    }],
    ["unmigrate", 1, (doc) => {
      if (chance(0.5)) delete doc.schema; else doc.schema = 1;
    }]
  ];
  const weighted = MUTATIONS.flatMap((m) => Array(m[1]).fill(m));

  function mutate(doc, kinds) {
    const n = Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      const [name, , fn] = pick(weighted);
      fn(doc);
      kinds.add(name);
    }
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    const g = pick(goldens);
    const docs = jsonCopy(g.inputs);
    const kinds = new Set();
    if (!docs.base || chance(0.15)) docs.base = null;
    if (chance(0.1)) {
      const other = jsonCopy(pick(goldens).inputs);
      docs[pick(["mine", "theirs"])] = other.mine;
      kinds.add("cross");
    }
    for (const side of ["base", "mine", "theirs"]) if (docs[side]) mutate(docs[side], kinds);
    out.push({ label: "seed " + seed + " case " + i + " from " + g.name, kinds: [...kinds].sort(), inputs: jsonCopy(docs) });
  }
  return out;
}
