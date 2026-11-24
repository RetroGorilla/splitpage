import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const usage = "Usage: node owner-command.ts <https-origin> scripts | issue <script-id> <owner|guest> <label> | list <script-id> | reset <script-id> | revoke <invitation-id> | delete <script-id>";

export interface OwnerCommandDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly stdout?: (line: string) => void;
}

export async function runOwnerCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: OwnerCommandDeps = {}
): Promise<void> {
  const [host, command, ...rest] = argv;
  const secret = env.SPLITPAGE_MANAGEMENT_SECRET;
  if (!secret?.trim()) throw new Error("Set SPLITPAGE_MANAGEMENT_SECRET through the owner secret store.");
  const origin = URL.parse(host ?? "");
  if (!origin || origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new Error(usage);

  const validId = (value: string | undefined): value is string => Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
  let path: string;
  let method: string;
  let body: string | null = null;
  let scriptId = "";
  let issuedRole: "owner" | "guest" | undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };

  if (command === "scripts") {
    if (rest.length !== 0) throw new Error(usage);
    path = "/api/scripts";
    method = "GET";
  } else if (command === "issue") {
    const [id, role, label, ...extra] = rest;
    if (!validId(id) || (role !== "owner" && role !== "guest") || !label?.trim() || extra.length) throw new Error(usage);
    scriptId = id;
    issuedRole = role;
    path = `/api/scripts/${id}/invitations`;
    method = "POST";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ role, label: label.trim() });
  } else if (command === "list" || command === "reset" || command === "revoke" || command === "delete") {
    const [id, ...extra] = rest;
    if (!validId(id) || extra.length) throw new Error(usage);
    scriptId = id;
    if (command === "list") {
      path = `/api/scripts/${id}/invitations`;
      method = "GET";
    } else if (command === "reset") {
      path = `/api/scripts/${id}/reset`;
      method = "POST";
    } else if (command === "revoke") {
      path = `/api/invitations/${id}`;
      method = "DELETE";
    } else {
      path = `/api/scripts/${id}`;
      method = "DELETE";
    }
  } else {
    throw new Error(usage);
  }

  const send = deps.fetch ?? globalThis.fetch;
  const print = deps.stdout ?? (line => { console.log(line); });
  const reply = await send(new URL(path, origin), {
    method, body, headers,
    redirect: "error", signal: AbortSignal.timeout(30_000)
  }).catch(() => { throw new Error("Could not contact the relay."); });
  if (!reply.ok) throw new Error(`Relay refused the command (HTTP ${reply.status}).`);

  if (command === "issue" || command === "reset") {
    const result: unknown = await reply.json().catch(() => null);
    if (!result || typeof result !== "object" ||
        !("id" in result) || typeof result.id !== "string" || !result.id ||
        !("token" in result) || typeof result.token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(result.token) ||
        !("role" in result) || (result.role !== "owner" && result.role !== "guest")) {
      throw new Error("Relay did not return an invitation token.");
    }
    const expectedRole = command === "reset" ? "guest" : issuedRole;
    if (result.role !== expectedRole) throw new Error("Relay returned an unexpected invitation role.");
    if (result.role === "owner") {
      print(JSON.stringify({ id: result.id, role: result.role, token: result.token }, null, 2));
    } else {
      const link = new URL("/", origin);
      link.searchParams.set("join", scriptId);
      link.hash = result.token;
      print(link.href);
    }
  } else if (command === "list" || command === "scripts") {
    const result: unknown = await reply.json().catch(() => null);
    if (!Array.isArray(result)) {
      throw new Error(command === "scripts" ? "Relay did not return a script list." : "Relay did not return an invitation list.");
    }
    print(JSON.stringify(result, null, 2));
  }
}

function isEntrypoint(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  await runOwnerCommand(process.argv.slice(2), process.env).catch(error => {
    console.error(error instanceof Error ? error.message : "Owner command failed.");
    process.exitCode = 1;
  });
}
