const STUBBED_PARENTS = /\/src\/js\/(?:01-scene-status|05r-read-time)\.js$/;
const BRIDGES = ["../legacy/effects-bridge.ts", "../legacy/shot-hiding-bridge.ts"];
const STUBS = new URL("./_fanout-stubs.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const parent = context.parentURL || "";
  if (STUBBED_PARENTS.test(parent) && (specifier.startsWith("./") || BRIDGES.includes(specifier))) {
    return { url: STUBS, shortCircuit: true };
  }
  return next(specifier, context);
}
