import ts from "typescript";

export function entryCapabilityCallers() {
  const paths = ts.sys.readDirectory("src", [".ts", ".js", ".mjs"], ["**/test/**", "**/*.test.*", "**/*.d.ts"]);
  const program = ts.createProgram(paths, { allowJs: true, noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, allowImportingTsExtensions: true });
  const checker = program.getTypeChecker(), calls: Record<string, number> = {}, bindings: Record<string, number> = {};
  function context(node: ts.Node): string {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
      if (ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) {
        if (ts.isPropertyAssignment(parent.parent)) return parent.parent.name.getText();
        if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
      }
    }
    return "module";
  }
  for (const path of paths) {
    const source = program.getSourceFile(path); if (!source) throw new Error("Missing capability source: " + path);
    const file = path.replaceAll("\\", "/").replace(/^src\//, "");
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node), returned = signature && checker.getReturnTypeOfSignature(signature);
        if (returned?.aliasSymbol?.name === "Capability") {
          const key = file + "#" + context(node) + ":" + node.expression.getText(source).replace(/\s+/g, " ");
          calls[key] = (calls[key] ?? 0) + 1;
        }
      }
      if (ts.isIdentifier(node) && !(ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
        let symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol && ["capabilities", "entryCapabilities"].includes(symbol.name) && symbol.declarations?.some(declaration => declaration.getSourceFile().fileName.replaceAll("\\", "/").endsWith("/ports/capabilities.ts"))) {
          const slot = ts.isPropertyAssignment(node.parent) && node.parent.initializer === node ? "[" + node.parent.name.getText(source) + "]" : "";
          const key = file + "#" + context(node) + ":" + slot + symbol.name;
          bindings[key] = (bindings[key] ?? 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { calls: Object.fromEntries(Object.entries(calls).sort()), bindings: Object.fromEntries(Object.entries(bindings).sort()) };
}
