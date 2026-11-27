import type * as Y from "yjs";

export const NATIVE_FORMAT_VERSION = 1;

export interface NativeRoots {
  readonly meta: Y.Map<unknown>;
  readonly births: Y.Map<unknown>;
  readonly order: Y.Array<string>;
  readonly segments: Y.Map<Y.Map<unknown>>;
  readonly beats: Y.Map<Y.Map<unknown>>;
  readonly visuals: Y.Map<Y.Text>;
  readonly headings: Y.Map<Y.Map<unknown>>;
  readonly names: Y.Map<Y.Text>;
  readonly comments: Y.Map<Y.Map<unknown>>;
  readonly replies: Y.Map<Y.Map<unknown>>;
  readonly people: Y.Map<Y.Map<unknown>>;
  readonly tags: Y.Map<Y.Map<unknown>>;
  readonly tagKeys: Y.Map<string>;
  readonly shots: Y.Map<Y.Map<unknown>>;
  readonly edited: Y.Map<unknown>;
}

// why: a root read before its constructor is declared can lose Yjs formatting state, so every root is declared first
export function declareNativeRoots(doc: Y.Doc): NativeRoots {
  return Object.freeze({
    meta: doc.getMap<unknown>("meta"),
    births: doc.getMap<unknown>("births"),
    order: doc.getArray<string>("order"),
    segments: doc.getMap<Y.Map<unknown>>("segments"),
    beats: doc.getMap<Y.Map<unknown>>("beats"),
    visuals: doc.getMap<Y.Text>("visuals"),
    headings: doc.getMap<Y.Map<unknown>>("headings"),
    names: doc.getMap<Y.Text>("names"),
    comments: doc.getMap<Y.Map<unknown>>("comments"),
    replies: doc.getMap<Y.Map<unknown>>("replies"),
    people: doc.getMap<Y.Map<unknown>>("people"),
    tags: doc.getMap<Y.Map<unknown>>("tags"),
    tagKeys: doc.getMap<string>("tagKeys"),
    shots: doc.getMap<Y.Map<unknown>>("shots"),
    edited: doc.getMap<unknown>("edited")
  });
}
