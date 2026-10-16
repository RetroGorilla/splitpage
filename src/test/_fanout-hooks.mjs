const STUBBED_PARENTS = /\/src\/js\/(?:01-scene-status|05r-read-time)\.js$/;
const KEPT = new Set(["./_state.js"]);
const STUBS = new URL("./_fanout-stubs.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const parent = context.parentURL || "";
  if (STUBBED_PARENTS.test(parent) && specifier.startsWith("./") && !KEPT.has(specifier)) {
    return { url: STUBS, shortCircuit: true };
  }
  return next(specifier, context);
}
