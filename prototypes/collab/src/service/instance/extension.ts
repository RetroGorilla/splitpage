import type { Extension } from "@hocuspocus/server";
import * as Y from "yjs";
import type { InstanceGateway } from "./gateway.ts";

export function instanceBoundary(
  gateway: InstanceGateway,
  owner: string,
  requiredAssetsDurable: (state: Uint8Array) => Promise<void> = async () => {},
  beforeUpdate: () => Promise<void> = async () => {},
  bodyProgress: () => void = () => {},
): Extension {
  return {
    async beforeSync({ type }) {
      if (type === 1 || type === 2) await beforeUpdate();
    },
    async onAuthenticate({ documentName, token }) {
      await gateway.authorize(documentName, token);
      return {};
    },
    async onLoadDocument({ documentName, document }) {
      const recovered = await gateway.recover(documentName);
      Y.applyUpdate(document, recovered.payload);
    },
    async onRequest({ request, response }) {
      if (request.url !== "/api/instance") return;
      try {
        if (request.method !== "POST" || request.headers.authorization !== `Bearer ${owner}`) throw new Error("Unauthorized");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.byteLength;
          if (size > 3 * 1024 * 1024) throw new Error("Upload too large");
          chunks.push(bytes);
          bodyProgress();
        }
        const data = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        let result: unknown;
        if (data.action === "create") {
          if (typeof data.operation !== "string" || !data.operation || typeof data.invite !== "string" || !data.invite) throw new Error("Missing creation identity");
          const record = await gateway.create(data.operation, owner, data.invite);
          result = { id: record.id, state: record.state };
        } else if (data.action === "upload") {
          const payload = Buffer.from(String(data.payload), "base64");
          await requiredAssetsDurable(payload);
          const record = await gateway.request("upload", { operation: data.operation, owner, payload });
          result = record ? { uploaded: true } : null;
        } else if (data.action === "commit") {
          const record = await gateway.request("commit", { operation: data.operation, owner });
          result = record ? { committed: true } : null;
        } else throw new Error("Unknown management request");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Instance request refused" }));
      }
      throw null;
    },
  };
}
