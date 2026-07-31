import { canonicalJson, isJsonObject, type JsonObject } from "./json.js";

const VALUE_PATH = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*`;
const EXACT_VALUE = new RegExp(
  String.raw`^\s*\{\{\s*(${VALUE_PATH})\s*(?:\|\s*(trim)\s*)?\}\}\s*$`,
);
const INLINE_VALUE = new RegExp(String.raw`\{\{\s*(${VALUE_PATH})\s*(?:\|\s*(trim)\s*)?\}\}`, "g");
const IF_BLOCK = new RegExp(
  String.raw`\{%\s*if\s+(${VALUE_PATH})\s*==\s*(["'])(.*?)\2\s*%\}([\s\S]*?)\{%\s*endif\s*%\}`,
  "g",
);
const VALUE_EXPRESSION = new RegExp(String.raw`^${VALUE_PATH}\s*(?:\|\s*trim\s*)?$`);
const ALL_VALUES = /\{\{([\s\S]*?)\}\}/g;
const ANY_TAG = /{%\s*([^%]+?)\s*%}/;
const ALL_TAGS = /{%\s*([^%]+?)\s*%}/g;
const IF_TAG = new RegExp(String.raw`^if\s+${VALUE_PATH}\s*==\s*(["']).*?\1$`);

export function isExactValueExpression(value: unknown): value is string {
  return typeof value === "string" && EXACT_VALUE.test(value);
}

export function templateIssue(template: string, allowConditionals = false): string | null {
  const interpolation = interpolationIssue(template);
  if (interpolation) return interpolation;
  const withoutValues = template.replace(ALL_VALUES, "");
  if (!allowConditionals) {
    const unsupported = withoutValues.match(ANY_TAG);
    if (unsupported) return `has unsupported template tag: ${unsupported[1].trim()}`;
    return hasUnbalancedSyntax(withoutValues, "{%", "%}") ? "has an unbalanced template tag" : null;
  }
  let open = false;
  for (const match of withoutValues.matchAll(ALL_TAGS)) {
    const tag = match[1].trim();
    if (IF_TAG.test(tag)) {
      if (open) return "has an unsupported nested if block";
      open = true;
      continue;
    }
    if (tag === "endif") {
      if (!open) return "has an unbalanced if block";
      open = false;
      continue;
    }
    return `has unsupported template tag: ${tag}`;
  }
  if (open) return "has an unbalanced if block";
  return hasUnbalancedSyntax(withoutValues.replace(ALL_TAGS, ""), "{%", "%}")
    ? "has an unbalanced template tag"
    : null;
}

export function renderPrompt(template: string, context: JsonObject): string {
  let rendered = template;
  let previous: string;
  do {
    previous = rendered;
    rendered = rendered.replace(
      IF_BLOCK,
      (_, path: string, _quote: string, expected: string, content: string) =>
        resolvePath(context, path) === expected ? content : "",
    );
  } while (rendered !== previous);
  const unsupported = rendered.match(ANY_TAG);
  if (unsupported) {
    throw new Error(`unsupported workflow template tag: ${unsupported[1].trim()}`);
  }
  return renderString(rendered, context);
}

export function renderValue(
  value: unknown,
  context: JsonObject,
  options: { preserveUndefined?: boolean } = {},
): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_VALUE);
    if (exact) {
      const resolved = tryResolvePath(context, exact[1]);
      if (resolved.found) {
        return exact[2] === "trim" ? stringify(resolved.value).trim() : resolved.value;
      }
      if (options.preserveUndefined) return value;
      throw new Error(`undefined workflow value: ${exact[1]}`);
    }
    return renderString(value, context, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context, options));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, context, options)]),
    );
  }
  return value;
}

function renderString(
  value: string,
  context: JsonObject,
  options: { preserveUndefined?: boolean } = {},
): string {
  const issue = interpolationIssue(value);
  if (issue) throw new Error(`unsupported workflow template: ${issue}`);
  return value.replace(INLINE_VALUE, (match, path: string, filter: string | undefined) => {
    const resolved = tryResolvePath(context, path);
    if (resolved.found) {
      const rendered = stringify(resolved.value);
      return filter === "trim" ? rendered.trim() : rendered;
    }
    if (options.preserveUndefined) return match;
    throw new Error(`undefined workflow value: ${path}`);
  });
}

function interpolationIssue(template: string): string | null {
  for (const match of template.matchAll(ALL_VALUES)) {
    const expression = match[1].trim();
    if (!VALUE_EXPRESSION.test(expression)) {
      return `has unsupported interpolation: ${expression}`;
    }
  }
  return template.replace(ALL_VALUES, "").includes("{{") ? "has an unbalanced interpolation" : null;
}

function hasUnbalancedSyntax(value: string, open: string, close: string): boolean {
  return value.includes(open) || value.includes(close);
}

function resolvePath(context: JsonObject, expression: string): unknown {
  const resolved = tryResolvePath(context, expression);
  if (!resolved.found) throw new Error(`undefined workflow value: ${expression}`);
  return resolved.value;
}

function tryResolvePath(
  context: JsonObject,
  expression: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = context;
  for (const part of expression.split(".")) {
    if (!isJsonObject(current) || !(part in current)) {
      return { found: false };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}
