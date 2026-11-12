import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = "src";
const DOCUMENT = "core/document/validated.ts";
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

export interface WriterScanRules {
  readonly owners: readonly string[];
  readonly fields: readonly string[];
  readonly assigned: readonly string[];
  readonly collections: readonly string[];
  readonly engines: readonly string[];
}

export type WriterSites = Record<string, string>;

export interface WriterInventory {
  readonly steps: Record<string, readonly string[]>;
  readonly fields: WriterSites;
  readonly records: WriterSites;
  readonly engines: WriterSites;
  readonly computed: WriterSites;
  readonly missingEngines: readonly string[];
  readonly modules: number;
}

function modulesUnder(path: string): string[] {
  return readdirSync(join(REPO, path), { withFileTypes: true }).flatMap(entry => {
    const inner = path + "/" + entry.name;
    if (entry.isDirectory()) return inner === SOURCE + "/test" ? [] : modulesUnder(inner);
    return /\.(?:ts|js|mjs)$/.test(entry.name) && !/\.(?:test|d)\.(?:ts|js|mjs)$/.test(entry.name) ? [inner] : [];
  });
}

function tally(into: Map<string, Map<string, number>>, site: string, name: string): void {
  const at = into.get(site) ?? new Map<string, number>();
  at.set(name, (at.get(name) ?? 0) + 1);
  into.set(site, at);
}

function written(found: Map<string, Map<string, number>>): WriterSites {
  return Object.fromEntries([...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([site, names]) => {
    return [site, [...names].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, count]) => name + " " + count).join(", ")];
  }));
}

export function commitWriterInventory(rules: WriterScanRules, probes?: Readonly<Record<string, string>>): WriterInventory {
  const paths = probes ? Object.keys(probes).sort() : modulesUnder(SOURCE).sort().map(path => path.slice(SOURCE.length + 1));
  const absolute = (path: string): string => join(REPO, SOURCE, path);
  const canonical = (path: string): string => ts.sys.useCaseSensitiveFileNames ? path.split("\\").join("/") : path.split("\\").join("/").toLowerCase();
  const root = canonical(join(REPO, SOURCE)) + "/";
  const overrides = new Map(Object.entries(probes ?? {}).map(([path, source]) => [canonical(absolute(path)), source]));
  const options: ts.CompilerOptions = {
    allowJs: true, noEmit: true, strict: true, skipLibCheck: true, types: [], resolveJsonModule: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = path => overrides.get(canonical(path)) ?? read(path);
  host.fileExists = path => overrides.has(canonical(path)) || exists(path);
  const engineModules = rules.engines.map(engine => engine.slice(0, engine.indexOf("#")));
  const roots = [...new Set([...paths, DOCUMENT, ...engineModules])];
  const program = ts.createProgram(roots.map(absolute), options, host);
  const checker = program.getTypeChecker();

  const contract = program.getSourceFile(absolute(DOCUMENT));
  const alias = contract?.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "ValidatedDocument");
  if (!alias) throw new Error("The document contract was not loaded");
  const validated = checker.getTypeAtLocation(alias);
  const elements = new Map<ts.Type, string>();
  for (const collection of rules.collections) {
    const member = checker.getPropertyOfType(validated, collection);
    const element = member && checker.getIndexTypeOfType(checker.getTypeOfSymbolAtLocation(member, alias), ts.IndexKind.Number);
    if (!element) throw new Error("The document holds no collection named " + collection);
    elements.set(checker.getNonNullableType(element), collection);
  }
  const rowsMember = checker.getPropertyOfType(validated, "rows");
  const rowType = rowsMember && checker.getIndexTypeOfType(checker.getTypeOfSymbolAtLocation(rowsMember, alias), ts.IndexKind.Number);
  if (!rowType) throw new Error("The document holds no rows");
  const fields = new Set(rules.fields);
  const placement = new Set(rules.assigned);
  const collections = new Set(rules.collections);
  const owners = new Set(rules.owners);
  const engines = new Set(rules.engines);

  function relativeOf(file: ts.SourceFile): string | null {
    const path = canonical(file.fileName);
    return path.startsWith(root) ? path.slice(root.length) : null;
  }
  const cased = new Map(roots.map(path => [canonical(path), path]));
  function declared(symbol: ts.Symbol | undefined): string | null {
    if (!symbol) return null;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const origin of [target, ...checker.getRootSymbols(target)]) {
      for (const declaration of origin.declarations ?? []) {
        const file = relativeOf(declaration.getSourceFile());
        if (file === null) continue;
        const name = ts.getNameOfDeclaration(declaration);
        if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) continue;
        const holder = declaration.parent;
        const owner = ts.isInterfaceDeclaration(holder) ? holder.name.text
          : ts.isTypeLiteralNode(holder) && ts.isTypeAliasDeclaration(holder.parent) ? holder.parent.name.text : null;
        const key = (cased.get(file) ?? file) + "#" + (owner ? owner + "." : "") + name.text;
        if (engines.has(key)) return key;
      }
    }
    return null;
  }
  function finiteKeys(type: ts.Type, seen = new Set<ts.Type>()): readonly string[] | null {
    if (type.isStringLiteral()) return [type.value];
    if (seen.has(type)) return null;
    seen.add(type);
    if (type.isUnion()) {
      const keys: string[] = [];
      for (const part of type.types) {
        const found = finiteKeys(part, new Set(seen));
        if (found === null) return null;
        keys.push(...found);
      }
      return [...new Set(keys)];
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? finiteKeys(constraint, seen) : null;
  }
  function numeric(type: ts.Type): boolean {
    return type.isUnion() ? type.types.every(numeric) : (type.flags & ts.TypeFlags.NumberLike) !== 0;
  }
  function keysOf(node: ts.Expression): readonly string[] | "computed" | "index" | null {
    if (ts.isPropertyAccessExpression(node)) return [node.name.text];
    if (!ts.isElementAccessExpression(node)) return null;
    const type = checker.getTypeAtLocation(node.argumentExpression);
    if (numeric(type)) return "index";
    return finiteKeys(type) ?? "computed";
  }
  function bare(node: ts.Expression): ts.Expression {
    let inner = node;
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner)) inner = inner.expression;
    return inner;
  }
  function parts(type: ts.Type): readonly ts.Type[] {
    const plain = checker.getNonNullableType(type);
    return plain.isUnion() ? plain.types : [plain];
  }
  function holdsDocument(type: ts.Type): boolean {
    return parts(type).some(part => part === validated);
  }
  function recordOf(type: ts.Type): string | null {
    for (const part of parts(type)) {
      const found = elements.get(part);
      if (found) return found;
    }
    return null;
  }
  function collectionOf(node: ts.Expression): string | null {
    const inner = bare(node);
    const keys = keysOf(inner);
    if (keys !== null && typeof keys !== "string") {
      const named = keys.find(key => collections.has(key));
      if (named) return named;
    }
    for (const part of parts(checker.getTypeAtLocation(inner))) {
      const element = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      const found = element && elements.get(checker.getNonNullableType(element));
      if (found) return found;
    }
    return null;
  }
  function topLevel(node: ts.Node): string {
    let at = node;
    while (!ts.isSourceFile(at.parent)) at = at.parent;
    if ((ts.isFunctionDeclaration(at) || ts.isClassDeclaration(at)) && at.name) return at.name.text;
    if (ts.isVariableStatement(at)) {
      const first = at.declarationList.declarations[0];
      if (first && ts.isIdentifier(first.name)) return first.name.text;
    }
    return "<module>";
  }
  function nearest(node: ts.Node): string {
    for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      if (ts.isMethodDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
      if ((ts.isFunctionExpression(at) || ts.isArrowFunction(at)) && (ts.isVariableDeclaration(at.parent) || ts.isPropertyAssignment(at.parent)) && ts.isIdentifier(at.parent.name)) return at.parent.name.text;
    }
    return "<module>";
  }
  function assignmentOperator(kind: ts.SyntaxKind): boolean {
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  }

  const steps = new Map<string, string[]>();
  const fieldWrites = new Map<string, Map<string, number>>();
  const recordWrites = new Map<string, Map<string, number>>();
  const engineUses = new Map<string, Map<string, number>>();
  const computed = new Map<string, Map<string, number>>();

  for (const path of paths) {
    const source = program.getSourceFile(absolute(path));
    if (!source) throw new Error("Writer scan module was not loaded: " + path);
    const site = (node: ts.Node): string => path + "#" + topLevel(node);
    function target(node: ts.Expression): void {
      const left = bare(node);
      const keys = keysOf(left);
      if (keys === null || !(ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) return;
      if (keys === "index") {
        const held = collectionOf(left.expression);
        if (held) tally(recordWrites, site(node), held);
        return;
      }
      if (keys === "computed") {
        const receiver = checker.getTypeAtLocation(left.expression);
        const kind = holdsDocument(receiver) ? "document" : parts(receiver).some(part => part === rowType) ? "rows" : recordOf(receiver);
        if (kind) tally(computed, site(node), kind);
        return;
      }
      for (const key of keys) {
        if (fields.has(key) || placement.has(key)) tally(fieldWrites, site(node), key);
        if (collections.has(key)) tally(recordWrites, site(node), key);
      }
      if (keys.includes("length")) {
        const held = collectionOf(left.expression);
        if (held) tally(recordWrites, site(node), held);
      }
    }
    function step(node: ts.CallExpression): void {
      const callee = bare(node.expression);
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      const origin = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const local = origin?.declarations?.some(declaration => declaration.getSourceFile() === source && ts.isFunctionDeclaration(declaration));
      const library = origin?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
      if (local || library) return;
      const signature = checker.getResolvedSignature(node);
      if (!signature) return;
      const takes = signature.getParameters().some(parameter => holdsDocument(checker.getTypeOfSymbolAtLocation(parameter, node)));
      const gives = holdsDocument(checker.getReturnTypeOfSignature(signature));
      if (!takes && !gives && !declared(symbol)) return;
      const key = path + "#" + nearest(node);
      steps.set(key, [...(steps.get(key) ?? []), node.expression.getText(source) + (takes || !gives ? "" : " ->")]);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) target(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
      if (ts.isDeleteExpression(node)) target(node.expression);
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
          const name = property.name;
          const keys = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? [name.text]
            : ts.isComputedPropertyName(name) ? finiteKeys(checker.getTypeAtLocation(name.expression)) ?? [] : [];
          const flag = ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
          for (const key of flag ? [] : keys) if (fields.has(key)) tally(fieldWrites, site(node), key);
          const contextual = checker.getContextualType(node);
          if (!contextual) continue;
          const wanted = checker.getNonNullableType(contextual);
          for (const key of keys) {
            const engine = (wanted.isUnion() ? wanted.types : [wanted])
              .map(part => declared(checker.getPropertyOfType(part, key))).find(found => found !== null);
            if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1) + " (provided)");
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = bare(node.expression);
        if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
          const held = collectionOf(callee.expression);
          if (held) tally(recordWrites, site(node), held);
        }
        if (owners.has(path)) step(node);
      }
      if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent) && !ts.isImportClause(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        const naming = symbol?.declarations?.some(declaration => ts.getNameOfDeclaration(declaration) === node);
        const engine = naming ? null : declared(symbol);
        if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const missingEngines = rules.engines.filter(engine => {
    const [file, name] = engine.split("#");
    const [holder, member] = (name ?? "").split(".");
    const statement = program.getSourceFile(absolute(file ?? ""))?.statements.find(node => {
      return (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === holder;
    });
    if (!statement) return true;
    if (member === undefined) return !ts.isFunctionDeclaration(statement);
    return !(ts.isInterfaceDeclaration(statement) && statement.members.some(node => node.name && ts.isIdentifier(node.name) && node.name.text === member));
  });
  return {
    steps: Object.fromEntries([...steps].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    fields: written(fieldWrites),
    records: written(recordWrites),
    engines: written(engineUses),
    computed: written(computed),
    missingEngines: missingEngines,
    modules: paths.length
  };
}
