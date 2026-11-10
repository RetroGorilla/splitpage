import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { STATE_FIELDS } from "../../../src/core/document/fields.ts";

const inventoryMapping: readonly [string, string][] = [
  ["`title`", "meta.title Y.Text"],
  ["`titleOrigin`", "meta.titleOrigin"],
  ["`titleVersion`", "meta.titleVersion"],
  ["`docId`", "meta.docId (import identity retained)"],
  ["`rows`", "order + beats"],
  ["`comments`", "comments map + import rank"],
  ["`people`", "people map + rank"],
  ["`productionTags`", "tags map + rank"],
  ["`brollShots`", "shots map + rank"],
  ["`wordsPerMinute`", "meta.wordsPerMinute"],
  ["`rev`", "meta.capture.rev (legacy export capture)"],
  ["`lastEditedBy`", "meta.capture.lastEditedBy (legacy export capture)"],
  ["`lastEditedAt`", "meta.capture.lastEditedAt (legacy export capture)"],
  ["`personColors`", "meta.capture.personColors (cannot derive historical palette from people)"],
  ["`targetSeconds`", "meta.targetSeconds"],
  ["`sections`", "segments[h:id].head + order + headings[id].extra"],
  ["`paragraphsDecided`", "meta.paragraphsDecided"],
  ["`schema`", "meta.schema (file schema, distinct from CRDT schema version)"],
  ["Unknown top-level keys (fixture `doc.unknownField.kept`)", "meta.extra JSON string; arbitrary key names retained"],
  ["Unknown keys on rows, comments, replies and shots", "beats/comments/replies/shots[id].extra JSON string"],
  ["Unknown keys on people and tag records", "people/tags[id].extra JSON string"],
  ["`rows[].id`", "beats[id].id + segments[b:id].head.b"],
  ["`rows[].audioText` (narration)", "segments[id].text and attributes"],
  ["`rows[].visualText` (visual)", "visuals[component].text Y.Text"],
  ["`rows[].status`", "beats[id].status initial value; causal changes belong to 5d"],
  ["`rows[].lengthSeconds`", "beats[id].lengthSeconds"],
  ["`rows[].paragraphStart`", "beats[id].paragraphStart (stored flag retained)"],
  ["`rows[].updatedAt`", "beats[id].stamp.at"],
  ["`rows[].updatedBy`", "beats[id].stamp.by"],
  ["`rows[].imageRef`", "gallery[slot].picture.imageRef; bytes outside Yjs"],
  ["`rows[].imageName`", "gallery[first].picture.name"],
  ["`rows[].imageAnnotation`", "gallery[first].picture.annotation JSON"],
  ["`rows[].imageLinks`", "gallery[first].links map"],
  ["`rows[].moreImages`", "gallery slots by rank then id"],
  ["`rows[].visualImage`", "file encoding only; app reference blob store inlines refs"],
  ["`moreImages[].imageRef`", "gallery[slot].picture.imageRef"],
  ["`moreImages[].name`", "gallery[slot].picture.name"],
  ["`moreImages[].annotation`", "gallery[slot].picture.annotation JSON"],
  ["`moreImages[].links`", "gallery[slot].links map"],
  ["`…links[].href`", "gallery[slot].links[key].href"],
  ["`…links[].name`, `…links[].size`", "gallery[slot].links[key].name,size"],
  ["`…links[].duration`", "gallery[slot].links[key].duration"],
  ["`…links[].poster`", "gallery[slot].links[key].poster"],
  ["`…links[].location`", "device-local; deliberately absent from encoded Yjs state"],
  ["Image reference `{sha256, width, height, mime}`", "gallery[slot].picture + comments[id].imageValue atomic JSON"],
  ["Hash-only inline image reference `{sha256}` (`StoredImageRef`)", "comments/replies[id].text atomic HTML, hash resolved externally"],
  ["Annotation mark, pen or highlight", "gallery[slot].picture.annotation.marks JSON"],
  ["Annotation mark, text", "gallery[slot].picture.annotation.marks JSON"],
  ["`sections[].id`", "segments[h:id].head.h + headings[id].id"],
  ["`sections[].name`", "segments[h:id].text"],
  ["`sections[].firstSceneId`", "derived from the next beat boundary in order; absent as a scalar"],
  ["`id`", "comments map key and record id"],
  ["`rowId`", "comments[id].rowId (last known fallback)"],
  ["`field`", "comments[id].field (last known fallback)"],
  ["`anchorId`", "comments[id].anchorId"],
  ["`quotedText`", "comments[id].quote"],
  ["`author`", "comments[id].author"],
  ["`body`", "comments[id].text atomic sanitized HTML"],
  ["`resolved`", "comments[id].resolution.resolved atomic group"],
  ["`resolvedBy`, `resolvedAt`", "comments[id].resolution.resolvedBy,resolvedAt"],
  ["`assignee`", "comments[id].assignee"],
  ["`createdAt`", "comments[id].createdAt"],
  ["`updatedAt`", "comments[id].updatedAt (legacy value retained)"],
  ["`kind`", "comments[id].kind"],
  ["`imageValue`", "comments[id].imageValue atomic image reference"],
  ["`conflictField`, `emptyValue`, `titleValue`", "comments[id] named keys"],
  ["`replies[]`", "replies map, commentId + import rank"],
  ["`replies[].id`", "replies[JSON.stringify([commentId,replyId])].id"],
  ["`replies[].author`, `.body`, `.createdAt`", "replies[id].author,text,createdAt"],
  ["`people[].id`", "people map key and record id"],
  ["`people[].name`", "people[id].name"],
  ["`productionTags[].id`", "tags map key and record id"],
  ["`productionTags[].cat`", "tags[id].cat"],
  ["`productionTags[].name`", "tags[id].name (stored fallback retained)"],
  ["`productionTags[].owner`", "tags[id].owner (stored fallback retained)"],
  ["`productionTags[].notes`", "tags[id].notes"],
  ["`productionTags[].status`", "tags[id].status initial value; causal changes belong to 5d"],
  ["`brollShots[].id`", "shots map key and record id"],
  ["`brollShots[].name`, `.desc`", "shots[id].name,desc (stored fallback retained)"],
  ["`brollShots[].status`", "shots[id].status initial value; causal changes belong to 5d"],
  ["`brollShots[].reshoot`", "shots[id].reshoot"],
  ["`brollShots[].notes`, `.audioRef`, `.location`", "shots[id].notes,audioRef,location"],
  ["`brollShots[].owner`", "shots[id].owner"],
  ["`brollShots[].origin`", "shots[id].origin"],
  ["`brollShots[].props[]`", "shots[id].props map keyed by brollPropKey, each value plus rank"],
  ["Characters and line breaks", "segments/visuals[id].text characters; comments/replies[id].text atomic HTML"],
  ["Bold, italic, underline, strike, highlight", "segments/visuals[id].text b,i,u,s,hl attributes; comments/replies[id].text atomic HTML"],
  ["Link", "segments/visuals[id].text l:occurrence attributes; comments/replies[id].text atomic HTML"],
  ["Comment mark", "segments/visuals[id].text c:commentId attributes; anchorId restored at projection"],
  ["Tag", "segments/visuals[id].text t:occurrence attributes referencing tag ids"],
  ["Stage direction", "segments/visuals[id].text dir attribute"],
  ["Audio cue", "segments/visuals[id].text cue attribute, stored losslessly"],
  ["B-roll key", "segments/visuals[id].text embed {k:shotId,label:original marker text}"],
  ["`@Name`", "segments/visuals[id].text embed {w:name}; rendered @ + name"],
  ["Image", "comments/replies[id].text atomic HTML; blob bytes external"],
  ["Video card", "comments/replies[id].text atomic HTML"]
];

test("literal mapping covers every Stage 0 inventory row", () => {
  const inventory = readFileSync(new URL("../../../docs/collaboration/stage-0/2-fields.md", import.meta.url), "utf8").split("## Marks with identity")[0] as string;
  const fields = inventory.split(/\r?\n/).filter(line => line.startsWith("| ") && !/^\| (Field|Item|---)/.test(line)).map(line => line.split("|")[1]?.trim());
  assert.equal(inventoryMapping.length, 96);
  assert.deepEqual(inventoryMapping.map(([field]) => field), fields);
  assert.ok(inventoryMapping.every(([, home]) => home.length > 0));
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

