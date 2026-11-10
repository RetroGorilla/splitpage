import type { Extension } from "@hocuspocus/server";

export function loadingProbe(emit: (event: string, data: Record<string, unknown>) => void): Extension {
  let changes = 0;
  let stores = 0;
  let flushes = 0;
  const observations: { loading: boolean; connections: number; gc: boolean }[] = [];
  return {
    priority: 1000,
    async onLoadDocument({ document }) {
      const flush = document.flush.bind(document);
      document.flush = () => {
        flushes++;
        observations.push({ loading: document.isLoading, connections: document.getConnectionsCount(), gc: document.gc });
        return flush();
      };
      document.flushMaxBytes = 1;
    },
    async onChange() { changes++; },
    async onStoreDocument() { stores++; },
    async afterLoadDocument({ instance }) {
      instance.flushPendingStores();
      emit("instance-loaded", { changes, stores, flushes, observations });
    },
  };
}
