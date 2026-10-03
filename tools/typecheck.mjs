import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";
import { BRAND_PRODUCER, brandForgeries } from "./brand-casts.mjs";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

export const CONFIGS = ["tsconfig.core.json", "tsconfig.web.json", "tsconfig.test.json"];

const NO_INPUTS = 18003;
const TS_FILE = /\.(?:ts|mts|cts)$/;

const host = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => REPO,
  getNewLine: () => "\n"
};

const format = (diagnostics) => (process.stderr.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics)(diagnostics, host);

function parseConfig(path) {
  const diagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => diagnostics.push(d)
  });
  if (parsed) diagnostics.push(...parsed.errors.filter((d) => d.code !== NO_INPUTS));
  return { parsed, diagnostics };
}

export function typecheck({ repo = REPO, configs = CONFIGS, files = listRepoFiles(repo), print = console.log, printError = console.error } = {}) {
  let failed = false;
  const covered = new Map();
  const forgeries = new Set();
  for (const name of configs) {
    const path = join(repo, name);
    if (!existsSync(path)) { failed = true; printError(`typecheck: ${name} is missing`); continue; }
    const { parsed, diagnostics } = parseConfig(path);
    if (diagnostics.length || !parsed) {
      failed = true;
      printError(format(diagnostics));
      continue;
    }
    const own = parsed.fileNames.filter((f) => TS_FILE.test(f)).map((f) => relative(repo, f).split("\\").join("/"));
    for (const f of own) covered.set(f, [...(covered.get(f) ?? []), name]);
    if (own.length === 0) { print(`typecheck: ${name}: no files yet`); continue; }
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    const errors = ts.getPreEmitDiagnostics(program);
    if (errors.length) {
      failed = true;
      printError(format(errors));
      printError(`typecheck: ${name}: ${errors.length} errors in ${own.length} files`);
    } else {
      print(`typecheck: ${name}: ${own.length} files, no errors`);
    }
    for (const f of brandForgeries(program, repo, new Set(own))) {
      const line = `typecheck: ${f.path}:${f.line}: ${f.what}; only ${BRAND_PRODUCER} produces a validated document`;
      failed = true;
      if (!forgeries.has(line)) { forgeries.add(line); printError(line); }
    }
  }
  for (const f of files.filter((p) => TS_FILE.test(p) && !/(^|\/)node_modules\//.test(p) && !p.endsWith(".d.ts"))) {
    const owners = covered.get(f) ?? [];
    if (owners.length === 0) { failed = true; printError(`typecheck: ${f} is not in any of ${configs.join(", ")}`); }
    if (owners.length > 1) { failed = true; printError(`typecheck: ${f} is in more than one config (${owners.join(", ")})`); }
  }
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = typecheck();
}
