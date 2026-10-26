export interface PinDialogRequest {
  readonly reason: string;
}

export type OpenPinDialog = (request: PinDialogRequest) => void;

let open: OpenPinDialog | null = null;

export function handPinDialogTo(next: OpenPinDialog | null): void {
  open = next;
}

export function openPinDialog(request: PinDialogRequest): void {
  open?.(request);
}
