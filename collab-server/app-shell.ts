import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Extension } from "@hocuspocus/server";

const files = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
  ["/icon-maskable.svg", ["icon-maskable.svg", "image/svg+xml"]]
]);

export function appShell(directory: string, deployment?: string): Extension {
  return {
    async onRequest({ request, response }) {
      const pathname = request.url?.split("?", 1)[0] ?? "";
      const file = files.get(pathname);
      if (!file || (request.method !== "GET" && request.method !== "HEAD")) return;
      const [name, type] = file;
      const body = await readFile(join(directory, name)).catch(() => null);
      if (body === null) {
        response.writeHead(503);
        response.end();
      } else {
        response.writeHead(200, {
          "Content-Type": type,
          "Content-Length": body.byteLength,
          "Cache-Control": "no-cache",
          ...(name === "index.html" && deployment !== undefined ? { "Splitpage-Deployment": deployment } : {}),
          "X-Content-Type-Options": "nosniff"
        });
        response.end(request.method === "HEAD" ? undefined : body);
      }
      return Promise.reject();
    }
  };
}

export function deploymentRequest(request: IncomingMessage, response: ServerResponse, deployment: string | undefined, origins: ReadonlySet<string>): boolean {
  if (request.url !== "/api/deployment" || request.method !== "HEAD") return false;
  const origin = request.headers.origin;
  const allowed = origin && origins.has(origin);
  response.writeHead(deployment ? 200 : 404, {
    "Cache-Control": "no-store",
    Vary: "Origin",
    ...(allowed && { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Splitpage-Deployment" }),
    ...(deployment && { "Splitpage-Deployment": deployment })
  }).end();
  return true;
}
