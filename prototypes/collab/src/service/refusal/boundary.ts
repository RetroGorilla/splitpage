import type { Connection, Extension } from "@hocuspocus/server";
import * as Y from "yjs";

export type RefusalNotice =
  | { rejected: "invalid-update" | "state-too-large" | "access-removed"; permanent: true }
  | { retryAfter: string; permanent: false };

export function refusalBoundary(now: () => number = Date.now, isRevoked: (connection: Connection) => boolean = () => false): Extension {
  const windows = new WeakMap<Connection, { start: number; count: number }>();
  const temporary = new WeakSet<Connection>();
  const tails = new WeakMap<Y.Doc, Promise<void>>();
  const releases = new WeakMap<Connection, () => void>();
  return {
    async beforeSync({ type, payload, connection, document }) {
      if (type !== 1 && type !== 2 || connection.readOnly) return;
      const previous = tails.get(document);
      tails.set(document, new Promise<void>(resolve => { releases.set(connection, resolve); }));
      await previous;
      const refuse = (notice: RefusalNotice): void => {
        connection.readOnly = true;
        if (!notice.permanent) temporary.add(connection);
        connection.sendStateless(JSON.stringify(notice));
      };
      if (isRevoked(connection)) {
        refuse({ rejected: "access-removed", permanent: true });
        return;
      }
      if (payload.byteLength > 2097152) {
        refuse({ rejected: "state-too-large", permanent: true });
        return;
      }
      try { Y.decodeUpdate(payload); }
      catch { refuse({ rejected: "invalid-update", permanent: true }); return; }
      const time = now();
      let window = windows.get(connection);
      if (!window || time - window.start >= 1000) {
        window = { start: time, count: 0 };
        windows.set(connection, window);
      }
      if (type === 2) window.count++;
      if (type === 2 && window.count > 50) {
        refuse({ retryAfter: "rate-window", permanent: false });
        return;
      }
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
        Y.applyUpdate(candidate, payload);
        if (Y.encodeStateAsUpdate(candidate).byteLength > 2097152) {
          refuse({ rejected: "state-too-large", permanent: true });
        }
      } catch { refuse({ rejected: "invalid-update", permanent: true }); }
      finally { candidate.destroy(); }
    },
    async afterHandleMessage({ connection }) {
      if (temporary.delete(connection)) connection.readOnly = false;
      releases.get(connection)?.();
      releases.delete(connection);
    },
  };
}
