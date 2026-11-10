export interface LocalTransactionProbe {
  hold: boolean;
  abort: boolean;
  opened: number;
  completed: number;
  aborted: number;
  durability: string[];
  errors: string[];
  held: Promise<void>;
  release: () => void;
  restore: () => void;
}

export function probeTransactions(databaseName: string, hold: boolean, abort = false): LocalTransactionProbe {
  const original = IDBDatabase.prototype.transaction;
  let signal: () => void = () => { throw new Error("Missing transaction probe"); };
  const held = new Promise<void>(resolve => { signal = resolve; });
  const probe: LocalTransactionProbe = {
    hold, abort, opened: 0, completed: 0, aborted: 0, durability: [], errors: [], held,
    release: () => { probe.hold = false; },
    restore: () => { IDBDatabase.prototype.transaction = original; }
  };
  IDBDatabase.prototype.transaction = function (names, mode, options) {
    const transaction = original.call(this, names, mode, options);
    if (this.name !== databaseName || mode !== "readwrite") return transaction;
    probe.opened++;
    probe.durability.push(transaction.durability);
    transaction.addEventListener("complete", () => { probe.completed++; });
    transaction.addEventListener("abort", () => { probe.aborted++; probe.errors.push(transaction.error?.name ?? "AbortError"); signal(); });
    const firstStore = transaction.objectStoreNames[0];
    if (!firstStore) throw new Error("Transaction has no stores");
    const store = transaction.objectStore(firstStore);
    const pump = (): void => {
      const request = store.get("__harness_gate__");
      request.onsuccess = () => {
        signal();
        if (probe.abort) { transaction.abort(); return; }
        if (probe.hold) pump();
      };
    };
    pump();
    return transaction;
  };
  return probe;
}
