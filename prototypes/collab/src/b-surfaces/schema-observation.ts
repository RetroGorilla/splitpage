import type { BufferHarness } from "../buffer-harness.ts";
import { mapValue, textValue } from "../schema.ts";

export function observeBSchema(harness: BufferHarness) {
  const editor = harness.alice.editor;
  const segments = editor.doc.getMap("segments");
  return {
    candidate: editor.candidate,
    hasFlow: editor.doc.share.has("flow"),
    segments: editor.doc.getArray<string>("order").toArray().map(id => {
      const segment = mapValue(segments.get(id));
      const text = textValue(segment.get("text"));
      return { id, head: segment.get("head"), inner: text.toDelta().filter((delta: { insert?: unknown }) => typeof delta.insert === "object").map((delta: { insert?: unknown }) => delta.insert),
        characters: editor.characters().filter(character => character.text === text).map(character => ({ name: harness.identities.notation(character.identity), beat: character.beat })) };
    })
  };
}
