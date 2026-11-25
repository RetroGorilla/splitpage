import { LEAVE_SCRIPT_COMMAND } from "./actions.ts";
import { mountCollaborationDialog } from "./dialog.ts";
import type { LeaveDialogPorts } from "./ports.ts";

export function mountLeaveDialog(ports: LeaveDialogPorts) {
  const dialog = mountCollaborationDialog("leave-script-modal", `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="leave-script-title">
      <div class="modal-header"><h2 id="leave-script-title">${LEAVE_SCRIPT_COMMAND.label}</h2></div>
      <p class="modal-hint">Leaving disconnects this device and removes its shared copy. You can save a separate project first.</p>
      <p class="modal-hint" role="status"></p>
      <div class="modal-footer">
        <button type="button" class="btn" data-dialog-cancel>Cancel</button>
        <div class="modal-footer-actions">
          <button type="button" class="btn" data-save-copy>Save a copy first…</button>
          <button type="button" class="btn btn-accent" data-leave-script>Leave shared script</button>
        </div>
      </div>
    </section>`);
  const cancel = dialog.part("[data-dialog-cancel]") as HTMLButtonElement;
  const save = dialog.part("[data-save-copy]") as HTMLButtonElement;
  const leave = dialog.part("[data-leave-script]") as HTMLButtonElement;
  const status = dialog.part("[role=status]");
  const setBusy = (busy: boolean) => { cancel.disabled = save.disabled = leave.disabled = busy; };

  async function finish(saveFirst: boolean) {
    setBusy(true);
    try {
      if (saveFirst) {
        status.textContent = "Saving your copy…";
        if (!await ports.saveCopy()) {
          status.textContent = "Could not save a copy. Try again or leave without saving one.";
          return;
        }
      }
      status.textContent = "Leaving shared script…";
      if (await ports.leave()) dialog.dispose();
      else status.textContent = "Could not remove the shared copy. Try again.";
    } catch {
      status.textContent = "Could not complete the request. Try again.";
    } finally {
      setBusy(false);
      if (!dialog.signal.aborted) (saveFirst ? save : leave).focus();
    }
  }

  cancel.onclick = dialog.dispose;
  save.onclick = () => { void finish(true); };
  leave.onclick = () => { void finish(false); };
  cancel.focus();
  return { signal: dialog.signal, dispose: dialog.dispose };
}
