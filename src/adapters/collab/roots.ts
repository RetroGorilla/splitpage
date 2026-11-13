import * as Y from "yjs";

export const collabRootTypes = Object.freeze({
  segments: Y.Map<unknown>,
  order: Y.Array<string>,
  beats: Y.Map<unknown>,
  visuals: Y.Map<unknown>,
  gallery: Y.Map<unknown>,
  comments: Y.Map<unknown>,
  replies: Y.Map<unknown>,
  people: Y.Map<unknown>,
  tags: Y.Map<unknown>,
  shots: Y.Map<unknown>,
  meta: Y.Map<unknown>,
  removalRecords: Y.Map<unknown>,
  retiredJoins: Y.Map<unknown>,
  statusEvents: Y.Map<unknown>,
  retiredStatus: Y.Map<unknown>,
  headings: Y.Map<unknown>,
  discards: Y.Map<unknown>,
  retiredDiscards: Y.Map<unknown>,
  deletedPeople: Y.Map<unknown>
});

export type CollabRoots = {
  readonly [Root in keyof typeof collabRootTypes]: InstanceType<(typeof collabRootTypes)[Root]>;
};

// why: Root constructors must exist before hydration; late promotion can lose Yjs formatting state.
export function declareCollabRoots(doc: Y.Doc): CollabRoots {
  return Object.fromEntries(Object.entries(collabRootTypes).map(([name, type]) => [name, doc.get(name, type)])) as CollabRoots;
}
