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
  readonly typed: Readonly<Record<string, readonly string[]>>;
  readonly collections: readonly string[];
  readonly engines: readonly string[];
  readonly projections: readonly string[];
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

type GenericWriter = { readonly targets: readonly number[]; readonly key: number | null };

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
  function elementOf(holder: ts.Type, member: string): ts.Type | null {
    const symbol = checker.getPropertyOfType(checker.getNonNullableType(holder), member);
    const element = symbol && checker.getIndexTypeOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, alias as ts.Node)), ts.IndexKind.Number);
    return element ? checker.getNonNullableType(element) : null;
  }
  const rowType = elementOf(validated, "rows");
  if (!rowType) throw new Error("The document holds no rows");
  const elements = new Map<ts.Type, string>();
  const kinds: [string, ts.Type][] = [["document", validated], ["rows", rowType]];
  for (const collection of rules.collections) {
    const path = collection.split(".");
    let holder: ts.Type | null = validated;
    for (const member of path) holder = holder && elementOf(holder, member);
    const name = path[path.length - 1];
    if (!holder || !name) throw new Error("The document holds no collection named " + collection);
    elements.set(holder, name);
    kinds.push([name, holder]);
  }
  const fields = new Set(rules.fields);
  const placement = new Set(rules.assigned);
  const collections = new Set(rules.collections.map(collection => collection.split(".").pop() ?? collection));
  const owners = new Set(rules.owners);
  const engines = new Set(rules.engines);
  const named = new Map(kinds.map(([kind, type]) => [kind, new Set(checker.getPropertiesOfType(type).map(symbol => symbol.name))]));

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
  function member(type: ts.Type, key: string): string | null {
    for (const part of parts(type)) {
      const engine = declared(checker.getPropertyOfType(part, key));
      if (engine) return engine;
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
  function kindOf(type: ts.Type): string | null {
    const all = parts(type);
    for (const part of all) for (const [kind, watched] of kinds) if (part === watched) return kind;
    for (const part of all) {
      const own = checker.getPropertiesOfType(part);
      if (!own.length || part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;
      const indexed = open(part);
      for (const [kind, watched] of kinds) {
        const names = named.get(kind);
        if (names && (indexed || own.length * 2 >= names.size) && own.every(symbol => names.has(symbol.name)) && checker.isTypeAssignableTo(watched, part)) return indexed ? "open" : kind;
      }
    }
    return null;
  }
  function open(type: ts.Type): boolean {
    return parts(type).some(part => (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || checker.getIndexInfosOfType(part).some(info => (info.keyType.flags & ts.TypeFlags.String) !== 0));
  }
  function collectionOf(node: ts.Expression): string | null {
    const inner = bare(node);
    const keys = keysOf(inner);
    if (keys !== null && typeof keys !== "string") {
      const found = keys.find(key => collections.has(key));
      if (found) return found;
    }
    for (const part of parts(checker.getTypeAtLocation(inner))) {
      const element = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      const found = element && elements.get(checker.getNonNullableType(element));
      if (found) return found;
    }
    return null;
  }
  function watchedName(key: string, kind: string | null): boolean {
    if (fields.has(key) || placement.has(key)) return true;
    if (kind === "open") return Object.values(rules.typed).some(names => names.includes(key));
    return kind !== null && (rules.typed[kind] ?? []).includes(key);
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
  function library(symbol: ts.Symbol | undefined): boolean {
    return !!symbol?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  }
  function objectAssign(node: ts.CallExpression): boolean {
    const callee = bare(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "assign") return false;
    const symbol = checker.getSymbolAtLocation(callee.name);
    return library(symbol) && !!symbol?.declarations?.some(declaration => ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ObjectConstructor");
  }

  const generic = new Map<ts.Node, GenericWriter | null>();
  function genericWriter(declaration: ts.Declaration): GenericWriter | null {
    if (generic.has(declaration)) return generic.get(declaration) ?? null;
    generic.set(declaration, null);
    if (!(ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration))) return null;
    const typeParameters = declaration.typeParameters ?? [];
    if (!typeParameters.length || !declaration.body || relativeOf(declaration.getSourceFile()) === null) return null;
    const names = new Set(typeParameters.map(parameter => parameter.name.text));
    const mentions = (node: ts.Node): boolean => (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && names.has(node.typeName.text)) || !!ts.forEachChild(node, child => mentions(child) || undefined);
    const keyed = new Set(typeParameters.filter(parameter => parameter.constraint && ts.isTypeOperatorNode(parameter.constraint) && parameter.constraint.operator === ts.SyntaxKind.KeyOfKeyword).map(parameter => parameter.name.text));
    const candidates = new Map<ts.Symbol, number>();
    let key: number | null = null;
    declaration.parameters.forEach((parameter, index) => {
      if (!parameter.type || !ts.isIdentifier(parameter.name)) return;
      if (ts.isTypeReferenceNode(parameter.type) && ts.isIdentifier(parameter.type.typeName) && keyed.has(parameter.type.typeName.text)) { key = index; return; }
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (symbol && mentions(parameter.type)) candidates.set(symbol, index);
    });
    const targets = new Set<number>();
    const rootOf = (node: ts.Expression): number | undefined => {
      const inner = bare(node);
      if (!ts.isIdentifier(inner)) return undefined;
      const symbol = checker.getSymbolAtLocation(inner);
      return symbol ? candidates.get(symbol) : undefined;
    };
    const reach = (node: ts.Expression): void => {
      const left = bare(node);
      if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
      const at = rootOf(left.expression);
      if (at !== undefined) targets.add(at);
    };
    const walk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) reach(node.left);
      if (ts.isDeleteExpression(node)) reach(node.expression);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) reach(node.operand);
      if (ts.isCallExpression(node)) {
        const callee = bare(node.expression);
        if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
          const at = rootOf(callee.expression);
          if (at !== undefined) targets.add(at);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(declaration.body);
    const found = targets.size ? { targets: [...targets].sort(), key } : null;
    generic.set(declaration, found);
    return found;
  }

  const steps = new Map<string, string[]>();
  const fieldWrites = new Map<string, Map<string, number>>();
  const recordWrites = new Map<string, Map<string, number>>();
  const engineUses = new Map<string, Map<string, number>>();
  const computed = new Map<string, Map<string, number>>();

  for (const path of paths) {
    const source = program.getSourceFile(absolute(path));
    if (!source) throw new Error("Writer scan module was not loaded: " + path);
    const projection = rules.projections.some(prefix => path.startsWith(prefix));
    const site = (node: ts.Node): string => path + "#" + topLevel(node);
    function nested(receiver: ts.Expression, node: ts.Node): void {
      const inner = bare(receiver);
      const keys = keysOf(inner);
      if (keys === null || typeof keys === "string") return;
      for (const key of keys) if (fields.has(key) || placement.has(key)) tally(fieldWrites, site(node), key);
    }
    function target(node: ts.Expression): void {
      const left = bare(node);
      const keys = keysOf(left);
      if (keys === null || !(ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) return;
      nested(left.expression, node);
      if (keys === "index") {
        const held = collectionOf(left.expression);
        if (held) tally(recordWrites, site(node), held);
        return;
      }
      const kind = kindOf(checker.getTypeAtLocation(bare(left.expression))) ?? kindOf(checker.getTypeAtLocation(left.expression));
      if (keys === "computed") {
        const record = kind ?? (projection ? "open" : null);
        if (record) tally(computed, site(node), record);
        return;
      }
      for (const key of keys) {
        if (watchedName(key, kind)) tally(fieldWrites, site(node), key);
        if (collections.has(key)) tally(recordWrites, site(node), key);
      }
      if (keys.includes("length")) {
        const held = collectionOf(left.expression);
        if (held) tally(recordWrites, site(node), held);
      }
    }
    function merge(from: ts.Expression, kind: string | null, node: ts.Node): void {
      if (ts.isObjectLiteralExpression(bare(from))) return;
      const type = checker.getTypeAtLocation(from);
      if (parts(type).some(part => kinds.some(([, watched]) => part === watched))) return;
      if (open(type)) { if (projection) tally(computed, site(node), "open"); return; }
      if (kind === null) return;
      const names = new Set(parts(type).flatMap(part => checker.getPropertiesOfType(part).map(symbol => symbol.name)));
      for (const key of [...names].sort()) {
        if (watchedName(key, kind)) tally(fieldWrites, site(node), key);
        if (collections.has(key)) tally(recordWrites, site(node), key);
      }
    }
    function literal(node: ts.ObjectLiteralExpression): void {
      const call = node.parent;
      const merged = ts.isCallExpression(call) && objectAssign(call) && call.arguments.indexOf(node) > 0;
      const contextual = checker.getContextualType(node);
      const kind = merged ? kindOf(checker.getTypeAtLocation(call.arguments[0] as ts.Expression)) : contextual ? kindOf(contextual) : null;
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          merge(property.expression, kind, node);
          if (contextual) for (const symbol of checker.getPropertiesOfType(checker.getTypeAtLocation(property.expression))) {
            const engine = member(contextual, symbol.name);
            if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1) + " (provided)");
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
        const name = property.name;
        const keys = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? [name.text]
          : ts.isComputedPropertyName(name) ? finiteKeys(checker.getTypeAtLocation(name.expression)) ?? [] : [];
        const flag = ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
        for (const key of flag ? [] : keys) {
          if (fields.has(key) || ((merged || kind !== null) && watchedName(key, kind))) tally(fieldWrites, site(node), key);
          if ((merged || kind === "document") && collections.has(key)) tally(recordWrites, site(node), key);
        }
        if (!contextual) continue;
        for (const key of keys) {
          const engine = member(contextual, key);
          if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1) + " (provided)");
        }
      }
    }
    function implemented(node: ts.ClassLikeDeclaration): void {
      const contracts = (node.heritageClauses ?? []).filter(clause => clause.token === ts.SyntaxKind.ImplementsKeyword)
        .flatMap(clause => clause.types.map(type => checker.getTypeAtLocation(type)));
      for (const element of node.members) {
        const name = element.name;
        if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) continue;
        for (const contract of contracts) {
          const engine = member(contract, name.text);
          if (engine) tally(engineUses, site(element), engine.slice(engine.indexOf("#") + 1) + " (provided)");
        }
      }
    }
    function genericCall(node: ts.CallExpression): void {
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(bare(node.expression)) ? (bare(node.expression) as ts.PropertyAccessExpression).name : bare(node.expression));
      const origin = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of origin?.declarations ?? []) {
        const writer = genericWriter(declaration);
        if (!writer) continue;
        const keyArgument = writer.key === null ? undefined : node.arguments[writer.key];
        const keys = keyArgument ? finiteKeys(checker.getTypeAtLocation(keyArgument)) : null;
        for (const index of writer.targets) {
          const argument = node.arguments[index];
          if (!argument) continue;
          const held = collectionOf(argument);
          if (held) { tally(recordWrites, site(node), held); continue; }
          const kind = kindOf(checker.getTypeAtLocation(argument));
          const watched = (keys ?? []).filter(key => watchedName(key, kind));
          for (const key of watched) tally(fieldWrites, site(node), key);
          if (!watched.length && kind) tally(computed, site(node), kind);
        }
        return;
      }
    }
    function step(node: ts.CallExpression): void {
      const callee = bare(node.expression);
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      const origin = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const local = origin?.declarations?.some(declaration => declaration.getSourceFile() === source && ts.isFunctionDeclaration(declaration));
      if (local || library(origin)) return;
      const signature = checker.getResolvedSignature(node);
      if (!signature) return;
      const takes = signature.getParameters().some(parameter => parts(checker.getTypeOfSymbolAtLocation(parameter, node)).includes(validated));
      const gives = parts(checker.getReturnTypeOfSignature(signature)).includes(validated);
      if (!takes && !gives && !declared(symbol)) return;
      const key = path + "#" + nearest(node);
      steps.set(key, [...(steps.get(key) ?? []), node.expression.getText(source) + (takes || !gives ? "" : " ->")]);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) target(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
      if (ts.isDeleteExpression(node)) target(node.expression);
      if (ts.isObjectLiteralExpression(node)) literal(node);
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) implemented(node);
      if (ts.isCallExpression(node)) {
        const callee = bare(node.expression);
        if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
          const held = collectionOf(callee.expression);
          if (held) tally(recordWrites, site(node), held);
        }
        if (objectAssign(node)) {
          const into = node.arguments[0];
          const kind = into ? kindOf(checker.getTypeAtLocation(into)) : null;
          for (const from of node.arguments.slice(1)) merge(from, kind, node);
        } else genericCall(node);
        if (owners.has(path)) step(node);
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
          const engine = member(checker.getTypeAtLocation(node.parent), name.text);
          if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1));
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const keys = finiteKeys(checker.getTypeAtLocation(node.argumentExpression));
        for (const key of keys ?? []) {
          const engine = member(checker.getTypeAtLocation(node.expression), key);
          if (engine) tally(engineUses, site(node), engine.slice(engine.indexOf("#") + 1));
        }
      }
      if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent) && !ts.isImportClause(node.parent) && !ts.isBindingElement(node.parent)) {
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
    const [holder, field] = (name ?? "").split(".");
    const statement = program.getSourceFile(absolute(file ?? ""))?.statements.find(node => {
      return (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === holder;
    });
    if (!statement) return true;
    if (field === undefined) return !ts.isFunctionDeclaration(statement);
    return !(ts.isInterfaceDeclaration(statement) && statement.members.some(node => node.name && ts.isIdentifier(node.name) && node.name.text === field));
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
