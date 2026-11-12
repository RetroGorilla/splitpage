export function expectedStructureIdentity(writer: string, operation: string, role: string, slot = 0): string {
  const encoded = [...new TextEncoder().encode(operation)].map(unit => unit.toString(16).padStart(4, "0")).join("");
  return ["structure", writer, encoded, role, String(slot)].join("_");
}
