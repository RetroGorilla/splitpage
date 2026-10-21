import { createRequire } from "node:module";
import { createHash } from "node:crypto";


const require = createRequire(import.meta.url);
const links = require("../server/links.js");

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + " — got " + a + ", expected " + e);
  console.log("  FAIL " + name + " — got " + a + ", expected " + e);
}

const isValidId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const sha = (text) => createHash("sha256").update(text).digest("hex");

function disk() {
  const writes = [];
  let fail = 0;
  const persist = async (text) => {
    if (fail > 0) { fail--; throw new Error("disk full"); }
    writes.push(JSON.parse(text));
  };
  return { writes, persist, failNext: (n) => { fail = n || 1; }, last: () => writes[writes.length - 1] };
}

function store(d) {
  return links.createLinkStore({ isValidId, persist: d ? d.persist : null });
}

async function rejects(promise) {
  try { await promise; return false; } catch (err) { return true; }
}

function live(s, rec) {
  return [!!s.byId(rec.id), !!s.byKey(rec.key), !!s.byToken(rec.token), s.activeLink(rec.docId, rec.role) === rec];
}

function dead(s, rec) {
  return [s.keyRevoked(rec.key), s.tokenRevoked(rec.token)];
}

eq("link ids are 12 lowercase hex characters", [links.isLinkId("0123456789ab"), links.isLinkId("0123456789AB"), links.isLinkId("0123456789a")], [true, false, false]);
eq("a link answer carries no token", Object.keys(links.linkAnswer({ id: "i", role: "edit", key: "k", token: "t", docId: "d", createdAt: "c", createdBy: "b" })), ["id", "role", "key", "createdAt"]);

const d1 = disk();
const s1 = store(d1);
const first = await s1.linkFor("doc", "edit", { by: "Ann" });
const rec1 = first.link;
eq("minting a link indexes it and writes it once", [first.created, live(s1, rec1), d1.writes.length, d1.last().links.map((l) => l.id)], [true, [true, true, true, true], 1, [rec1.id]]);
eq("a minted link has a hex key, token and id and records who made it", [/^[0-9a-f]{48}$/.test(rec1.key), /^[0-9a-f]{64}$/.test(rec1.token), links.isLinkId(rec1.id), rec1.createdBy], [true, true, true, "Ann"]);
const again = await s1.linkFor("doc", "edit", { by: "Bob" });
eq("asking again returns the same link without a write", [again.created, again.link === rec1, d1.writes.length], [false, true, 1]);
const other = await s1.linkFor("doc", "review");
eq("each role of a document has its own link", [other.created, other.link.role, s1.activeLink("doc", "edit") === rec1, other.link.createdBy], [true, "review", true, null]);

const replaced = await s1.linkFor("doc", "edit", { replace: true });
eq("replacing revokes the old link and saves both changes in one write", [
  replaced.created, live(s1, rec1), dead(s1, rec1), live(s1, replaced.link),
  d1.writes.length, d1.last().revoked.map((t) => t.id), d1.last().links.length
], [true, [false, false, false, false], [true, true], [true, true, true, true], 3, [rec1.id], 2]);
eq("a tombstone stores hashes, never the key or token", (() => {
  const t = d1.last().revoked[0];
  return [t.keyHash === sha(rec1.key), t.tokenHash === sha(rec1.token), JSON.stringify(t).includes(rec1.key), t.docId, t.role, typeof t.revokedAt];
})(), [true, true, false, "doc", "edit", "string"]);

const d2 = disk();
const s2 = store(d2);
d2.failNext();
eq("a failed write of a new link throws", await rejects(s2.linkFor("doc", "edit")), true);
eq("a failed write leaves no link in memory", [s2.activeLink("doc", "edit"), d2.writes.length], [null, 0]);
const retry = await s2.linkFor("doc", "edit");
eq("the next request mints and writes a fresh link", [retry.created, d2.last().links.length], [true, 1]);

const d3 = disk();
const s3 = store(d3);
const old3 = (await s3.linkFor("doc", "edit")).link;
d3.failNext();
eq("a failed write of a replacement throws", await rejects(s3.linkFor("doc", "edit", { replace: true })), true);
eq("after a failed replacement the old link stays revoked in memory and no link is active", [live(s3, old3), dead(s3, old3), s3.activeLink("doc", "edit")], [[false, false, false, false], [true, true], null]);
eq("disk still holds the old link until the next write", d3.last().links.map((l) => l.id), [old3.id]);
await s3.saveLinks();
eq("the next write carries the revocation", [d3.last().links.length, d3.last().revoked.map((t) => t.id)], [0, [old3.id]]);

const d4 = disk();
const s4 = store(d4);
const e4 = (await s4.linkFor("doc", "edit")).link;
const r4 = (await s4.linkFor("doc", "review")).link;
const k4 = (await s4.linkFor("keep", "edit")).link;
eq("revoking a document's links counts them and touches only that document", [s4.revokeLinksOf("doc"), s4.revokeLinksOf("doc"), live(s4, k4)], [2, 0, [true, true, true, true]]);
eq("revoking is in memory until saved", d4.last().links.length, 3);
await s4.saveLinks();
eq("the save writes the remaining link and both tombstones", [d4.last().links.map((l) => l.id), d4.last().revoked.map((t) => t.id).sort()], [[k4.id], [e4.id, r4.id].sort()]);
s4.revokeLink(k4);
d4.failNext();
eq("a failed save of a revocation throws but the link stays revoked in memory", [await rejects(s4.saveLinks()), live(s4, k4), dead(s4, k4)], [true, [false, false, false, false], [true, true]]);
await s4.saveLinks();
eq("a write after a failed one still runs", d4.last().links.length, 0);

eq("unknown keys and tokens are neither live nor revoked", [s4.byKey("x"), s4.byToken("x"), s4.keyRevoked("x"), s4.tokenRevoked("x"), store(null).tokenRevoked("x")], [undefined, undefined, false, false, false]);

const s5 = store(null);
eq("without persistence linkFor and saveLinks never write", [(await s5.linkFor("doc", "edit")).created, await s5.saveLinks()], [true, undefined]);

const order = [];
let release;
const gate = new Promise((r) => { release = r; });
const s6 = links.createLinkStore({
  isValidId,
  persist: async (text) => {
    const n = JSON.parse(text).links.length;
    order.push("start " + n);
    if (n === 1) await gate;
    order.push("end " + n);
  }
});
const p1 = s6.linkFor("a", "edit");
await new Promise((r) => setImmediate(r));
const p2 = s6.linkFor("b", "edit");
await new Promise((r) => setImmediate(r));
order.push("released");
release();
await Promise.all([p1, p2]);
eq("writes run one at a time in order, each with the state at its turn", order, ["start 1", "released", "end 1", "start 2", "end 2"]);

const d7 = disk();
const s7 = store(d7);
const keep7 = (await s7.linkFor("doc", "edit")).link;
const gone7 = (await s7.linkFor("doc", "review")).link;
s7.revokeLink(gone7);
await s7.saveLinks();
const r7 = store(null);
eq("a restart restores live links and revocations from the saved file", [r7.restore(JSON.parse(s7.serialize())), live(r7, r7.byId(keep7.id)), r7.byKey(keep7.key).token === keep7.token, dead(r7, gone7), r7.activeLink("doc", "review")], [0, [true, true, true, true], true, [true, true], null]);

const good = { id: "0123456789ab", key: "a".repeat(48), token: "b".repeat(64), docId: "doc", role: "edit", createdAt: "t", createdBy: 5 };
const r8 = store(null);
const skipped = r8.restore({
  revoked: [{ keyHash: sha("c".repeat(48)), tokenHash: sha("d".repeat(64)), id: "x" }, { keyHash: "nope", tokenHash: sha("x") }, null],
  links: [
    good,
    Object.assign({}, good, { id: "0123456789ac", key: "e".repeat(48), token: "f".repeat(64) }),
    Object.assign({}, good, { id: "0123456789ad", docId: "other", key: "a".repeat(48), token: "1".repeat(64) }),
    Object.assign({}, good, { id: "0123456789ae", docId: "third", key: "c".repeat(48), token: "2".repeat(64) }),
    Object.assign({}, good, { id: "0123456789af", docId: "Bad Id", key: "3".repeat(48), token: "4".repeat(64) }),
    Object.assign({}, good, { id: "0123456789b0", docId: "fourth", role: "admin", key: "5".repeat(48), token: "6".repeat(64) }),
    Object.assign({}, good, { id: "0123456789b1", docId: "fifth", key: "7".repeat(47), token: "8".repeat(64) }),
    "junk"
  ]
});
eq("restoring skips bad tombstones, duplicates, a second link per slot, revoked keys and malformed records", [skipped, r8.activeLink("doc", "edit") && r8.activeLink("doc", "edit").id, r8.byId("0123456789ad"), r8.byId("0123456789ae")], [9, "0123456789ab", undefined, undefined]);
eq("a restored record keeps only known fields with checked types", Object.keys(r8.byId("0123456789ab")).concat([r8.byId("0123456789ab").createdBy]), ["id", "key", "token", "docId", "role", "createdAt", "createdBy", null]);
eq("restoring nothing or a non-object restores nothing", [store(null).restore(null), store(null).restore({ links: "x", revoked: 3 })], [0, 0]);

const s9 = store(null);
const firstGone = (await s9.linkFor("d0", "edit")).link;
s9.revokeLink(firstGone);
for (let i = 1; i <= links.LINK_TOMBSTONE_MAX; i++) {
  s9.revokeLink((await s9.linkFor("d" + i, "edit")).link);
}
const lastGone = JSON.parse(s9.serialize()).revoked;
eq("tombstones are capped and the oldest is forgotten first", [lastGone.length, lastGone[0].id === firstGone.id, s9.keyRevoked(firstGone.key), s9.tokenRevoked(firstGone.token)], [links.LINK_TOMBSTONE_MAX, false, false, false]);

if (failures.length) {
  console.log("\n" + failures.length + " FAILED");
  process.exit(1);
}
console.log("\nALL PASS - " + passed + " server link checks");
