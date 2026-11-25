import { LINK_PASSWORD_MAX, validLinkPassword } from "../../../shared/link-password.ts";
import { mountCollaborationDialog } from "./dialog.ts";

export function passwordFailure(reason: string): string {
  if (reason === "wrong-password") return "The password is incorrect. Try again.";
  if (reason === "password-rate-limited") return "Too many password attempts. Wait a minute and try again.";
  if (reason === "access-removed") return "This link has been reset or revoked. Ask the owner for a new link.";
  if (reason === "relay-unreachable") return "Could not reach the relay. Check your connection and try again.";
  return "Could not save the new access on this device. Check your storage and try again.";
}

export function mountPasswordDialog(options: {
  readonly title: string;
  readonly submit: string;
  readonly save: (password: string, signal: AbortSignal) => Promise<string | null>;
  readonly check?: (signal: AbortSignal) => Promise<string | null>;
  readonly remove?: () => Promise<string | null>;
}) {
  const dialog = mountCollaborationDialog("link-password-modal", `
    <form class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="link-password-title" tabindex="-1">
      <div class="modal-header"><h2 id="link-password-title">${options.title}</h2></div>
      <label class="modal-hint">Link password
        <input type="password" maxlength="${LINK_PASSWORD_MAX}" autocomplete="${options.check ? "current-password" : "new-password"}">
      </label>
      <p class="modal-hint" role="status"></p>
      <div class="modal-footer">
        <button type="button" class="btn" data-dialog-cancel>Cancel</button>
        <div class="modal-footer-actions">
          <button type="button" class="btn" data-remove-password hidden>Remove password</button>
          <button type="submit" class="btn btn-accent">${options.submit}</button>
        </div>
      </div>
    </form>`);
  const { part, signal, dispose } = dialog;
  const field = part("input") as HTMLInputElement;
  const cancel = part("[data-dialog-cancel]") as HTMLButtonElement;
  const remove = part("[data-remove-password]") as HTMLButtonElement;
  const submit = part("[type=submit]") as HTMLButtonElement;
  const form = part("form") as HTMLFormElement;
  const status = part("[role=status]");
  const check = options.check;
  const checking = check !== undefined;
  remove.hidden = !options.remove;
  cancel.onclick = dispose;
  signal.addEventListener("abort", () => { field.value = ""; }, { once: true });

  async function run(work: () => Promise<string | null>): Promise<void> {
    field.value = "";
    field.disabled = submit.disabled = remove.disabled = true;
    cancel.disabled = !checking;
    status.textContent = checking ? "Checking access…" : "Saving password settings…";
    (checking ? cancel : form).focus();
    const reason = await work().catch(() => "failed");
    if (signal.aborted) return;
    if (reason === null) { dispose(); return; }
    cancel.disabled = false;
    const unavailable = reason === "access-removed";
    field.disabled = submit.disabled = unavailable;
    remove.disabled = false;
    status.textContent = reason === "password-required" ? "" : checking ? passwordFailure(reason)
      : "Could not change the link password. Check the relay connection and try again.";
    (unavailable ? cancel : field).focus();
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) return;
    const value = field.value;
    if (!validLinkPassword(value)) {
      status.textContent = "Enter a link password.";
      field.focus();
      return;
    }
    void run(() => options.save(value, signal));
  };
  remove.onclick = () => { if (options.remove && !remove.disabled) void run(options.remove); };
  if (check) void run(() => check(signal));
  else field.focus();
  return dialog;
}
