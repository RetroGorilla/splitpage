import { registerHooks } from "node:module";
import { bootApp as boot, closeApp, rewireApp } from "./_app-boot.mjs";

const app = new URL("../bootstrap/app.ts", import.meta.url).href;
const fixture = new URL("../../tests/collab/legacy-app/shared-test.ts", import.meta.url).href;

export async function bootApp(...args) {
  // why: the legacy tests assert the actual app stop and restart order
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === app && specifier === "./wiring/shared-test.ts") return next(fixture, context);
      return next(specifier, context);
    }
  });
  try { return await boot(...args); } finally { hook.deregister(); }
}

export { closeApp, rewireApp };
