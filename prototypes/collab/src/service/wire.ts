export type ServiceFrame = { name: string; kind: number; subtype: number; payload: Uint8Array };

export function readFrame(bytes: Uint8Array): ServiceFrame {
  if (bytes.length === 1 && (bytes[0] === 9 || bytes[0] === 10)) {
    return { name: "", kind: bytes[0], subtype: -1, payload: new Uint8Array() };
  }
  let offset = 0;
  function uint(): number {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 8; i++) {
      const value = bytes[offset++];
      if (value === undefined) throw new Error("Truncated frame");
      result += (value & 127) * multiplier;
      if (value < 128) return result;
      multiplier *= 128;
    }
    throw new Error("Oversized integer");
  }
  function array(): Uint8Array {
    const length = uint();
    if (length > bytes.length - offset) throw new Error("Truncated payload");
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  }
  const name = new TextDecoder().decode(array());
  const kind = uint();
  if (kind === 0 || kind === 4) {
    const subtype = uint();
    return { name, kind, subtype, payload: array() };
  }
  return { name, kind, subtype: kind === 8 ? uint() : -1, payload: bytes.slice(offset) };
}

export function syncFrame(name: string, subtype: number, payload: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  function uint(value: number): void {
    while (value > 127) {
      bytes.push((value & 127) | 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  }
  const encodedName = new TextEncoder().encode(name);
  uint(encodedName.length);
  bytes.push(...encodedName);
  uint(0);
  uint(subtype);
  uint(payload.length);
  return Uint8Array.from([...bytes, ...payload]);
}
