import * as Y from "yjs";

export function readSharedIdentityEmbeds(transaction: Y.Transaction, inspect?: () => void): readonly {
  readonly text: Y.Text; readonly value: unknown; readonly identity: { readonly client: number; readonly clock: number }; readonly delta: 1 | -1;
}[] {
  const result: { text: Y.Text; value: unknown; identity: { client: number; clock: number }; delta: 1 | -1 }[] = [];
  // why: Yjs 13.6.33 has no event carrying removed embed values without reading the text's full delta.
  const read = (item: Y.Item | Y.GC, delta: 1 | -1) => {
    inspect?.();
    if (item instanceof Y.GC) return;
    const failure = "Yjs 13.6.33 removed-embed struct contract changed";
    if (!(item instanceof Y.Item)) throw new Error(failure);
    const content = item.content, parent = item.parent, id = item.id;
    if (typeof item.deleted !== "boolean" || !id || !Number.isSafeInteger(id.client) || id.client < 0 || !Number.isSafeInteger(id.clock) || id.clock < 0
      || !content || typeof content.getContent !== "function" || !(parent instanceof Y.AbstractType)) throw new Error(failure);
    if (delta === 1 ? item.deleted : id.clock >= (transaction.beforeState.get(id.client) ?? 0)) return;
    if (delta === -1 && !item.deleted) throw new Error(failure);
    if (!(parent instanceof Y.Text) || !(content instanceof Y.ContentEmbed)) return;
    if (!Object.hasOwn(content, "embed")) throw new Error(failure);
    result.push({ text: parent, value: content.embed, identity: { client: id.client, clock: id.clock }, delta });
  };
  const added = Y.createDeleteSet();
  for (const [client, end] of transaction.afterState) {
    const clock = transaction.beforeState.get(client) ?? 0;
    if (end > clock) added.clients.set(client, [{ clock, len: end - clock }]);
  }
  Y.iterateDeletedStructs(transaction, added, item => read(item, 1));
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, item => read(item, -1));
  return result;
}
