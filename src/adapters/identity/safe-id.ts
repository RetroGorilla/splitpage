import { safeId as safeIdFrom } from "../../core/document/text-policy.ts";
import { randomIds } from "./ids.ts";

export function safeId(id: unknown, prefix: string): string { return safeIdFrom(id, prefix, randomIds); }
