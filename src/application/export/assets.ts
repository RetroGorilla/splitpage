export type ExportAssetSource = (sha: string) => unknown;

export interface ExportAssetRequest {
  readonly shas: readonly string[];
  readonly source: ExportAssetSource | null;
}

export interface ExportPicture {
  readonly bytes: Uint8Array;
  readonly mime: string | null;
}

export interface ExportAssets {
  readonly picture: (sha: string) => ExportPicture | null;
  readonly shas: readonly string[];
  readonly missing: readonly string[];
}

export interface ExportAssetPorts {
  readonly load: (shas: readonly string[], source: ExportAssetSource | null) => Promise<unknown>;
  readonly bytes: (sha: string) => Uint8Array | null;
  readonly mime: (sha: string, bytes: Uint8Array) => string | null;
}

export function exportAssetRequest(shas: readonly string[], source: ExportAssetSource | null): ExportAssetRequest {
  const seen: Record<string, true> = Object.create(null) as Record<string, true>;
  const list: string[] = [];
  shas.forEach(function (sha) {
    if (typeof sha !== "string" || seen[sha]) return;
    seen[sha] = true;
    list.push(sha);
  });
  return Object.freeze({ shas: Object.freeze(list), source: source });
}

export function heldExportAssets(request: ExportAssetRequest, ports: ExportAssetPorts): ExportAssets {
  const held = new Map<string, ExportPicture>();
  const missing: string[] = [];
  request.shas.forEach(function (sha) {
    const bytes = ports.bytes(sha);
    if (!bytes) {
      missing.push(sha);
      return;
    }
    held.set(sha, Object.freeze({ bytes: bytes, mime: ports.mime(sha, bytes) }));
  });
  return Object.freeze({
    picture: function (sha: string): ExportPicture | null { return held.get(sha) || null; },
    shas: request.shas,
    missing: Object.freeze(missing)
  });
}

export function resolveExportAssets(request: ExportAssetRequest, ports: ExportAssetPorts): Promise<ExportAssets> {
  const loaded = request.shas.length ? ports.load(request.shas, request.source) : Promise.resolve();
  return Promise.resolve(loaded).then(null, function () { return null; }).then(function () {
    return heldExportAssets(request, ports);
  });
}
