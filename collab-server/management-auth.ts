import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function managementAuthorizer(secret: string | undefined): (request: IncomingMessage) => boolean {
  const expected = secret?.trim() ? digest(`Bearer ${secret}`) : undefined;
  return request => {
    if (!expected) return false;
    return timingSafeEqual(digest(request.headers.authorization ?? ""), expected);
  };
}
