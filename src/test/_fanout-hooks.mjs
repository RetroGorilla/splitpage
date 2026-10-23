const STUBBED_PARENTS = /\/src\/js\/01-scene-status\.js$/;
const BRIDGE = "../legacy/effects-bridge.ts";
const STUBS = new URL("./_fanout-stubs.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const parent = context.parentURL || "";
  if (STUBBED_PARENTS.test(parent) && (specifier.startsWith("./") || specifier === BRIDGE)) {
    return { url: STUBS, shortCircuit: true };
  }
  return next(specifier, context);
}
