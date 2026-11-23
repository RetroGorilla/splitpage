const usage = "Usage: node owner-command.ts <https-origin> issue <script-id> <label> | list <script-id> | revoke <invitation-id> | delete <script-id>";

async function main(): Promise<void> {
  const [host, command, id, label, ...extra] = process.argv.slice(2);
  const secret = process.env.SPLITPAGE_MANAGEMENT_SECRET;
  if (!secret?.trim()) throw new Error("Set SPLITPAGE_MANAGEMENT_SECRET through the owner secret store.");
  const origin = URL.parse(host ?? "");
  if (!origin || origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      !id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || extra.length ||
      !["issue", "list", "revoke", "delete"].some(value => value === command) ||
      (command === "issue" ? !label?.trim() : label !== undefined)) throw new Error(usage);

  const script = `/api/scripts/${id}`;
  const path = command === "revoke" ? `/api/invitations/${id}` :
    command === "delete" ? script : `${script}/invitations`;
  const method = command === "issue" ? "POST" : command === "list" ? "GET" : "DELETE";
  const reply = await fetch(new URL(path, origin), {
    method, body: label ?? null, headers: { Authorization: `Bearer ${secret}` },
    redirect: "error", signal: AbortSignal.timeout(30_000)
  }).catch(() => { throw new Error("Could not contact the relay."); });
  if (!reply.ok) throw new Error(`Relay refused the command (HTTP ${reply.status}).`);
  if (command === "issue") {
    const result = await reply.json().catch(() => null);
    if (!result || typeof result !== "object" || !("token" in result) ||
        typeof result.token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(result.token)) {
      throw new Error("Relay did not return an invitation token.");
    }
    const link = new URL("/", origin);
    link.searchParams.set("join", id);
    link.hash = result.token;
    console.log(link.href);
  }
  if (command === "list") {
    const result = await reply.json().catch(() => null);
    if (!Array.isArray(result)) throw new Error("Relay did not return an invitation list.");
    console.log(JSON.stringify(result, null, 2));
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : "Owner command failed.");
  process.exitCode = 1;
});
