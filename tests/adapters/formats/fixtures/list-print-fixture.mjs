import { buildExportDocument } from "../../../../src/core/document/export-document.ts";
import { scriptFixture } from "./script-print-fixture.mjs";

export function listFixture(kind = "rich") {
  const { source, input } = scriptFixture(kind === "empty" ? "empty" : "rich");
  source.people = [{ id: "p1", name: "Sam <img src=x> 中文" }, { id: "p2", name: "Jo العربية" }];
  const production = kind === "empty" ? [] : [
    { catId: "prop", name: "Kettle 中文", status: "sourcing", owner: "p1", notes: "Red one\nHandle carefully", orphaned: false },
    { catId: "prop", name: "Mug 日本語", status: "have", owner: "", notes: "", orphaned: false },
    { catId: "gear", name: "Camera العربية", status: "returned", owner: "p2", notes: "Inspect lens", orphaned: true },
    { catId: "gear", name: "Battery हिन्दी", status: "needed", owner: "", notes: "", orphaned: false },
    { catId: "location", name: "Kitchen", status: "have", owner: "", notes: "Back entrance", orphaned: false },
    { catId: "cast", name: "Presenter", status: "needed", owner: "p2", notes: "", orphaned: false }
  ];
  if (kind === "long") {
    production[0].name += "LongLabel".repeat(50);
    production[0].notes = Array.from({ length: 100 }, (_, i) => "Packing note line " + i).join("\n");
    for (let i = 0; i < 90; i++) production.push({ catId: i % 2 ? "gear" : "prop", name: "Spare " + String(i).padStart(3, "0"), status: "needed", owner: "p1", notes: "Long list item 中文", orphaned: false });
  }
  production.forEach((item, index) => {
    item.key = item.catId + " " + item.name.toLowerCase();
    item.id = "tag-" + index;
    item.mentions = item.orphaned ? [] : [{ rowId: "r1", rowIndex: 0, field: "visualText", text: item.name }];
  });
  const broll = kind === "empty" ? [] : [
    { id: "s1", name: "Steam 中文", rowId: "r1", rowIndex: 0, status: "unshot", reshoot: true, owner: "p1", location: "Kitchen", notes: "Check reflection", desc: "Tight, then wider\nHold for steam", audioRef: "Captured audio ".repeat(18), props: [{ key: "prop kettle 中文", id: "tag-0", name: "Kettle 中文", status: "sourcing" }] },
    { id: "s2", name: "Pour 日本語", rowId: "r1", rowIndex: 0, status: "shot", reshoot: false, owner: "p2", location: "Kitchen", notes: "Keep this take", desc: "Overhead", audioRef: "", props: [{ key: "prop mug 日本語", id: "tag-1", name: "Mug 日本語", status: "have" }] },
    { id: "s3", name: "Room العربية", rowId: null, rowIndex: -1, status: "unshot", reshoot: false, owner: "", location: "", notes: "Added shot", desc: "Wide", audioRef: "", props: [] }
  ];
  if (kind === "long") {
    broll[0].name += "UnbrokenShot".repeat(50);
    broll[0].location += "LongLocation".repeat(45);
    broll[0].desc = Array.from({ length: 110 }, (_, i) => "Shot description line " + i).join("\n");
    for (let i = 0; i < 65; i++) broll.push({ ...broll[1], id: "extra-" + i, name: "Extra shot " + String(i).padStart(3, "0"), notes: "Final notes " + i, props: [] });
  }
  broll.forEach((shot, index) => { shot.ordinal = index; });
  const models = { production, broll, commentNumbers: input.doc.commentNumbers };
  const doc = buildExportDocument(source, input.doc.capturedAt, models, { clockMode: "24" });
  return { source, models, input: { ...input, doc } };
}
