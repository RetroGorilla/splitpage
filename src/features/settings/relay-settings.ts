import type { RelayOwnerControls } from "../../../shared/desktop-contract.d.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

export function createRelaySettings(controls: RelayOwnerControls, render: () => void) {
  let address: string | null = null;
  let busy = false;
  let message = "";

  async function refresh() {
    address = (await controls.status()).address;
  }

  async function run(action: "refresh" | "setup" | "test" | "clear") {
    if (busy || (action === "test" && !address)) return;
    busy = true;
    if (action !== "refresh") message = "";
    render();
    try {
      switch (action) {
        case "refresh":
          await refresh();
          break;
        case "setup":
          if (!await controls.open()) message = "Could not open relay setup. Try again.";
          await refresh();
          break;
        case "test":
          message = {
            connected: "Connected to the relay.",
            "wrong-secret": "The relay rejected the management secret. Check it in relay setup.",
            unreachable: "Could not connect to the relay. Check the address and that the relay is running.",
            "not-configured": "Set up a relay before testing the connection."
          }[await controls.testConnection()];
          await refresh();
          break;
        case "clear":
          message = await controls.clear() ? "Relay setup cleared." : "Could not clear the relay setup. Try again.";
          await refresh();
          break;
      }
    } catch {
      message = "Could not read the relay settings. Try again.";
    } finally {
      busy = false;
      render();
    }
  }

  function body() {
    const pending = busy ? ' aria-disabled="true"' : "";
    const needsAddress = address ? pending : " disabled";
    return '<p class="settings-hint" id="settings-collaboration-address">' +
      (address ? "Relay configured — " + escapeHtml(address) : "No relay configured.") + '</p>' +
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" id="settings-relay-setup" data-settings-action="relay-setup"' + pending + '>Set up relay…</button>' +
        '<button type="button" class="btn-outline" id="settings-relay-test" data-settings-action="relay-test"' + needsAddress + '>Test connection</button>' +
        '<button type="button" class="btn-outline" id="settings-relay-clear" data-settings-action="relay-clear"' + pending + '>Clear</button>' +
      '</div><p class="settings-hint" role="status">' + escapeHtml(message) + '</p>';
  }

  return { body, run };
}
