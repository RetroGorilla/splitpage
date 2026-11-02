import type { HistoryIdbInspectionAccess } from "./03c-history-idb.ts";
import type { HistoryIndex, HistoryIndexRecord } from "./history-backend-types.ts";
import type { createMemoryHistoryBackend } from "../../../shared/history-store.ts";

type HistoryMemoryInspectionAccess = Parameters<NonNullable<NonNullable<Parameters<typeof createMemoryHistoryBackend>[0]>["extend"]>>[0];

export function historyMemoryInspection(access: HistoryMemoryInspectionAccess) {
  return {
    bodyCount: () => Object.keys(access.bodies).length,
    hasBody: (sha: string) => sha in access.bodies,
    dropBody: (sha: string) => { Reflect.deleteProperty(access.bodies, sha); },
    inspect: () => {
      const bodies: Record<string, string> = {};
      Object.keys(access.bodies).forEach((sha) => { bodies[sha] = access.bodies[sha] as string; });
      return { index: access.clone(Object.assign({}, access.index)), bodies };
    },
    seed: (index: HistoryIndex, bodies: Record<string, string>) => {
      access.index = Object.create(null) as HistoryIndex;
      Object.keys(index || {}).forEach((bucket) => { access.index[bucket] = access.freeze(access.clone(index[bucket] as HistoryIndexRecord)); });
      access.bodies = Object.create(null) as Record<string, string>;
      Object.keys(bodies || {}).forEach((sha) => { access.bodies[sha] = bodies[sha] as string; });
    }
  };
}

export function historyIdbInspection(access: HistoryIdbInspectionAccess) {
  const { enqueue, transaction, runIn, request: idbReq, record: recordOf, row: rowOf } = access;
  const INDEX_STORE = "index", BODY_STORE = "bodies";
  type IdbHistoryRow = Parameters<typeof recordOf>[0];
  function peek<T>(stores: string[], body: (tx: IDBTransaction) => T | PromiseLike<T>) {
    return enqueue(function () {
      return transaction(stores, "readonly").then(function (t) { return runIn(t, body); });
    });
  }

  return {
    bodyCount: function () {
      return peek([BODY_STORE], function (t) { return idbReq(t.objectStore(BODY_STORE).count()); });
    },
    hasBody: function (sha: unknown) {
      return peek([BODY_STORE], function (t) {
        return idbReq(t.objectStore(BODY_STORE).count(String(sha))).then(function (n) { return n > 0; });
      });
    },
    inspect: function () {
      return peek([INDEX_STORE, BODY_STORE], function (t) {
        return Promise.all([idbReq(t.objectStore(INDEX_STORE).getAll()), idbReq(t.objectStore(BODY_STORE).getAll())]).then(function (res) {
          const index: HistoryIndex = {}, bodies: Record<string, string> = {};
          (res[0] as IdbHistoryRow[]).forEach(function (row) { index[row.bucket] = recordOf(row); });
          (res[1] as { sha: string; stateJson: string }[]).forEach(function (row) { bodies[row.sha] = row.stateJson; });
          return { index: index, bodies: bodies };
        });
      });
    },
    dropBody: function (sha: unknown) {
      return enqueue(function () {
        return transaction([BODY_STORE], "readwrite").then(function (t) {
          return runIn(t, function () { return idbReq(t.objectStore(BODY_STORE).delete(String(sha))); });
        });
      });
    },
    seed: function (idx: HistoryIndex, bods: Record<string, string>) {
      return enqueue(function () {
        return transaction([INDEX_STORE, BODY_STORE], "readwrite").then(function (t) {
          return runIn(t, function () {
            const index = t.objectStore(INDEX_STORE), bodies = t.objectStore(BODY_STORE);
            return Promise.all([idbReq(index.clear()), idbReq(bodies.clear())]).then(function () {
              const reqs: Promise<unknown>[] = [];
              Object.keys(idx || {}).forEach(function (b) { reqs.push(idbReq(index.put(rowOf(b, idx[b] as HistoryIndexRecord)))); });
              Object.keys(bods || {}).forEach(function (sha) { reqs.push(idbReq(bodies.put({ sha: sha, stateJson: bods[sha] }))); });
              return Promise.all(reqs);
            });
          });
        });
      });
    }
  };
}
