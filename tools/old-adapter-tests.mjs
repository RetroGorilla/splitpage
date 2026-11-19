import { loadGraph } from "./dep-report.mjs";

const oldSource = (path) => path.startsWith("src/adapters/collab/") && !path.startsWith("src/adapters/collab/native/");
const oldTest = (path) => path.startsWith("tests/collab/") ||
  path.startsWith("tests/adapters/collab/") && !path.startsWith("tests/adapters/collab/native/");
const support = (path) => /^(tests\/|src\/test\/|src\/bootstrap\/wiring\/(?:ports\/)?shared-)/.test(path);

export const TREE_INVENTORIES = [
  "tests/adapters/collab/formatting-invariant.test.ts",
  "tests/adapters/collab/guarded-subscriptions.test.ts",
  "tests/adapters/collab/operation-families.test.ts",
  "tests/adapters/collab/trial-replica.test.ts",
  "tests/application/commit-time-writers.test.ts"
];

const MIXED_TESTS = [
  "tests/features/empty-script/before.test.ts",
  "tests/features/tags/panel-mount.test.ts",
  "tests/features/tags/production-tags-mount.test.ts"
];

const BOOT_FIXTURES = [
  "src/test/shared-find-replace-app.test.mjs",
  "src/test/shared-hook-app.test.mjs",
  "src/test/shared-hook-measure-app.test.mjs",
  "src/test/shared-hook-peer-app.test.mjs",
  "src/test/shared-hook-routes-app.test.mjs",
  "src/test/shared-writer-app.test.mjs"
];

function reachable(start, next) {
  const visited = new Set(start);
  for (const path of visited) {
    for (const dependency of next(path)) visited.add(dependency);
  }
  return visited;
}

export function oldAdapterFiles(repo) {
  const graph = loadGraph(repo);
  const sources = [...graph.keys()].filter(oldSource);
  const edges = (path) => (graph.get(path)?.edges ?? []).filter(({ kind }) => kind === "file" || kind === "missing");
  const callers = new Map();
  for (const path of graph.keys()) {
    if (!support(path)) continue;
    for (const { target, typeOnly } of edges(path)) {
      if (typeOnly) continue;
      const list = callers.get(target) ?? [];
      list.push(path);
      callers.set(target, list);
    }
  }
  const reachesOldSource = reachable(sources, (path) => callers.get(path) ?? []);
  const isOldTest = (path) => !TREE_INVENTORIES.includes(path) && !MIXED_TESTS.includes(path) && !path.startsWith("tests/adapters/collab/native/") &&
    (oldTest(path) || reachesOldSource.has(path) || BOOT_FIXTURES.includes(path));
  const testDependencies = reachable([...graph.keys()].filter(isOldTest), (path) =>
    edges(path).map(({ target }) => target).filter(support));
  const adapterDependencies = reachable(sources, (path) => edges(path).map(({ target }) => target));
  return { isOldTest, dependencies: new Set([...testDependencies, ...adapterDependencies]) };
}

export function partitionRootTests(entries, isOldTest) {
  return {
    always: entries.map((entry) => ({ ...entry, files: entry.files.filter((path) => !isOldTest(path)) })),
    "old-adapter": entries.map((entry) => ({ ...entry, files: entry.files.filter(isOldTest) }))
  };
}
