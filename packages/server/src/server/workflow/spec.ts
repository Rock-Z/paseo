import Ajv2020 from "ajv/dist/2020.js";
import type {
  WorkflowSpecSummary,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from "@getpaseo/protocol/workflow/types";
import { canonicalJson, type JsonObject } from "./json.js";
import { isExactValueExpression, renderValue, templateIssue } from "./render.js";

export { canonicalJson, type JsonObject } from "./json.js";

export interface WorkflowCallerContext {
  workspaceId?: string;
  worktreePath?: string;
  agentId?: string;
}

export interface MaterializedWorkflow {
  spec: JsonObject;
  canonicalJson: string;
}

const TOP_FIELDS = new Set([
  "schemaVersion",
  "name",
  "description",
  "bindings",
  "workspace",
  "agents",
  "protocol",
  "entry",
  "flows",
  "limits",
  "inputs",
  "prompts",
  "parameters",
]);
const ACTIONS = ["turn", "call", "map", "return", "stop"] as const;
const RUNTIME_EVENTS = new Set(["error.agent", "error.protocol"]);
const PARAMETER_TYPES = new Set([
  "string",
  "path",
  "image",
  "object",
  "array",
  "enum",
  "boolean",
  "integer",
  "number",
]);
const DEFAULT_FROM = new Set(["current.workspace", "current.worktree", "current.agent"]);
const CONTEXT_DEFAULT_PARAMETER_TYPES = new Set(["string", "path", "image", "enum"]);
const PROTOTYPE_SENSITIVE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^[1-9][0-9]*(s|m|h|d)$/;
const TEMPLATE_EXPRESSION = /{{([\s\S]*?)}}|{%([\s\S]*?)%}/g;
const PARAMETER_REFERENCE = /^\s*(?:if\s+)?parameters\.([A-Za-z_][A-Za-z0-9_]*)(?:\b|$)/;
const EXACT_PARAMETER_REFERENCE = /^\s*{{\s*parameters\.([A-Za-z_][A-Za-z0-9_]*)\s*}}\s*$/;
const Ajv2020Constructor = Ajv2020 as unknown as {
  new (options?: { strict?: boolean }): {
    compile: (schema: unknown) => (value: unknown) => boolean;
  };
};

class Issues {
  readonly values: WorkflowValidationIssue[] = [];

  add(path: string, message: string): void {
    if (!this.values.some((issue) => issue.path === path && issue.message === message)) {
      this.values.push({ path, message });
    }
  }

  object(value: unknown, path: string, label = "object"): value is JsonObject {
    if (!isObject(value)) {
      this.add(path, `must be a ${label}`);
      return false;
    }
    return true;
  }

  unknown(value: JsonObject, path: string, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(value).sort()) {
      if (!allowed.has(key)) {
        this.add(path === "$" ? `$.${key}` : `${path}.${key}`, "unknown field");
      }
    }
  }

  required(value: JsonObject, path: string, key: string): boolean {
    if (!(key in value)) {
      this.add(path === "$" ? `$.${key}` : `${path}.${key}`, "required");
      return false;
    }
    return true;
  }
}

export function validateWorkflowTemplate(
  value: unknown,
  source: "built-in" | "user" | "legacy" = "user",
): WorkflowValidationResult {
  const issues = new Issues();
  if (!issues.object(value, "$")) {
    return validationResult(issues, null);
  }
  issues.unknown(value, "$", TOP_FIELDS);
  if (value.schemaVersion !== "paseo.workflows.v0.2") {
    issues.add("schemaVersion", "unsupported schema version");
  }
  if (typeof value.name !== "string" || !SLUG.test(value.name)) {
    issues.add("name", "must be a lowercase slug");
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    issues.add("description", "must be a non-empty string");
  }

  const parameters = validateParameters(value.parameters, issues);
  validateTemplateExpressions(value, parameters, issues);
  const agents = validateAgents(value.agents, issues);
  validateBindings(value.bindings, agents, issues);
  validateWorkspace(value.workspace, "workspace", parameters, issues);
  validatePrompts(value.prompts, issues);
  validateProtocol(value.protocol, parameters, issues);
  validateLimits(value.limits, parameters, issues);
  if (value.inputs !== undefined && !isObject(value.inputs)) {
    issues.add("inputs", "must be an object");
  }
  validateFlows(value.flows, value.entry, agents, value.prompts, parameters, issues);

  const summary =
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.schemaVersion === "string"
      ? ({
          id: value.name,
          name: value.name,
          description: value.description,
          version: value.schemaVersion,
          source,
          updatedAt: null,
        } satisfies WorkflowSpecSummary)
      : null;
  return validationResult(issues, summary, parameters);
}

function validationResult(
  issues: Issues,
  summary: WorkflowSpecSummary | null,
  parameters: Map<string, JsonObject> = new Map(),
): WorkflowValidationResult {
  return {
    valid: issues.values.length === 0,
    issues: issues.values,
    summary,
    parameters: [...parameters].map(([name, declaration]) =>
      buildParameterSummary(name, declaration),
    ),
  };
}

function buildParameterSummary(
  name: string,
  declaration: JsonObject,
): WorkflowValidationResult["parameters"][number] {
  let description = name;
  if (typeof declaration.description === "string") {
    description = declaration.description;
  } else if (typeof declaration.title === "string") {
    description = declaration.title;
  }
  const result: WorkflowValidationResult["parameters"][number] = {
    name,
    type: parameterType(declaration),
    description,
    required: declaration.required === true,
  };
  if ("default" in declaration) {
    result.defaultValue = declaration.default;
  }
  if (typeof declaration.defaultFrom === "string" && DEFAULT_FROM.has(declaration.defaultFrom)) {
    result.defaultFrom = declaration.defaultFrom as
      | "current.workspace"
      | "current.worktree"
      | "current.agent";
  }
  if (Array.isArray(declaration.values)) {
    result.values = declaration.values;
  }
  return result;
}

function validateParameters(value: unknown, issues: Issues): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (value === undefined || value === null) {
    return result;
  }
  if (!issues.object(value, "parameters")) {
    return result;
  }
  const allowed = new Set([
    "type",
    "required",
    "default",
    "defaultFrom",
    "title",
    "description",
    "values",
  ]);
  for (const [name, declaration] of Object.entries(value)) {
    const path = `parameters.${name}`;
    if (!IDENTIFIER.test(name) || PROTOTYPE_SENSITIVE_NAMES.has(name)) {
      issues.add(path, "invalid parameter name");
    }
    if (!issues.object(declaration, path)) {
      continue;
    }
    result.set(name, declaration);
    issues.unknown(declaration, path, allowed);
    const type = parameterType(declaration);
    if (!PARAMETER_TYPES.has(type)) {
      issues.add(`${path}.type`, "invalid parameter type");
    }
    if ("required" in declaration && typeof declaration.required !== "boolean") {
      issues.add(`${path}.required`, "must be a boolean");
    }
    if ("defaultFrom" in declaration) {
      if (!DEFAULT_FROM.has(String(declaration.defaultFrom))) {
        issues.add(`${path}.defaultFrom`, "unsupported source");
      } else if (PARAMETER_TYPES.has(type) && !CONTEXT_DEFAULT_PARAMETER_TYPES.has(type)) {
        issues.add(`${path}.defaultFrom`, "requires a string-compatible parameter type");
      }
    }
    if (
      type === "enum" &&
      (!Array.isArray(declaration.values) || declaration.values.length === 0)
    ) {
      issues.add(`${path}.values`, "enum requires values");
    }
    if ("default" in declaration) {
      try {
        coerceParameter(name, declaration, declaration.default);
      } catch (error) {
        issues.add(path, errorMessage(error));
      }
    }
  }
  return result;
}

function validateTemplateExpressions(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  const found = new Set<string>();
  collectTemplateExpressions(value, "", found, issues);
  for (const name of [...found].sort()) {
    if (!parameters.has(name)) {
      issues.add(`parameters.${name}`, "referenced but not declared");
    }
  }
}

function collectTemplateExpressions(
  value: unknown,
  path: string,
  found: Set<string>,
  issues: Issues,
): void {
  if (typeof value === "string") {
    const issue = templateIssue(value, path.startsWith("prompts."));
    if (issue) issues.add(path || "$", issue);
    for (const expression of value.matchAll(TEMPLATE_EXPRESSION)) {
      const match = (expression[1] ?? expression[2] ?? "").match(PARAMETER_REFERENCE);
      if (match) found.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectTemplateExpressions(item, `${path}[${index}]`, found, issues);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!path && key === "parameters") {
      continue;
    }
    collectTemplateExpressions(item, path ? `${path}.${key}` : key, found, issues);
  }
}

function validateBindings(
  value: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!issues.object(value, "bindings")) {
    return;
  }
  issues.unknown(value, "bindings", new Set(["workspace", "worktree", "agents"]));
  const hasWorkspace = value.workspace !== undefined && value.workspace !== null;
  const hasWorktree = value.worktree !== undefined && value.worktree !== null;
  if (hasWorkspace !== hasWorktree) {
    issues.add("bindings", "workspace and worktree must be supplied together");
  }
  for (const key of ["workspace", "worktree"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== "string" || !value[key].trim()) {
      issues.add(`bindings.${key}`, "must be a non-empty string or null");
    }
  }
  if (value.agents === undefined || value.agents === null) {
    return;
  }
  validateAgentBindings(value.agents, agents, issues);
}

function validateAgentBindings(
  value: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, "bindings.agents")) {
    return;
  }
  for (const [name, agentId] of Object.entries(value)) {
    if (!agents.has(name)) {
      issues.add(`bindings.agents.${name}`, "unknown agent");
    }
    if (agentId !== null && (typeof agentId !== "string" || !agentId.trim())) {
      issues.add(`bindings.agents.${name}`, "must be a non-empty string or null");
    }
    if (agentId !== null && agents.get(name)?.persistence !== "reuse-agent") {
      issues.add(`agents.${name}.persistence`, "bound agents must use reuse-agent");
    }
  }
}

function validateWorkspace(
  value: unknown,
  path: string,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["createWorktree"]));
  if (!issues.required(value, path, "createWorktree")) {
    return;
  }
  const createPath = `${path}.createWorktree`;
  if (!issues.object(value.createWorktree, createPath)) {
    return;
  }
  const create = value.createWorktree;
  issues.unknown(create, createPath, new Set(["cwd", "name", "target"]));
  if (typeof create.cwd !== "string" || create.cwd.length === 0) {
    issues.add(`${createPath}.cwd`, "must be a string");
  }
  if ("name" in create && (typeof create.name !== "string" || create.name.length === 0)) {
    issues.add(`${createPath}.name`, "must be a non-empty string");
  }
  if (!issues.object(create.target, `${createPath}.target`)) {
    return;
  }
  const target = create.target;
  const targetPath = `${createPath}.target`;
  if (target.mode === "branch-off") {
    issues.unknown(target, targetPath, new Set(["mode", "newBranch", "base"]));
    for (const field of ["newBranch", "base"]) {
      if (field in target && (typeof target[field] !== "string" || target[field].length === 0)) {
        issues.add(`${targetPath}.${field}`, "must be a non-empty string");
      }
    }
  } else if (target.mode === "checkout-branch") {
    issues.unknown(target, targetPath, new Set(["mode", "branch"]));
    if (typeof target.branch !== "string" || target.branch.length === 0) {
      issues.add(`${targetPath}.branch`, "must be a non-empty string");
    }
  } else if (target.mode === "checkout-pr") {
    issues.unknown(target, targetPath, new Set(["mode", "prNumber"]));
    if (!isPositiveIntegerOrParameter(target.prNumber, parameters)) {
      issues.add(`${targetPath}.prNumber`, "must be a positive integer");
    }
  } else {
    issues.add(`${targetPath}.mode`, "unknown mode");
  }
}

function validateAgents(value: unknown, issues: Issues): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (!issues.object(value, "agents") || Object.keys(value).length === 0) {
    issues.add("agents", "must be a non-empty object");
    return result;
  }
  for (const [name, declaration] of Object.entries(value)) {
    const path = `agents.${name}`;
    if (!AGENT_NAME.test(name)) {
      issues.add(path, "invalid agent name");
    }
    if (!issues.object(declaration, path)) {
      continue;
    }
    result.set(name, declaration);
    validateAgentDeclaration(declaration, path, issues);
  }
  return result;
}

function validateAgentDeclaration(declaration: JsonObject, path: string, issues: Issues): void {
  issues.unknown(declaration, path, new Set(["persistence", "createAgent"]));
  if (!["reuse-agent", "fresh-agent"].includes(String(declaration.persistence))) {
    issues.add(`${path}.persistence`, "must be reuse-agent or fresh-agent");
  }
  if (!issues.object(declaration.createAgent, `${path}.createAgent`)) {
    return;
  }
  validateCreateAgent(declaration.createAgent, `${path}.createAgent`, issues);
}

function validateCreateAgent(create: JsonObject, path: string, issues: Issues): void {
  issues.unknown(create, path, new Set(["title", "provider", "model", "settings"]));
  for (const field of ["title", "provider", "settings"]) {
    if (!(field in create)) {
      issues.add(`${path}.${field}`, "required");
    }
  }
  if (typeof create.title !== "string" || create.title.length === 0) {
    issues.add(`${path}.title`, "must be a non-empty string");
  }
  if (typeof create.provider !== "string" || !create.provider.trim()) {
    issues.add(`${path}.provider`, "must be a non-empty string");
  }
  if (create.model !== undefined && (typeof create.model !== "string" || !create.model)) {
    issues.add(`${path}.model`, "must be a non-empty string");
  }
  if (
    typeof create.provider === "string" &&
    create.provider.includes("/") &&
    create.model !== undefined
  ) {
    issues.add(path, "model conflicts with provider/model syntax");
  }
  if (!isObject(create.settings)) {
    issues.add(`${path}.settings`, "must be an object");
    return;
  }
  issues.unknown(
    create.settings,
    `${path}.settings`,
    new Set(["mode", "modeId", "thinking", "thinkingOptionId", "featureValues"]),
  );
  for (const field of ["mode", "modeId", "thinking", "thinkingOptionId"]) {
    if (
      field in create.settings &&
      (typeof create.settings[field] !== "string" || !create.settings[field].trim())
    ) {
      issues.add(`${path}.settings.${field}`, "must be a non-empty string");
    }
  }
  if ("featureValues" in create.settings && !isObject(create.settings.featureValues)) {
    issues.add(`${path}.settings.featureValues`, "must be an object");
  }
}

function validatePrompts(value: unknown, issues: Issues): void {
  if (!issues.object(value, "prompts") || Object.keys(value).length === 0) {
    issues.add("prompts", "must be a non-empty object");
    return;
  }
  for (const [name, prompt] of Object.entries(value)) {
    if (typeof prompt !== "string") {
      issues.add(`prompts.${name}`, "must be a string");
    }
  }
}

function validateProtocol(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (value === undefined) {
    return;
  }
  if (!issues.object(value, "protocol")) {
    return;
  }
  issues.unknown(value, "protocol", new Set(["maxAttempts"]));
  if (
    value.maxAttempts !== undefined &&
    !isPositiveIntegerOrParameter(value.maxAttempts, parameters)
  ) {
    issues.add("protocol.maxAttempts", "must be a positive integer");
  }
}

function validateLimits(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!issues.object(value, "limits")) {
    return;
  }
  issues.unknown(value, "limits", new Set(["maxIterations", "maxRuntime"]));
  if (
    value.maxIterations !== undefined &&
    !isPositiveIntegerOrParameter(value.maxIterations, parameters)
  ) {
    issues.add("limits.maxIterations", "must be a positive integer");
  }
  if (
    value.maxRuntime !== undefined &&
    !isDurationOrStringParameter(value.maxRuntime, parameters)
  ) {
    issues.add("limits.maxRuntime", "invalid duration");
  }
}

function validateFlows(
  value: unknown,
  entry: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  prompts: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, "flows") || Object.keys(value).length === 0) {
    issues.add("flows", "must be a non-empty object");
    return;
  }
  const flowNames = new Set(Object.keys(value));
  const promptNames = new Set(isObject(prompts) ? Object.keys(prompts) : []);
  if (typeof entry !== "string" || !flowNames.has(entry)) {
    issues.add("entry", "unknown flow");
  }
  for (const [flowName, flowValue] of Object.entries(value)) {
    const path = `flows.${flowName}`;
    if (!issues.object(flowValue, path)) {
      continue;
    }
    issues.unknown(flowValue, path, new Set(["initial", "states", "inputs"]));
    if (flowValue.inputs !== undefined && !isObject(flowValue.inputs)) {
      issues.add(`${path}.inputs`, "must be an object");
    }
    if (!issues.object(flowValue.states, `${path}.states`)) {
      continue;
    }
    const states = flowValue.states;
    const stateNames = new Set(Object.keys(states));
    if (typeof flowValue.initial !== "string" || !stateNames.has(flowValue.initial)) {
      issues.add(`${path}.initial`, "unknown state");
    }
    for (const [stateName, stateValue] of Object.entries(states)) {
      validateState(
        stateValue,
        `${path}.states.${stateName}`,
        stateNames,
        flowNames,
        agents,
        promptNames,
        parameters,
        issues,
      );
    }
  }
  validateSchedulerCycles(value, flowNames, issues);
}

interface FlowCallEdge {
  target: string;
  path: string;
}

interface SchedulerCall {
  action: JsonObject;
  actionPath: "call" | "map.call";
  continuationEvent: "returned" | "joined";
}

function schedulerCall(state: JsonObject): SchedulerCall | null {
  if (isObject(state.call)) {
    return { action: state.call, actionPath: "call", continuationEvent: "returned" };
  }
  if (isObject(state.map) && isObject(state.map.call)) {
    return { action: state.map.call, actionPath: "map.call", continuationEvent: "joined" };
  }
  return null;
}

function createZeroTurnReturnResolver(
  flows: JsonObject,
  flowNames: ReadonlySet<string>,
): (flowName: string) => boolean {
  const memo = new Map<string, boolean>();
  const evaluating = new Set<string>();
  const resolve = (flowName: string): boolean => {
    const memoized = memo.get(flowName);
    if (memoized !== undefined) return memoized;
    if (evaluating.has(flowName)) return false;
    evaluating.add(flowName);
    const flow = flows[flowName];
    let result = false;
    if (isObject(flow) && isObject(flow.states) && typeof flow.initial === "string") {
      const visitedStates = new Set<string>();
      let stateName: string | undefined = flow.initial;
      while (stateName && !visitedStates.has(stateName)) {
        visitedStates.add(stateName);
        const state: unknown = flow.states[stateName];
        if (!isObject(state)) break;
        if (isObject(state.return)) {
          result = true;
          break;
        }
        const scheduler = schedulerCall(state);
        if (!scheduler) break;
        const routes: JsonObject = isObject(state.on) ? state.on : {};
        if (scheduler.actionPath === "call") {
          if (
            typeof scheduler.action.flow !== "string" ||
            !flowNames.has(scheduler.action.flow) ||
            !resolve(scheduler.action.flow)
          ) {
            break;
          }
          stateName = typeof routes.returned === "string" ? routes.returned : undefined;
        } else {
          stateName = typeof routes.joined === "string" ? routes.joined : undefined;
        }
      }
    }
    evaluating.delete(flowName);
    memo.set(flowName, result);
    return result;
  };
  return resolve;
}

function validateSchedulerCycles(
  flows: JsonObject,
  flowNames: ReadonlySet<string>,
  issues: Issues,
): void {
  const returnsWithoutTurn = createZeroTurnReturnResolver(flows, flowNames);
  const calls = collectZeroTurnFlowCalls(flows, flowNames, returnsWithoutTurn, issues);

  const visited = new Set<string>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();
  const visit = (flowName: string): void => {
    if (visited.has(flowName)) return;
    stackIndexes.set(flowName, stack.length);
    stack.push(flowName);
    for (const edge of calls.get(flowName) ?? []) {
      const cycleStart = stackIndexes.get(edge.target);
      if (cycleStart !== undefined) {
        issues.add(
          edge.path,
          `recursive flow call cycle: ${[...stack.slice(cycleStart), edge.target].join(" -> ")}`,
        );
      } else {
        visit(edge.target);
      }
    }
    stack.pop();
    stackIndexes.delete(flowName);
    visited.add(flowName);
  };
  for (const flowName of flowNames) visit(flowName);
}

function collectZeroTurnFlowCalls(
  flows: JsonObject,
  flowNames: ReadonlySet<string>,
  returnsWithoutTurn: (flowName: string) => boolean,
  issues: Issues,
): Map<string, FlowCallEdge[]> {
  const calls = new Map<string, FlowCallEdge[]>();
  for (const [flowName, flowValue] of Object.entries(flows)) {
    const edges: FlowCallEdge[] = [];
    if (
      !isObject(flowValue) ||
      !isObject(flowValue.states) ||
      typeof flowValue.initial !== "string"
    ) {
      calls.set(flowName, edges);
      continue;
    }
    const stateStack: string[] = [];
    const stateIndexes = new Map<string, number>();
    let stateName: string | undefined = flowValue.initial;
    while (stateName) {
      stateIndexes.set(stateName, stateStack.length);
      stateStack.push(stateName);
      const stateValue: unknown = flowValue.states[stateName];
      if (!isObject(stateValue)) break;
      const scheduler = schedulerCall(stateValue);
      if (!scheduler) break;
      const { action, actionPath, continuationEvent } = scheduler;
      if (typeof action.flow === "string" && flowNames.has(action.flow)) {
        edges.push({
          target: action.flow,
          path: `flows.${flowName}.states.${stateName}.${actionPath}.flow`,
        });
      }
      const canContinue =
        actionPath === "map.call" ||
        (typeof action.flow === "string" &&
          flowNames.has(action.flow) &&
          returnsWithoutTurn(action.flow));
      if (!canContinue) break;
      const routes: JsonObject = isObject(stateValue.on) ? stateValue.on : {};
      const continuation: unknown = continuationEvent ? routes[continuationEvent] : undefined;
      if (typeof continuation !== "string") break;
      const cycleStart = stateIndexes.get(continuation);
      if (cycleStart !== undefined) {
        const cycle = [...stateStack.slice(cycleStart), continuation]
          .map((state) => `${flowName}.${state}`)
          .join(" -> ");
        issues.add(
          `flows.${flowName}.states.${stateName}.on.${continuationEvent}`,
          `scheduler state cycle: ${cycle}`,
        );
        break;
      }
      stateName = continuation;
    }
    calls.set(flowName, edges);
  }
  return calls;
}

function validateState(
  value: unknown,
  path: string,
  stateNames: ReadonlySet<string>,
  flowNames: ReadonlySet<string>,
  agents: ReadonlyMap<string, JsonObject>,
  promptNames: ReadonlySet<string>,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set([...ACTIONS, "on"]));
  const actions = ACTIONS.filter((action) => action in value);
  if (actions.length !== 1) {
    issues.add(path, "must contain exactly one action");
    return;
  }
  const action = actions[0];
  const routes = validateRoutes(value.on, `${path}.on`, stateNames, action, issues);
  if (action === "turn") {
    const allowed = validateTurn(value.turn, path, agents, promptNames, routes, issues);
    validateAllowedRoutes(routes, allowed, path, issues);
  } else if (action === "call") {
    validateCall(value.call, `${path}.call`, flowNames, parameters, issues);
    if (!routes.has("returned")) {
      issues.add(`${path}.on.returned`, "required");
    }
    validateAllowedRoutes(routes, new Set([...RUNTIME_EVENTS, "returned"]), path, issues);
  } else if (action === "map") {
    validateMap(value.map, `${path}.map`, flowNames, parameters, issues);
    if (!routes.has("joined")) {
      issues.add(`${path}.on.joined`, "required");
    }
    validateAllowedRoutes(routes, new Set([...RUNTIME_EVENTS, "joined"]), path, issues);
  } else if (action === "return") {
    validateReturnState(value, path, issues);
  } else {
    validateStopState(value, path, issues);
  }
}

function validateTurn(
  value: unknown,
  path: string,
  agents: ReadonlyMap<string, JsonObject>,
  promptNames: ReadonlySet<string>,
  routes: ReadonlyMap<string, string>,
  issues: Issues,
): Set<string> {
  const allowed = new Set(RUNTIME_EVENTS);
  if (!issues.object(value, `${path}.turn`)) {
    return allowed;
  }
  issues.unknown(value, `${path}.turn`, new Set(["agent", "prompt", "emits"]));
  if (typeof value.agent !== "string" || !agents.has(value.agent)) {
    issues.add(`${path}.turn.agent`, "unknown agent");
  }
  if (typeof value.prompt !== "string" || !promptNames.has(value.prompt)) {
    issues.add(`${path}.turn.prompt`, "unknown prompt");
  }
  if (!issues.object(value.emits, `${path}.turn.emits`)) {
    return allowed;
  }
  const eventDeclarations = Object.entries(value.emits);
  if (eventDeclarations.length === 0) {
    issues.add(`${path}.turn.emits`, "must declare at least one event");
  }
  for (const [event, declaration] of eventDeclarations) {
    if (!event.trim()) {
      issues.add(`${path}.turn.emits`, "event names must be non-empty strings");
      continue;
    }
    validateEventDeclaration(event, declaration, path, routes, allowed, issues);
  }
  return allowed;
}

function validateEventDeclaration(
  event: string,
  value: unknown,
  path: string,
  routes: ReadonlyMap<string, string>,
  allowed: Set<string>,
  issues: Issues,
): void {
  const eventPath = `${path}.turn.emits.${event}`;
  if (RUNTIME_EVENTS.has(event)) {
    issues.add(eventPath, "reserved runtime event");
  }
  allowed.add(event);
  if (!issues.object(value, eventPath)) {
    return;
  }
  issues.unknown(value, eventPath, new Set(["description", "dataSchema"]));
  if (typeof value.description !== "string" || !value.description.trim()) {
    issues.add(`${eventPath}.description`, "must be a non-empty string");
  }
  if (value.dataSchema !== undefined) {
    try {
      new Ajv2020Constructor({ strict: true }).compile(value.dataSchema);
    } catch (error) {
      issues.add(`${eventPath}.dataSchema`, `invalid JSON Schema: ${errorMessage(error)}`);
    }
  }
  if (!routes.has(event)) {
    issues.add(`${path}.on.${event}`, "required for emitted event");
  }
}

function validateAllowedRoutes(
  routes: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: Issues,
): void {
  for (const event of routes.keys()) {
    if (!allowed.has(event)) {
      issues.add(`${path}.on.${event}`, "unsupported event");
    }
  }
}

function validateReturnState(value: JsonObject, path: string, issues: Issues): void {
  if (value.on !== undefined) {
    issues.add(`${path}.on`, "not allowed for return state");
  }
  if (!issues.object(value.return, `${path}.return`)) {
    issues.add(`${path}.return.output`, "required");
    return;
  }
  issues.unknown(value.return, `${path}.return`, new Set(["output"]));
  if (!("output" in value.return)) {
    issues.add(`${path}.return.output`, "required");
  }
}

function validateStopState(value: JsonObject, path: string, issues: Issues): void {
  if (value.on !== undefined) {
    issues.add(`${path}.on`, "not allowed for stop state");
  }
  if (!issues.object(value.stop, `${path}.stop`)) {
    issues.add(`${path}.stop.reason`, "must be a non-empty string");
    return;
  }
  issues.unknown(value.stop, `${path}.stop`, new Set(["reason"]));
  if (typeof value.stop.reason !== "string" || !value.stop.reason.trim()) {
    issues.add(`${path}.stop.reason`, "must be a non-empty string");
  }
}

function validateRoutes(
  value: unknown,
  path: string,
  stateNames: ReadonlySet<string>,
  action: (typeof ACTIONS)[number],
  issues: Issues,
): Map<string, string> {
  const result = new Map<string, string>();
  if ((action === "turn" || action === "call" || action === "map") && value === undefined) {
    issues.add(path, "required");
    return result;
  }
  if (value === undefined) {
    return result;
  }
  if (!issues.object(value, path)) {
    return result;
  }
  for (const [event, target] of Object.entries(value)) {
    if (typeof target !== "string" || !stateNames.has(target)) {
      issues.add(`${path}.${event}`, "unknown state");
    } else {
      result.set(event, target);
    }
  }
  return result;
}

function validateCall(
  value: unknown,
  path: string,
  flowNames: ReadonlySet<string>,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["flow", "with", "workspace"]));
  if (typeof value.flow !== "string" || !flowNames.has(value.flow)) {
    issues.add(`${path}.flow`, "unknown flow");
  }
  if (value.with !== undefined && !isObject(value.with)) {
    issues.add(`${path}.with`, "must be an object");
  }
  if (value.workspace !== undefined) {
    if (!issues.object(value.workspace, `${path}.workspace`)) {
      return;
    }
    const keys = Object.keys(value.workspace);
    if (keys.length !== 1 || !["inherit", "createWorktree"].includes(keys[0])) {
      issues.add(`${path}.workspace`, "must contain exactly one of createWorktree or inherit");
    } else if (keys[0] === "inherit" && value.workspace.inherit !== true) {
      issues.add(`${path}.workspace.inherit`, "must be true");
    } else if (keys[0] === "createWorktree") {
      validateWorkspace(value.workspace, `${path}.workspace`, parameters, issues);
    }
  }
}

function validateMap(
  value: unknown,
  path: string,
  flowNames: ReadonlySet<string>,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["group", "items", "as", "call", "join", "concurrency"]));
  if (typeof value.group !== "string" || !value.group.trim()) {
    issues.add(`${path}.group`, "must be a non-empty string");
  } else if (PROTOTYPE_SENSITIVE_NAMES.has(value.group)) {
    issues.add(`${path}.group`, "must not be a prototype-sensitive name");
  }
  if (typeof value.items !== "string" || !value.items.trim()) {
    issues.add(`${path}.items`, "must be a non-empty string");
  } else if (!isExactValueExpression(value.items)) {
    issues.add(`${path}.items`, "must be an exact value expression");
  }
  if (typeof value.as !== "string" || !IDENTIFIER.test(value.as)) {
    issues.add(`${path}.as`, "must be an identifier");
  }
  validateCall(value.call, `${path}.call`, flowNames, parameters, issues);
  if (value.join !== "all") {
    issues.add(`${path}.join`, "must be all");
  }
  if (
    value.concurrency !== undefined &&
    !isPositiveIntegerOrParameter(value.concurrency, parameters)
  ) {
    issues.add(`${path}.concurrency`, "must be a positive integer");
  }
}

export function materializeWorkflowSpec(
  template: unknown,
  values: JsonObject = {},
  context: WorkflowCallerContext = {},
): MaterializedWorkflow {
  const validation = validateWorkflowTemplate(template);
  if (!validation.valid || !isObject(template)) {
    throw new Error(formatValidationIssues(validation.issues));
  }
  const declarations = isObject(template.parameters) ? template.parameters : {};
  for (const name of Object.keys(values)) {
    if (!(name in declarations)) {
      throw new Error(`parameters.${name}: unknown parameter`);
    }
  }
  const resolved: JsonObject = {};
  for (const [name, rawDeclaration] of Object.entries(declarations)) {
    if (!isObject(rawDeclaration)) {
      continue;
    }
    let value: unknown;
    if (name in values) {
      value = values[name];
    } else if ("default" in rawDeclaration) {
      value = rawDeclaration.default;
    } else if (typeof rawDeclaration.defaultFrom === "string") {
      value = resolveDefault(rawDeclaration.defaultFrom, context);
      if (value === undefined && rawDeclaration.required === true) {
        throw new Error(
          `defaultFrom: ${rawDeclaration.defaultFrom} requires an agent or workspace context`,
        );
      }
    } else if (rawDeclaration.required === true) {
      throw new Error(`parameters.${name}: required`);
    } else {
      value = null;
    }
    resolved[name] = coerceParameter(name, rawDeclaration, value);
  }
  const materialized = renderValue(
    Object.fromEntries(Object.entries(template).filter(([key]) => key !== "parameters")),
    { parameters: resolved },
    { preserveUndefined: true },
  );
  if (!isObject(materialized)) {
    throw new Error("$: materialized spec must be an object");
  }
  const materializedValidation = validateWorkflowTemplate(materialized);
  if (!materializedValidation.valid) {
    throw new Error(formatValidationIssues(materializedValidation.issues));
  }
  return { spec: materialized, canonicalJson: canonicalJson(materialized) };
}

function resolveDefault(source: string, context: WorkflowCallerContext): string | undefined {
  if (source === "current.workspace") return context.workspaceId;
  if (source === "current.worktree") return context.worktreePath;
  if (source === "current.agent") return context.agentId;
  return undefined;
}

function coerceParameter(name: string, declaration: JsonObject, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (declaration.required === true) {
      throw new Error(`parameters.${name}: required`);
    }
    return null;
  }
  const type = parameterType(declaration);
  const path = `parameters.${name}`;
  if (["string", "path", "image"].includes(type)) {
    if (typeof value !== "string") throw new Error(`${path}: must be a string`);
    return value;
  }
  if (type === "object") {
    if (!isObject(value)) throw new Error(`${path}: must be an object`);
    return value;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: must be an array`);
    return value;
  }
  if (type === "enum") {
    if (
      !Array.isArray(declaration.values) ||
      !declaration.values.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
    ) {
      throw new Error(`${path}: must be one of ${JSON.stringify(declaration.values)}`);
    }
    return value;
  }
  if (type === "boolean") return coerceBoolean(path, value);
  if (type === "integer" || type === "number") {
    return coerceNumber(path, value, type === "integer");
  }
  throw new Error(`${path}.type: invalid parameter type`);
}

function coerceBoolean(path: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
    return value.toLowerCase() === "true";
  }
  throw new Error(`${path}: must be a boolean`);
}

function coerceNumber(path: string, value: unknown, integer: boolean): number {
  const label = integer ? "integer" : "number";
  if (typeof value === "boolean") throw new Error(`${path}: must be a ${label}`);
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(`${path}: must be a ${label}`);
  }
  return number;
}

export function formatValidationIssues(issues: readonly WorkflowValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function parameterType(
  declaration: JsonObject,
): WorkflowValidationResult["parameters"][number]["type"] {
  return (
    typeof declaration.type === "string" ? declaration.type : "string"
  ) as WorkflowValidationResult["parameters"][number]["type"];
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveIntegerOrParameter(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
): boolean {
  if (isPositiveInteger(value)) return true;
  const name = exactParameterName(value);
  if (!name) return false;
  const declaration = parameters.get(name);
  return !declaration || parameterType(declaration) === "integer";
}

function isDurationOrStringParameter(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
): boolean {
  if (typeof value === "string" && DURATION.test(value)) return true;
  const name = exactParameterName(value);
  if (!name) return false;
  const declaration = parameters.get(name);
  return !declaration || parameterType(declaration) === "string";
}

function exactParameterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(EXACT_PARAMETER_REFERENCE)?.[1] ?? null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
