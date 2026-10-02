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

const WORDS = ["the", "cat", "sat", "on", "mat", "dog", "rug", "sun", "pier", "gulls", "steam", "hands"];
const NAMES = ["Sam", "Ada", "Bo", "Tess"];
const TAGS = [["prop", "Kettle"], ["prop", "Lamp"], ["gear", "Tripod"], ["location", "Pier"]];
const STATUSES = ["todo", "ready", "shot"];
const DOC_ID = "d" + "1".repeat(32);

export function mergeCase(rand, ids) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;
  const upTo = (n) => Math.floor(rand() * (n + 1));
  const fresh = (taken) => {
    const free = ids.filter((id) => !taken.includes(id));
    return free.length ? pick(free) : null;
  };
  const sentence = () => Array.from({ length: 1 + upTo(4) }, () => pick(WORDS)).join(" ");
  let clock = 0;
  const when = () => { clock++; return "2026-01-01T" + String(clock % 24).padStart(2, "0") + ":" + String(clock % 60).padStart(2, "0") + ":00.000Z"; };

  function addRow(doc, at) {
    const id = fresh(doc.rows.map((r) => r.id));
    if (!id) return;
    const r = { id: id, audioText: sentence(), visualText: sentence(), status: pick(STATUSES) };
    doc.rows.splice(at === undefined ? doc.rows.length : at, 0, r);
  }
  function addComment(doc) {
    const id = fresh(doc.comments.map((c) => c.id));
    if (!id || !doc.rows.length) return;
    const t = when();
    const replies = [];
    for (let i = upTo(2); i > 0; i--) {
      const rid = fresh(replies.map((x) => x.id));
      if (rid) replies.push({ id: rid, body: sentence(), createdAt: when() });
    }
    doc.comments.push({ id: id, rowId: pick(doc.rows).id, field: "audioText", body: sentence(),
                        resolved: false, createdAt: t, updatedAt: t, replies: replies });
  }
  function addPerson(doc) {
    const id = fresh(doc.people.map((p) => p.id));
    if (id) doc.people.push({ id: id, name: pick(NAMES.concat(ids)) });
  }
  function addTag(doc) {
    const [cat, name] = pick(TAGS);
    if (doc.productionTags.some((t) => t.cat === cat && t.name === name)) return;
    doc.productionTags.push({ id: pick(ids), cat: cat, name: name, owner: doc.people.length && chance(0.5) ? pick(doc.people).id : "",
                              notes: chance(0.3) ? sentence() : "", status: "needed" });
  }
  function addShot(doc) {
    const id = fresh(doc.brollShots.map((b) => b.id));
    if (!id) return;
    const props = [];
    for (let i = upTo(2); i > 0; i--) props.push({ id: chance(0.5) ? pick(ids) : "", name: pick(WORDS.concat(ids)) });
    doc.brollShots.push({ id: id, name: pick(WORDS), desc: "", status: "unshot", reshoot: false, notes: "",
                          owner: "", audioRef: "", location: "", props: props, origin: "manual" });
  }

  const base = { docId: DOC_ID, title: "T", rows: [], comments: [], people: [], productionTags: [], brollShots: [] };
  for (let i = 1 + upTo(3); i > 0; i--) addRow(base);
  for (let i = upTo(3); i > 0; i--) addComment(base);
  for (let i = upTo(3); i > 0; i--) addPerson(base);
  for (let i = upTo(3); i > 0; i--) addTag(base);
  for (let i = upTo(3); i > 0; i--) addShot(base);

  function side() {
    const doc = JSON.parse(JSON.stringify(base));
    for (let i = upTo(5); i > 0; i--) {
      const op = upTo(13);
      if (op === 0 && doc.rows.length) doc.rows.splice(upTo(doc.rows.length - 1), 1);
      else if (op === 1) addRow(doc, upTo(doc.rows.length));
      else if (op === 2 && doc.rows.length) pick(doc.rows).audioText += " " + pick(WORDS);
      else if (op === 3 && doc.rows.length) pick(doc.rows).visualText = sentence();
      else if (op === 4 && doc.rows.length) pick(doc.rows).status = pick(STATUSES);
      else if (op === 5 && doc.comments.length) doc.comments.splice(upTo(doc.comments.length - 1), 1);
      else if (op === 6) addComment(doc);
      else if (op === 7 && doc.comments.length) {
        const c = pick(doc.comments);
        if (chance(0.5)) { c.body = sentence(); c.updatedAt = when(); }
        else { c.resolved = true; c.resolvedBy = pick(NAMES); c.resolvedAt = when(); }
        const rid = fresh(c.replies.map((x) => x.id));
        if (rid && chance(0.5)) c.replies.push({ id: rid, body: sentence(), createdAt: when() });
      }
      else if (op === 8 && doc.people.length) doc.people.splice(upTo(doc.people.length - 1), 1);
      else if (op === 9) addPerson(doc);
      else if (op === 10 && doc.productionTags.length) {
        if (chance(0.4)) doc.productionTags.splice(upTo(doc.productionTags.length - 1), 1);
        else Object.assign(pick(doc.productionTags), { status: pick(["needed", "sourcing", "have"]), notes: sentence() });
      }
      else if (op === 11) addTag(doc);
      else if (op === 12 && doc.brollShots.length) {
        if (chance(0.4)) doc.brollShots.splice(upTo(doc.brollShots.length - 1), 1);
        else {
          const b = pick(doc.brollShots);
          b.notes = sentence();
          if (chance(0.3)) b.status = "shot";
          if (chance(0.5)) b.props.push({ id: chance(0.5) ? pick(ids) : "", name: pick(WORDS.concat(ids)) });
          else if (b.props.length) b.props.splice(upTo(b.props.length - 1), 1);
        }
      }
      else addShot(doc);
    }
    return doc;
  }
  return { base: base, mine: side(), theirs: side() };
}

export function renameIds(value, names, suffix) {
  const re = new RegExp('"(' + names.map((n) => n.replace(/[$]/g, "\\$&")).join("|") + ')"', "g");
  return JSON.parse(JSON.stringify(value).replace(re, (m, id) => '"' + id + suffix + '"'));
}

export function unrenameIds(value, names, suffix) {
  const re = new RegExp('"(' + names.join("|") + ")" + suffix + '"', "g");
  return JSON.parse(JSON.stringify(value).replace(re, (m, id) => '"' + id + '"'));
}

export function settleMerge(result) {
  let text = JSON.stringify(result).replace(/"\d{4}-\d\d-\d\dT[^"]*Z"/g, (m) => (m.startsWith('"2026-01-01T') ? m : '"NOW"'));
  (result.merged.comments || []).filter((c) => c.kind === "conflict").forEach((c, i) => {
    text = text.split('"' + c.id + '"').join('"conflict-' + (i + 1) + '"');
  });
  return JSON.parse(text);
}
