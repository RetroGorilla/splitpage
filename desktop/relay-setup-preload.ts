"use strict";

import type { DesktopIpcArgs, DesktopIpcResult } from "../shared/desktop-contract.d.ts";

declare const SPLITPAGE_COLLAB_UI: boolean;

if (SPLITPAGE_COLLAB_UI && location.origin === "splitpage://relay-setup" && location.pathname === "/index.html") {
  const { ipcRenderer }: {
    ipcRenderer: { invoke: (name: "splitpage:relay-setup-save", ...args: DesktopIpcArgs<"splitpage:relay-setup-save">) => Promise<DesktopIpcResult<"splitpage:relay-setup-save">> };
  } = require("electron");
  window.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector("form");
    const address = document.querySelector<HTMLInputElement>("#relay-address");
    const secret = document.querySelector<HTMLInputElement>("#relay-secret");
    const save = document.querySelector<HTMLButtonElement>("#save");
    const feedback = document.querySelector("#feedback");
    if (!form || !address || !secret || !save || !feedback) return;
    const close = () => { secret.value = ""; window.close(); };
    document.querySelector("#cancel")?.addEventListener("click", close);
    document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      feedback.textContent = "";
      try {
        const result = await ipcRenderer.invoke("splitpage:relay-setup-save", address.value, secret.value);
        if (result === "saved") { close(); return; }
        feedback.textContent = {
          "invalid-address": "Enter an HTTPS relay address. HTTP is available for loopback addresses.",
          "invalid-secret": "Check the management secret for unsupported characters or extra spaces.",
          "key-store-unavailable": "Could not access the operating system key store.",
          "save-failed": "Could not save the relay settings. Check that Splitpage can write to this device."
        }[result];
      } catch {
        feedback.textContent = "Could not save the relay settings. Close this window and try again.";
      } finally {
        save.disabled = false;
      }
    });
  }, { once: true });
}
