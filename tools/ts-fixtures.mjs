import { join } from "node:path";
import ts from "typescript";
import { REPO } from "./source-scan.mjs";

const key = (p) => p.split("\\").join("/").toLowerCase();

export function compileFixtures(files, { repo = REPO, config = "tsconfig.test.json" } = {}) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(repo, config), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const virtual = new Map(Object.entries(files).map(([p, text]) => [key(join(repo, p)), text]));
  const host = ts.createCompilerHost(parsed.options);
  const fileExists = host.fileExists.bind(host), readFile = host.readFile.bind(host), getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => virtual.has(key(f)) || fileExists(f);
  host.readFile = (f) => (virtual.has(key(f)) ? virtual.get(key(f)) : readFile(f));
  host.getSourceFile = (f, lang, onError, fresh) => (virtual.has(key(f))
    ? ts.createSourceFile(f, virtual.get(key(f)), lang, true)
    : getSourceFile(f, lang, onError, fresh));
  const declarations = parsed.fileNames.filter((f) => f.endsWith(".d.ts"));
  const rootNames = [...declarations, ...Object.keys(files).map((p) => join(repo, p))];
  const program = ts.createProgram({ rootNames, options: parsed.options, host });
  const errorLines = (path) => {
    const sf = program.getSourceFiles().find((s) => key(s.fileName) === key(join(repo, path)));
    return program.getSemanticDiagnostics(sf).concat(program.getSyntacticDiagnostics(sf))
      .map((d) => sf.getLineAndCharacterOfPosition(d.start).line + 1);
  };
  return { program, errorLines };
}
