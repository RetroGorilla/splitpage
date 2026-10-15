import { readFileSync } from "node:fs";

export const repoUrl = new URL("../", import.meta.url);

export function readBuiltCss() {
  const build = readFileSync(new URL("build.mjs", repoUrl), "utf8");
  const inputs = [...build.matchAll(/\["\/\*\{\{APP_CSS\}\}\*\/", \(\) => src\("([^"]+)"\)\]/g)];
  if (inputs.length !== 1) throw new Error("Expected one direct APP_CSS input in build.mjs; update the CSS reader when aggregation lands");
  const path = "src/" + inputs[0][1];
  return { path, css: readFileSync(new URL(path, repoUrl), "utf8") };
}

function delimiter(text, start, stops) {
  let quote = "", depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unclosed CSS comment");
      i = end + 1;
      continue;
    }
    if (!depth && stops.includes(ch)) return i;
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
  }
  return text.length;
}

export function cssRules(css) {
  const rules = [];
  function block(start, context) {
    let at = start;
    while (at < css.length) {
      const end = delimiter(css, at, "{};");
      const head = css.slice(at, end).trim();
      if (css[end] === "}") return end + 1;
      if (css[end] === ";") { at = end + 1; continue; }
      if (end === css.length) {
        if (head) throw new Error("Unparsed CSS: " + head);
        return end;
      }
      if (head.startsWith("@")) {
        at = block(end + 1, [...context, head]);
        continue;
      }
      const declarations = [];
      at = end + 1;
      while (at < css.length) {
        const stop = delimiter(css, at, ";}");
        const declaration = css.slice(at, stop).trim();
        if (declaration) {
          const colon = delimiter(declaration, 0, ":");
          if (colon === declaration.length) throw new Error("Invalid declaration: " + declaration);
          declarations.push({ property: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() });
        }
        at = stop + 1;
        if (css[stop] === "}") break;
        if (stop === css.length) throw new Error("Unclosed CSS rule: " + head);
      }
      rules.push({ selector: head, context, declarations });
    }
    return at;
  }
  block(0, []);
  return rules;
}

export function colourLiterals(value) {
  return [...value.matchAll(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi)].map((m) => m[0]);
}

export function resolveTokens(value, definitions, stack = []) {
  let result = "", at = 0;
  const pattern = /var\(/g;
  for (let match; (match = pattern.exec(value));) {
    result += value.slice(at, match.index);
    const start = pattern.lastIndex;
    let depth = 1, end = start;
    for (; end < value.length && depth; end++) {
      if (value[end] === "(") depth++;
      if (value[end] === ")") depth--;
    }
    if (depth) throw new Error("Unclosed var(): " + value);
    const args = value.slice(start, end - 1);
    const comma = delimiter(args, 0, ",");
    const name = args.slice(0, comma).trim();
    if (stack.includes(name)) throw new Error("Cyclic token: " + [...stack, name].join(" -> "));
    if (definitions.has(name)) result += resolveTokens(definitions.get(name), definitions, [...stack, name]);
    else if (comma < args.length) result += resolveTokens(args.slice(comma + 1).trim(), definitions, stack);
    else result += `var(${name})`;
    at = end;
    pattern.lastIndex = end;
  }
  return result + value.slice(at);
}

const definitionsOf = (rule) => rule.declarations.filter((d) => d.property.startsWith("--")).map((d) => [d.property, d.value]);
const normalise = (value) => value.replace(/\s+/g, "").toLowerCase().replace(/#([\da-f]{3})\b/g, (_, hex) => "#" + [...hex].map((c) => c + c).join(""));

export function compareCssColours(before, after) {
  const oldRules = cssRules(before), newRules = cssRules(after);
  const differences = [];
  if (oldRules.length !== newRules.length) return ["CSS rule count changed"];
  const themes = ["light", "dark", "system-dark", "prompter"];
  function palette(rules, theme) {
    const definitions = new Map();
    for (const rule of rules) {
      const root = rule.selector === ":root";
      const media = rule.selector === ':root:not([data-theme="light"])';
      const dark = rule.selector === ':root[data-theme="dark"], .prompter, .prompter-line';
      if (root || (media && theme === "system-dark") || (dark && theme !== "light")) {
        for (const [name, value] of definitionsOf(rule)) definitions.set(name, value);
      }
    }
    return definitions;
  }
  for (const theme of themes) {
    const oldPalette = palette(oldRules, theme), newPalette = palette(newRules, theme);
    for (let i = 0; i < oldRules.length; i++) {
      const a = oldRules[i], b = newRules[i];
      const label = `${theme} | ${a.context.join(" | ")} | ${a.selector}`;
      if (a.selector !== b.selector || JSON.stringify(a.context) !== JSON.stringify(b.context)) {
        differences.push(label + ": selector or media context changed");
        continue;
      }
      const oldDefinitions = new Map([...oldPalette, ...definitionsOf(a)]);
      const newDefinitions = new Map([...newPalette, ...definitionsOf(b)]);
      const oldDeclarations = a.declarations;
      const newDeclarations = b.declarations.filter((d) => !d.property.startsWith("--") || oldDefinitions.has(d.property));
      if (oldDeclarations.length !== newDeclarations.length) {
        differences.push(label + ": declaration count changed");
        continue;
      }
      for (let j = 0; j < oldDeclarations.length; j++) {
        const x = oldDeclarations[j], y = newDeclarations[j];
        const oldValue = resolveTokens(x.value, oldDefinitions);
        const newValue = resolveTokens(y.value, newDefinitions);
        if (x.property !== y.property || normalise(oldValue) !== normalise(newValue)) {
          differences.push(`${label} | ${x.property}: ${oldValue} -> ${newValue}`);
        }
      }
    }
  }
  return differences;
}
