export function createHistoryTestFaults() {
  const faults: Record<"put" | "commit", { code: string; times: number }[]> = { put: [], commit: [] };
  return {
    before: function (op: "put" | "commit") {
      const q = faults[op];
      if (!q.length) return;
      const f = q[0] as { code: string; times: number };
      if (--f.times <= 0) q.shift();
      if (f.code) {
        const e: Error & { code?: string } = new Error("Injected " + f.code + " fault");
        e.code = f.code;
        throw e;
      }
    },
    controls: {
      failNext: function (op: "put" | "commit", code: string, times?: number) {
        if (!faults[op]) throw new TypeError("failNext: unknown op " + op);
        faults[op].push({ code: code, times: times == null ? 1 : times });
      },
      clearFaults: function () { faults.put = []; faults.commit = []; }
    }
  };
}
