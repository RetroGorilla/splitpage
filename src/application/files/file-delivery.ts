export interface FileDeliveryOptions {
  readonly savedMsg?: string;
}

export interface FileDelivery {
  readonly deliver: (filename: string, data: unknown, options?: FileDeliveryOptions | null) => Promise<boolean>;
}
