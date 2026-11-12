import * as Y from "yjs";

export function visitSharedIdentityStructs(transaction: Y.Transaction, visit: (item: Y.Item, delta: 1 | -1) => void): void {
  const range = (client: number, from: number, to: number, delta: 1 | -1) => {
    const structs = transaction.doc.store.clients.get(client); if (!structs?.length || from >= to) return;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index++) {
      const item = structs[index]; if (!item || item.id.clock >= to) break;
      if (item instanceof Y.Item && (delta === 1 ? !item.deleted : item.id.clock < (transaction.beforeState.get(client) ?? 0))) visit(item, delta);
    }
  };
  for (const [client, end] of transaction.afterState) range(client, transaction.beforeState.get(client) ?? 0, end, 1);
  for (const [client, deleted] of transaction.deleteSet.clients) for (const part of deleted) range(client, part.clock, part.clock + part.len, -1);
}
