export type ImageInstanceConfiguration = { readonly instance: string; readonly token: string };

export function imageControl(instance: string, kind: number, fields: readonly (string | number)[] = []): Uint8Array {
  const bytes: number[] = [];
  const uint = (value: number): void => {
    while (value > 127) { bytes.push(value & 127 | 128); value = Math.floor(value / 128); }
    bytes.push(value);
  };
  const string = (value: string): void => {
    const encoded = new TextEncoder().encode(value);
    uint(encoded.byteLength);
    bytes.push(...encoded);
  };
  string(instance);
  uint(kind);
  for (const value of fields) if (typeof value === "string") string(value); else uint(value);
  return Uint8Array.from(bytes);
}
