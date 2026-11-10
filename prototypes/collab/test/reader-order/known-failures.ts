export interface ReaderComparisonFinding {
  phase: string;
  replica: string;
  kind: "output" | "throw";
  paths: string[];
  message: string;
}

export const legacyReaderFailures = [
  { id: "removal-attribution", field: /^recovery\.\d+\.by$/, error: null },
  { id: "removal-observed-identities", field: /^recovery\.\d+\.edited(?:\.|$)/, error: null },
  { id: "removal-split-attribution", field: /^recovery\.\d+\.splitBy$/, error: null },
  { id: "visual-component-order", field: /^(?:rows\.\d+|recovery\.\d+\.row)\.(?:visuals|visualText)(?:\.|$)/, error: null },
  { id: "reply-collation", field: /^records\.(?:recoveryReplies|comments\.[^.]+\.replies)(?:\.|$)/, error: null },
  { id: "join-target-removed-or-moved", field: null, error: "Structural join target unavailable" },
  { id: "earlier-join-target-removed-or-moved", field: null, error: "Probe requires an earlier live join target" }
] as const;

export const knownReaderFailures: readonly { id: string; field: RegExp | null; error: string | null }[] = [];

export function classifyReaderFinding(finding: ReaderComparisonFinding): string[] {
  if (finding.kind === "throw") return knownReaderFailures.filter(row => row.error === finding.message).map(row => row.id);
  if (!finding.paths.length || finding.paths.some(path => !knownReaderFailures.some(row => row.field?.test(path)))) return [];
  return knownReaderFailures.filter(row => finding.paths.some(path => row.field?.test(path))).map(row => row.id);
}

export function classifyLegacyFinding(finding: ReaderComparisonFinding): string[] {
  if (finding.kind === "throw") return legacyReaderFailures.filter(row => row.error === finding.message).map(row => row.id);
  if (!finding.paths.length || finding.paths.some(path => !legacyReaderFailures.some(row => row.field?.test(path)))) return [];
  return legacyReaderFailures.filter(row => finding.paths.some(path => row.field?.test(path))).map(row => row.id);
}
