import type { TestContext } from "node:test";
import { IDBObjectStore } from "fake-indexeddb";

export function eventResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

export function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export function idbDone(transaction: IDBTransaction): Promise<string> {
  return new Promise(resolve => {
    transaction.addEventListener("complete", () => resolve("complete"));
    transaction.addEventListener("abort", () => resolve(transaction.error?.name ?? "AbortError"));
  });
}

export function failNextIdbWrite(t: TestContext, method: "add" | "put", reason: "abort" | "quota") {
  const original = IDBObjectStore.prototype[method];
  const mock = t.mock.method(IDBObjectStore.prototype, method, function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    mock.mock.restore();
    const request = original.call(this, value, key);
    if (reason === "abort") request.addEventListener("success", () => this.transaction.abort());
    else {
      // why: fake-indexeddb runs real request and transaction events but has no storage quota
      const queue = (this.transaction as unknown as { _requests: { operation: () => unknown }[] })._requests;
      queue.at(-1)!.operation = () => { throw new DOMException("Storage limit reached", "QuotaExceededError"); };
    }
    return request;
  });
}
