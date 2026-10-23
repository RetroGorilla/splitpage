export interface DeliverOptions {
  readonly savedMsg?: string;
}

export interface FileDelivery {
  readonly deliver: (filename: string, data: unknown, options?: DeliverOptions | null) => Promise<boolean>;
}
