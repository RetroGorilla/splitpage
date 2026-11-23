import { resolve } from "node:path";

export class RelayError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new RelayError(`Set ${name}.`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new RelayError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function dataDirectory(env: NodeJS.ProcessEnv): string {
  return resolve(required(env, "SPLITPAGE_DATA_DIR"));
}

export function relayConfig(env: NodeJS.ProcessEnv) {
  const debounce = integer(env, "SPLITPAGE_STORE_DEBOUNCE_MS", 2000, 0, 2_147_483_647);
  const maxDebounce = integer(env, "SPLITPAGE_STORE_MAX_DEBOUNCE_MS", 10000, debounce, 2_147_483_647);
  const origins = required(env, "SPLITPAGE_ALLOWED_ORIGINS").split(",").map(origin => origin.trim());
  if (origins.some(origin => !/^(?:https?|splitpage):\/\/[^\s/?#@*]+$/.test(origin))) {
    throw new RelayError("SPLITPAGE_ALLOWED_ORIGINS must list exact origins.");
  }
  return {
    directory: dataDirectory(env),
    port: integer(env, "SPLITPAGE_PORT", 8080, 0, 65535),
    origins: new Set(origins),
    debounce,
    maxDebounce,
    managementSecret: env.SPLITPAGE_MANAGEMENT_SECRET?.trim() ? env.SPLITPAGE_MANAGEMENT_SECRET : undefined,
    maxConnections: integer(env, "SPLITPAGE_MAX_CONNECTIONS", 64, 1, 10_000),
    maxConnectionsPerInvitation: integer(env, "SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION", 8, 1, 10_000),
    maxMessagesPerSecond: integer(env, "SPLITPAGE_MAX_MESSAGES_PER_SECOND", 60, 1, 10_000),
    maxUploadsInFlight: integer(env, "SPLITPAGE_MAX_UPLOADS_IN_FLIGHT", 4, 1, 100)
  };
}

export function retentionCount(env: NodeJS.ProcessEnv): number {
  return integer(env, "SPLITPAGE_BACKUP_KEEP", 7, 1, Number.MAX_SAFE_INTEGER);
}
