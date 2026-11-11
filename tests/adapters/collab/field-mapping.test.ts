import { createMonitoredSharedDocument as createSharedDocument } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { STATE_FIELDS } from "../../../src/core/document/fields.ts";
import { destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { readRoots } from "./helpers.ts";
import { fieldMappingSource, legacyMappingSource } from "./mapping-source.ts";

type MappedValueProbe = readonly [root: string, path: readonly (string | number)[], expected: unknown, mode?: "absent"];

const inventoryMapping: readonly [string, string, readonly MappedValueProbe[]][] = [
  ["`title`","meta.title plain Y.Text + meta.titleMarks",[["meta",["title",0,"insert"],"Document title sentinel"],["meta",["titleMarks"],[]]]],
  ["`titleOrigin`", "meta.titleOrigin", [["meta",["titleOrigin"],"user"]]],
  ["`titleVersion`", "meta.titleVersion", [["meta",["titleVersion"],"v37"]]],
  ["`docId`", "meta.docId (import identity retained)", [["meta",["docId"],"d00000000000000000000000000000077"]]],
  ["`rows`", "order + beats", [["order",[],["h:Hprobe","b:Rprobe"]]]],
  ["`comments`", "comments map + import rank", [["comments",["Cprobe","id"],"Cprobe"]]],
  ["`people`", "people map + rank", [["people",["Pprobe","id"],"Pprobe"]]],
  ["`productionTags`", "tags map + rank", [["tags",["t_probe","id"],"t_probe"]]],
  ["`brollShots`", "shots map + rank", [["shots",["Sprobe","id"],"Sprobe"]]],
  ["`wordsPerMinute`", "meta.wordsPerMinute", [["meta",["wordsPerMinute"],223]]],
  ["`rev`", "meta.capture.rev (legacy export capture)", [["meta",["capture","rev"],37]]],
  ["`lastEditedBy`", "meta.capture.lastEditedBy (legacy export capture)", [["meta",["capture","lastEditedBy"],"Legacy editor"]]],
  ["`lastEditedAt`", "meta.capture.lastEditedAt (legacy export capture)", [["meta",["capture","lastEditedAt"],"2026-03-05T06:07:08Z"]]],
  ["`personColors`", "meta.capture.personColors (cannot derive historical palette from people)", [["meta",["capture","personColors","Person sentinel"],"#80BDFB"]]],
  ["`targetSeconds`", "meta.targetSeconds", [["meta",["targetSeconds"],4321]]],
  ["`sections`", "segments[h:id].head + order + headings[id].extra", [["segments",["h:Hprobe","head","h"],"Hprobe"],["headings",["Hprobe","id"],"Hprobe"],["order",[],["h:Hprobe","b:Rprobe"]]]],
  ["`paragraphsDecided`", "meta.paragraphsDecided", [["meta",["paragraphsDecided"],true]]],
  ["`schema`", "meta.schema (file schema, distinct from CRDT schema version)", [["meta",["schema"],2]]],
  ["Unknown top-level keys (fixture `doc.unknownField.kept`)", "meta.extra JSON string; arbitrary key names retained", [["meta",["extra","$json","futureTop","kept"],"top extra sentinel"]]],
  ["Unknown keys on rows, comments, replies and shots", "beats/comments/replies/shots[id].extra JSON string", [["beats",["Rprobe","extra","$json","futureRow"],"row extra sentinel"],["comments",["Cprobe","extra","$json","futureComment"],"comment extra sentinel"],["replies",["[\"Cprobe\",\"RPprobe\"]","extra","$json","futureReply"],"reply extra sentinel"],["shots",["Sprobe","extra","$json","futureShot"],"shot extra sentinel"]]],
  ["Unknown keys on people and tag records", "people/tags[id].extra JSON string", [["people",["Pprobe","extra","$json","futurePerson"],"person extra sentinel"],["tags",["t_probe","extra","$json","futureTag"],"tag extra sentinel"]]],
  ["`rows[].id`", "beats[id].id + segments[b:id].head.b", [["beats",["Rprobe","id"],"Rprobe"],["segments",["b:Rprobe","head","b"],"Rprobe"]]],
  ["`rows[].audioText` (narration)","segments[id].text plain Y.Text + immutable markRecords",[["segments",["b:Rprobe","text"],[{"insert":"format sentinel|link sentinel|comment sentinel|tag sentinel|direction sentinel|cue sentinel|plain\ntail"}]]]],
  ["`rows[].visualText` (visual)","visuals[component].text plain Y.Text + immutable markRecords",[["visuals",["Rprobe","text",0,"insert"],"format sentinel|link sentinel|comment sentinel|tag sentinel|direction sentinel|cue sentinel|plain\ntail|"],["visuals",["Rprobe","text",1,"insert"],{"k":"Sprobe","label":"B-roll:"}],["visuals",["Rprobe","text",3,"insert"],{"w":"Person sentinel"}]]],
  ["`rows[].status`", "beats[id].status initial value; causal changes belong to 5d", [["beats",["Rprobe","status"],"shot"]]],
  ["`rows[].lengthSeconds`", "beats[id].lengthSeconds", [["beats",["Rprobe","lengthSeconds"],123]]],
  ["`rows[].paragraphStart`", "beats[id].paragraphStart (stored flag retained)", [["beats",["Rprobe","paragraphStart"],true]]],
  ["`rows[].updatedAt`", "beats[id].stamp.at", [["beats",["Rprobe","stamp","at"],"2026-04-05T06:07:08Z"]]],
  ["`rows[].updatedBy`", "beats[id].stamp.by", [["beats",["Rprobe","stamp","by"],"Row editor sentinel"]]],
  ["`rows[].imageRef`", "gallery[slot].picture.imageRef; bytes outside Yjs", [["gallery",["Rprobe:slot:0","picture","imageRef"],{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","width":11,"height":13,"mime":"image/png"}]]],
  ["`rows[].imageName`", "gallery[first].picture.name", [["gallery",["Rprobe:slot:0","picture","name"],"First picture sentinel"]]],
  ["`rows[].imageAnnotation`", "gallery[first].picture.annotation JSON", [["gallery",["Rprobe:slot:0","picture","annotation"],{"imageRef":{"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","width":17,"height":19,"mime":"image/png"},"marks":[{"kind":"pen","color":"#ffb703","width":0.02,"points":[0.1,0.2,0.3,0.4]},{"kind":"text","color":"#ffb703","size":0.1,"x":0.2,"y":0.3,"text":"Annotation text sentinel"}]}]]],
  ["`rows[].imageLinks`", "gallery[first].links map", [["gallery",["Rprobe:slot:0","links","u:https://example.test/inventory-video","href"],"https://example.test/inventory-video"],["gallery",["Rprobe:slot:0","links","f:inventory-clip.mp4:12345","name"],"inventory-clip.mp4"]]],
  ["`rows[].moreImages`", "gallery slots by rank then id", [["gallery",["Rprobe:slot:1","picture","name"],"Other picture sentinel"],["gallery",["Rprobe:slot:1","rank"],"0000000001"]]],
  ["`rows[].visualImage`", "file encoding only; app reference blob store inlines refs", [["beats",["Rlegacy","visualImage"],"file encoding only; absent from validated and shared beats","absent"],["gallery",["Rlegacy:slot:0","picture","imageRef","width"],3],["gallery",["Rlegacy:slot:0","picture","imageRef","height"],5]]],
  ["`moreImages[].imageRef`", "gallery[slot].picture.imageRef", [["gallery",["Rprobe:slot:1","picture","imageRef"],{"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","width":23,"height":29,"mime":"image/png"}]]],
  ["`moreImages[].name`", "gallery[slot].picture.name", [["gallery",["Rprobe:slot:1","picture","name"],"Other picture sentinel"]]],
  ["`moreImages[].annotation`", "gallery[slot].picture.annotation JSON", [["gallery",["Rprobe:slot:1","picture","annotation"],{"imageRef":{"sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","width":31,"height":37,"mime":"image/png"},"marks":[{"kind":"highlight","color":"#ffb703","width":0.03,"points":[0.1,0.2,0.7,0.8]}]}]]],
  ["`moreImages[].links`", "gallery[slot].links map", [["gallery",["Rprobe:slot:1","links","u:https://example.test/other-video"],{"href":"https://example.test/other-video","duration":82.3,"poster":true,"rank":"0000000000","extra":"{}"}]]],
  ["`…links[].href`", "gallery[slot].links[key].href", [["gallery",["Rprobe:slot:0","links","u:https://example.test/inventory-video","href"],"https://example.test/inventory-video"]]],
  ["`…links[].name`, `…links[].size`", "gallery[slot].links[key].name,size", [["gallery",["Rprobe:slot:0","links","f:inventory-clip.mp4:12345","name"],"inventory-clip.mp4"],["gallery",["Rprobe:slot:0","links","f:inventory-clip.mp4:12345","size"],12345]]],
  ["`…links[].duration`", "gallery[slot].links[key].duration", [["gallery",["Rprobe:slot:0","links","u:https://example.test/inventory-video","duration"],91.2]]],
  ["`…links[].poster`", "gallery[slot].links[key].poster", [["gallery",["Rprobe:slot:0","links","u:https://example.test/inventory-video","poster"],true]]],
  ["`…links[].location`", "device-local; deliberately absent from encoded Yjs state", [["gallery",["Rprobe:slot:0","links","f:inventory-clip.mp4:12345","location"],"device-local; local-sentinel.mp4 must not enter shared state","absent"]]],
  ["Image reference `{sha256, width, height, mime}`", "gallery[slot].picture + comments[id].imageValue atomic JSON", [["gallery",["Rprobe:slot:0","picture","imageRef"],{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","width":11,"height":13,"mime":"image/png"}],["comments",["Cimage","imageValue"],{"sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","width":47,"height":53,"mime":"image/png"}]]],
  ["Hash-only inline image reference `{sha256}` (`StoredImageRef`)", "comments/replies[id].text atomic HTML, hash resolved externally", [["comments",["Cmedia","text"],"<img class=\"comment-img\" data-blob=\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\">"]]],
  ["Annotation mark, pen or highlight", "gallery[slot].picture.annotation.marks JSON", [["gallery",["Rprobe:slot:0","picture","annotation","marks",0],{"kind":"pen","color":"#ffb703","width":0.02,"points":[0.1,0.2,0.3,0.4]}],["gallery",["Rprobe:slot:1","picture","annotation","marks",0],{"kind":"highlight","color":"#ffb703","width":0.03,"points":[0.1,0.2,0.7,0.8]}]]],
  ["Annotation mark, text", "gallery[slot].picture.annotation.marks JSON", [["gallery",["Rprobe:slot:0","picture","annotation","marks",1],{"kind":"text","color":"#ffb703","size":0.1,"x":0.2,"y":0.3,"text":"Annotation text sentinel"}]]],
  ["`sections[].id`", "segments[h:id].head.h + headings[id].id", [["segments",["h:Hprobe","head","h"],"Hprobe"],["headings",["Hprobe","id"],"Hprobe"]]],
  ["`sections[].name`", "segments[h:id].text", [["segments",["h:Hprobe","text",0,"insert"],"Heading sentinel"]]],
  ["`sections[].firstSceneId`", "derived from the next beat boundary in order; absent as a scalar", [["headings",["Hprobe","firstSceneId"],"derived from order; no shared scalar","absent"],["order",[],["h:Hprobe","b:Rprobe"]]]],
  ["`id`", "comments map key and record id", [["comments",["Cprobe","id"],"Cprobe"]]],
  ["`rowId`", "comments[id].rowId (last known fallback)", [["comments",["Cprobe","rowId"],"Rprobe"]]],
  ["`field`", "comments[id].field (last known fallback)", [["comments",["Cprobe","field"],"audioText"]]],
  ["`anchorId`", "comments[id].anchorId", [["comments",["Cprobe","anchorId"],"Canchor"]]],
  ["`quotedText`", "comments[id].quote", [["comments",["Cprobe","quote"],"Quoted sentinel"]]],
  ["`author`", "comments[id].author", [["comments",["Cprobe","author"],"Author sentinel"]]],
  ["`body`", "comments[id].text atomic sanitized HTML", [["comments",["Cprobe","text"],"Comment body sentinel"]]],
  ["`resolved`", "comments[id].resolution.resolved atomic group", [["comments",["Cprobe","resolution","resolved"],true]]],
  ["`resolvedBy`, `resolvedAt`", "comments[id].resolution.resolvedBy,resolvedAt", [["comments",["Cprobe","resolution","resolvedBy"],"Resolver sentinel"],["comments",["Cprobe","resolution","resolvedAt"],"2026-02-04T04:05:06Z"]]],
  ["`assignee`", "comments[id].assignee", [["comments",["Cprobe","assignee"],"Assignee sentinel"]]],
  ["`createdAt`", "comments[id].createdAt", [["comments",["Cprobe","createdAt"],"2026-01-02T03:04:05Z"]]],
  ["`updatedAt`", "comments[id].updatedAt (legacy value retained)", [["comments",["Cprobe","updatedAt"],"2026-02-03T04:05:06Z"]]],
  ["`kind`", "comments[id].kind", [["comments",["Cprobe","kind"],"conflict"]]],
  ["`imageValue`", "comments[id].imageValue atomic image reference", [["comments",["Cimage","imageValue"],{"sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","width":47,"height":53,"mime":"image/png"}]]],
  ["`conflictField`, `emptyValue`, `titleValue`", "comments[id] named keys", [["comments",["Cprobe","conflictField"],"audioText"],["comments",["Cprobe","emptyValue"],true],["comments",["Cprobe","titleValue"],"Title conflict sentinel"]]],
  ["`replies[]`", "replies map, commentId + import rank", [["replies",["[\"Cprobe\",\"RPprobe\"]","commentId"],"Cprobe"],["replies",["[\"Cprobe\",\"RPprobe\"]","text"],"Reply body sentinel"]]],
  ["`replies[].id`", "replies[JSON.stringify([commentId,replyId])].id", [["replies",["[\"Cprobe\",\"RPprobe\"]","id"],"RPprobe"]]],
  ["`replies[].author`, `.body`, `.createdAt`", "replies[id].author,text,createdAt", [["replies",["[\"Cprobe\",\"RPprobe\"]","author"],"Reply author sentinel"],["replies",["[\"Cprobe\",\"RPprobe\"]","text"],"Reply body sentinel"],["replies",["[\"Cprobe\",\"RPprobe\"]","createdAt"],"2026-02-05T04:05:06Z"]]],
  ["`people[].id`", "people map key and record id", [["people",["Pprobe","id"],"Pprobe"]]],
  ["`people[].name`", "people[id].name", [["people",["Pprobe","name"],"Person sentinel"]]],
  ["`productionTags[].id`", "tags map key and record id", [["tags",["t_probe","id"],"t_probe"]]],
  ["`productionTags[].cat`", "tags[id].cat", [["tags",["t_probe","cat"],"prop"]]],
  ["`productionTags[].name`", "tags[id].name (stored fallback retained)", [["tags",["t_probe","name"],"Prop sentinel"]]],
  ["`productionTags[].owner`", "tags[id].owner (stored fallback retained)", [["tags",["t_probe","owner"],"Pprobe"]]],
  ["`productionTags[].notes`", "tags[id].notes", [["tags",["t_probe","notes"],"Tag notes sentinel"]]],
  ["`productionTags[].status`", "tags[id].status initial value; causal changes belong to 5d", [["tags",["t_probe","status"],"have"]]],
  ["`brollShots[].id`", "shots map key and record id", [["shots",["Sprobe","id"],"Sprobe"]]],
  ["`brollShots[].name`, `.desc`", "shots[id].name,desc (stored fallback retained)", [["shots",["Sprobe","name"],"Shot name sentinel"],["shots",["Sprobe","desc"],"Shot description sentinel"]]],
  ["`brollShots[].status`", "shots[id].status initial value; causal changes belong to 5d", [["shots",["Sprobe","status"],"shot"]]],
  ["`brollShots[].reshoot`", "shots[id].reshoot", [["shots",["Sprobe","reshoot"],true]]],
  ["`brollShots[].notes`, `.audioRef`, `.location`", "shots[id].notes,audioRef,location", [["shots",["Sprobe","notes"],"Shot notes sentinel"],["shots",["Sprobe","audioRef"],"Shot audio sentinel"],["shots",["Sprobe","location"],"Shot location sentinel"]]],
  ["`brollShots[].owner`", "shots[id].owner", [["shots",["Sprobe","owner"],"Pprobe"]]],
  ["`brollShots[].origin`", "shots[id].origin", [["shots",["Sprobe","origin"],"list"]]],
  ["`brollShots[].props[]`", "shots[id].props map keyed by brollPropKey, each value plus rank", [["shots",["Sprobe","props","t_probe","value"],{"id":"t_probe","name":"Prop sentinel"}]]],
  ["Characters and line breaks","segments/visuals[id].text plain characters; comments/replies[id].text atomic HTML",[["segments",["b:Rprobe","text",0,"insert"],"format sentinel|link sentinel|comment sentinel|tag sentinel|direction sentinel|cue sentinel|plain\ntail"],["visuals",["Rprobe","text",0,"insert"],"format sentinel|link sentinel|comment sentinel|tag sentinel|direction sentinel|cue sentinel|plain\ntail|"]]],
  ["Bold, italic, underline, strike, highlight","segments/visuals[id].markRecords additions of b,i,u,s,hl; comments/replies[id].text atomic HTML",[["segments",["b:Rprobe","markRecords",0],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",0]","writer":"hydration","start":0,"end":15,"mark":{"kind":"b","value":true},"born":null}],["segments",["b:Rprobe","markRecords",1],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",1]","writer":"hydration","start":0,"end":15,"mark":{"kind":"hl","value":true},"born":null}],["segments",["b:Rprobe","markRecords",2],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",2]","writer":"hydration","start":0,"end":15,"mark":{"kind":"i","value":true},"born":null}],["segments",["b:Rprobe","markRecords",3],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",3]","writer":"hydration","start":0,"end":15,"mark":{"kind":"s","value":true},"born":null}],["segments",["b:Rprobe","markRecords",4],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",4]","writer":"hydration","start":0,"end":15,"mark":{"kind":"u","value":true},"born":null}],["visuals",["Rprobe","markRecords",0],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",0]","writer":"hydration","start":0,"end":15,"mark":{"kind":"b","value":true},"born":null}],["visuals",["Rprobe","markRecords",1],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",1]","writer":"hydration","start":0,"end":15,"mark":{"kind":"hl","value":true},"born":null}],["visuals",["Rprobe","markRecords",2],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",2]","writer":"hydration","start":0,"end":15,"mark":{"kind":"i","value":true},"born":null}],["visuals",["Rprobe","markRecords",3],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",3]","writer":"hydration","start":0,"end":15,"mark":{"kind":"s","value":true},"born":null}],["visuals",["Rprobe","markRecords",4],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",4]","writer":"hydration","start":0,"end":15,"mark":{"kind":"u","value":true},"born":null}]]],
  ["Link","segments/visuals[id].markRecords anchored link additions; deterministic hydration identity",[["segments",["b:Rprobe","markRecords",5],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",5]","writer":"hydration","start":16,"end":29,"mark":{"kind":"link","id":"b:Rprobe:audioText:1","value":"https://example.test/text-link"},"born":null}],["visuals",["Rprobe","markRecords",5],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",5]","writer":"hydration","start":16,"end":29,"mark":{"kind":"link","id":"Rprobe:visualText:1","value":"https://example.test/text-link"},"born":null}]]],
  ["Comment mark","segments/visuals[id].markRecords anchored comment additions; deterministic hydration identity",[["segments",["b:Rprobe","markRecords",6],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",6]","writer":"hydration","start":30,"end":46,"mark":{"kind":"comment","id":"Cprobe","value":true},"born":null}],["visuals",["Rprobe","markRecords",6],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",6]","writer":"hydration","start":30,"end":46,"mark":{"kind":"comment","id":"Cprobe","value":true},"born":null}]]],
  ["Tag","segments/visuals[id].markRecords anchored tag additions; deterministic hydration identity",[["segments",["b:Rprobe","markRecords",7],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",7]","writer":"hydration","start":47,"end":59,"mark":{"kind":"tag","id":"b:Rprobe:audioText:0000000002","value":"t_probe"},"born":null}],["visuals",["Rprobe","markRecords",7],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",7]","writer":"hydration","start":47,"end":59,"mark":{"kind":"tag","id":"Rprobe:visualText:0000000002","value":"t_probe"},"born":null}]]],
  ["Stage direction","segments/visuals[id].markRecords anchored dir additions; deterministic hydration identity",[["segments",["b:Rprobe","markRecords",8],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",8]","writer":"hydration","start":60,"end":78,"mark":{"kind":"dir","value":true},"born":null}],["visuals",["Rprobe","markRecords",8],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",8]","writer":"hydration","start":60,"end":78,"mark":{"kind":"dir","value":true},"born":null}]]],
  ["Audio cue","segments/visuals[id].markRecords anchored cue additions; deterministic hydration identity",[["segments",["b:Rprobe","markRecords",9],{"type":"add","operation":"[\"hydrate\",\"audioText\",\"b:Rprobe\",9]","writer":"hydration","start":79,"end":91,"mark":{"kind":"cue","value":true},"born":null}],["visuals",["Rprobe","markRecords",9],{"type":"add","operation":"[\"hydrate\",\"visualText\",\"Rprobe\",9]","writer":"hydration","start":79,"end":91,"mark":{"kind":"cue","value":true},"born":null}]]],
  ["B-roll key","segments/visuals[id].text embed {k:shotId,label:original marker text}",[["visuals",["Rprobe","text",1,"insert"],{"k":"Sprobe","label":"B-roll:"}]]],
  ["`@Name`","segments/visuals[id].text embed {w:name}; rendered @ + name",[["visuals",["Rprobe","text",3,"insert"],{"w":"Person sentinel"}]]],
  ["Image", "comments/replies[id].text atomic HTML; blob bytes external", [["comments",["Cmedia","text"],"<img class=\"comment-img\" data-blob=\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\">"]]],
  ["Video card", "comments/replies[id].text atomic HTML", [["replies",["[\"Cmedia\",\"RPmedia\"]","text"],"<a class=\"video-embed-card\" href=\"https://example.test/media\"><span class=\"vec-host\">Media host sentinel</span></a>"]]]
];

test("literal mapping covers every Stage 0 inventory row", () => {
  const inventory = readFileSync(new URL("../../../docs/collaboration/stage-0/2-fields.md", import.meta.url), "utf8").split("## Marks with identity")[0] as string;
  const fields = inventory.split(/\r?\n/).filter(line => line.startsWith("| ") && !/^\| (Field|Item|---)/.test(line)).map(line => line.split("|")[1]?.trim());
  assert.equal(inventoryMapping.length, 96);
  assert.deepEqual(inventoryMapping.map(([field]) => field), fields);
  assert.ok(inventoryMapping.every(([, , probes]) => probes.length > 0));
});

function followStoredPath(value: unknown, path: readonly (string | number)[]): { present: boolean; value: unknown } {
  let current = value;
  for (const key of path) {
    if (key === "$json") {
      assert.equal(typeof current, "string");
      current = JSON.parse(current as string) as unknown;
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { present: false, value: undefined };
    current = (current as Record<string | number, unknown>)[key];
  }
  return { present: true, value: current };
}

for (const [field, home, probes] of inventoryMapping) test("hydration field mapping: " + field, () => {
  const handle = createSharedDocument();
  const source = field === "`rows[].visualImage`" ? legacyMappingSource() : fieldMappingSource();
  try {
    hydrateSharedDocument(handle, source);
    const roots = readRoots(handle);
    for (const [root, path, expected, mode] of probes) {
      const found = followStoredPath(roots, [root, ...path]);
      const context = field + " -> " + home + " -> " + JSON.stringify([root, ...path]);
      if (mode === "absent") {
        assert.equal(found.present, false, context + "; " + String(expected));
        if (field === "`…links[].location`") assert.equal(JSON.stringify(roots).includes("local-sentinel.mp4"), false);
      } else {
        assert.equal(found.present, true, context);
        assert.deepEqual(found.value, expected, context);
      }
    }
  } finally {
    destroySharedDocument(handle);
  }
});

const declaredFields: Record<string, readonly string[]> = {
  DocumentShape: ["title", "docId", "rev", "schema", "targetSeconds", "paragraphsDecided", "rows", "comments", "people", "productionTags", "brollShots"],
  DocumentRow: ["id", "visualText", "audioText", "paragraphStart"],
  DocumentComment: ["rowId", "field", "anchorId", "id", "resolvedAt", "createdAt", "updatedAt", "replies"],
  DocumentReply: ["id", "createdAt"],
  DocumentTag: ["id", "cat", "name", "owner", "notes", "status"],
  DocumentShot: ["id", "name", "desc", "status", "reshoot", "notes", "owner", "audioRef", "location", "props", "origin"],
  DocumentShotProp: ["id", "name"],
  DocumentScene: ["id", "name", "firstSceneId"],
  GalleryItem: ["imageRef", "name", "links", "annotation"],
  VideoLink: ["href", "name", "size", "location", "duration", "poster"],
  Annotation: ["imageRef", "marks"],
  PenMark: ["kind", "color", "width", "points"],
  TextMark: ["kind", "color", "size", "x", "y", "text"],
  ImageRef: ["sha256", "width", "height", "mime"],
  Marks: ["b", "i", "u", "s", "hl", "dir", "cue", "href", "tag", "innerTags", "cmt"]
};

test("document type fields cannot grow outside the reviewed mapping", () => {
  const visited: string[] = [];
  for (const path of ["document/validated.ts", "document/scenes.ts", "document/gallery.ts", "document/ports.ts", "text/runs.ts"]) {
    const source = ts.createSourceFile(path, readFileSync(new URL("../../../src/core/" + path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
      const expected = declaredFields[statement.name.text];
      if (!expected) continue;
      const body = ts.isInterfaceDeclaration(statement) ? statement : statement.type;
      assert.ok(ts.isInterfaceDeclaration(body) || ts.isTypeLiteralNode(body));
      const fields = body.members.filter(member => ts.isPropertySignature(member)).map(member => member.name.getText(source));
      assert.deepEqual(fields, expected, statement.name.text);
      if (statement.name.text === "DocumentShape") {
        const people = body.members.find(member => ts.isPropertySignature(member) && member.name.getText(source) === "people");
        assert.ok(people && ts.isPropertySignature(people) && people.type && ts.isArrayTypeNode(people.type) && ts.isTypeLiteralNode(people.type.elementType));
        assert.deepEqual(people.type.elementType.members.filter(member => ts.isPropertySignature(member)).map(member => member.name.getText(source)), ["id", "name"]);
      }
      visited.push(statement.name.text);
    }
  }
  assert.deepEqual(visited.sort(), Object.keys(declaredFields).sort());
  assert.deepEqual(STATE_FIELDS.map(field => field.key).sort(), ["title", "titleOrigin", "titleVersion", "docId", "rows", "comments", "people", "productionTags", "brollShots", "wordsPerMinute", "rev", "lastEditedBy", "lastEditedAt", "personColors", "targetSeconds", "sections", "paragraphsDecided", "schema"].sort());
});

