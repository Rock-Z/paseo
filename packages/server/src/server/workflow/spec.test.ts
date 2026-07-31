import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  materializeWorkflowSpec,
  validateWorkflowTemplate,
  type WorkflowCallerContext,
} from "./spec.js";

function baseSpec(): Record<string, unknown> {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: "test-workflow",
    description: "A public behavior fixture.",
    parameters: {
      objective: { type: "string", required: true, description: "Work to complete" },
      workspaceRef: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
      },
      worktreeRef: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
      },
      concurrency: { type: "integer", default: 2 },
    },
    bindings: {
      workspace: "{{ parameters.workspaceRef }}",
      worktree: "{{ parameters.worktreeRef }}",
    },
    workspace: {
      createWorktree: {
        cwd: "{{ parameters.worktreeRef }}",
        target: { mode: "branch-off", base: "main" },
      },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "Workflow worker",
          provider: "codex",
          model: "gpt-test",
          settings: { mode: "default", thinking: "low" },
        },
      },
    },
    protocol: { maxAttempts: 3 },
    entry: "main",
    flows: {
      main: {
        initial: "work",
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "work",
              emits: {
                done: {
                  description: "The work is complete",
                  dataSchema: {
                    type: "object",
                    properties: { result: { type: "string" } },
                    required: ["result"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.result }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 5, maxRuntime: "1h" },
    inputs: {
      objective: "{{ parameters.objective }}",
      concurrency: "{{ parameters.concurrency }}",
    },
    prompts: { work: "Complete {{ objective }}." },
  };
}

describe("workflow spec validation and materialization", () => {
  it("preserves native JSON values and resolves caller defaults outside public parameters", () => {
    const context: WorkflowCallerContext = {
      workspaceId: "workspace-1",
      worktreePath: "/repo/worktree",
      agentId: "agent-1",
    };
    const result = materializeWorkflowSpec(
      baseSpec(),
      { objective: "Ship the change", concurrency: "4" },
      context,
    );

    expect(result.spec).toMatchObject({
      bindings: { workspace: "workspace-1", worktree: "/repo/worktree" },
      inputs: { objective: "Ship the change", concurrency: 4 },
    });
    expect(result.canonicalJson).toBe(canonicalJson(result.spec));
    expect(result.canonicalJson.startsWith('{"agents":')).toBe(true);
    expect(result.spec).not.toHaveProperty("parameters");
  });

  it("leaves optional caller bindings null when that current context does not exist", () => {
    const spec = baseSpec();
    const parameters = spec.parameters as Record<string, unknown>;
    parameters.agentRef = {
      type: "string",
      defaultFrom: "current.agent",
      description: "Optional current agent.",
    };
    (spec.bindings as Record<string, unknown>).agents = {
      worker: "{{ parameters.agentRef }}",
    };

    const result = materializeWorkflowSpec(
      spec,
      { objective: "Create a worker when no caller agent exists" },
      { workspaceId: "workspace-1", worktreePath: "/repo/worktree" },
    );

    expect(result.spec).toMatchObject({
      bindings: {
        workspace: "workspace-1",
        worktree: "/repo/worktree",
        agents: { worker: null },
      },
    });
  });

  it("matches object and array enum parameters by canonical JSON value", () => {
    const spec = baseSpec();
    const parameters = spec.parameters as Record<string, unknown>;
    parameters.target = {
      type: "enum",
      required: true,
      values: [{ region: "west", zones: ["b", "a"] }, ["fallback", { priority: 1 }]],
    };
    (spec.inputs as Record<string, unknown>).target = "{{ parameters.target }}";
    const context = {
      workspaceId: "workspace-1",
      worktreePath: "/repo/worktree",
    };

    expect(
      materializeWorkflowSpec(
        spec,
        {
          objective: "Use an object enum",
          target: { zones: ["b", "a"], region: "west" },
        },
        context,
      ).spec,
    ).toMatchObject({
      inputs: { target: { region: "west", zones: ["b", "a"] } },
    });
    expect(
      materializeWorkflowSpec(
        spec,
        {
          objective: "Use an array enum",
          target: ["fallback", { priority: 1 }],
        },
        context,
      ).spec,
    ).toMatchObject({
      inputs: { target: ["fallback", { priority: 1 }] },
    });
  });

  it("rejects explicit null for a required parameter", () => {
    expect(() =>
      materializeWorkflowSpec(
        baseSpec(),
        { objective: null },
        { workspaceId: "workspace-1", worktreePath: "/repo/worktree" },
      ),
    ).toThrow("parameters.objective: required");
  });

  it("rejects unknown fields, broken routes, undeclared parameters, and invalid event schemas", () => {
    const spec = baseSpec();
    spec.unexpected = true;
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const main = flows.main;
    const states = main.states as Record<string, Record<string, unknown>>;
    states.work.on = { missing: "nowhere" };
    const turn = states.work.turn as Record<string, unknown>;
    const emits = turn.emits as Record<string, Record<string, unknown>>;
    emits.done.dataSchema = { type: "definitely-not-a-json-schema-type" };
    const agents = spec.agents as Record<string, Record<string, Record<string, unknown>>>;
    agents.worker.createAgent.modle = "typo-model";
    (agents.worker.createAgent.settings as Record<string, unknown>).thniking = "high";
    (spec.inputs as Record<string, unknown>).missing = "{{ parameters.notDeclared }}";
    const workspace = spec.workspace as Record<string, Record<string, unknown>>;
    workspace.createWorktree.prefix = "ignored-prefix";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.unexpected",
        "workspace.createWorktree.prefix",
        "agents.worker.createAgent.modle",
        "agents.worker.createAgent.settings.thniking",
        "parameters.notDeclared",
        "flows.main.states.work.on.done",
        "flows.main.states.work.turn.emits.done.dataSchema",
      ]),
    );
  });

  it("rejects invalid native agent setting value types", () => {
    const spec = baseSpec();
    const agents = spec.agents as Record<string, Record<string, Record<string, unknown>>>;
    agents.worker.createAgent.settings = {
      mode: 1,
      modeId: null,
      thinking: false,
      thinkingOptionId: {},
      featureValues: [],
    };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "agents.worker.createAgent.settings.mode",
        "agents.worker.createAgent.settings.modeId",
        "agents.worker.createAgent.settings.thinking",
        "agents.worker.createAgent.settings.thinkingOptionId",
        "agents.worker.createAgent.settings.featureValues",
      ]),
    );
  });

  it.each([
    ["newBranch", null],
    ["newBranch", 1],
    ["newBranch", ""],
    ["base", null],
    ["base", 1],
    ["base", ""],
  ])("rejects branch-off %s value %j", (field, value) => {
    const spec = baseSpec();
    const workspace = spec.workspace as Record<string, Record<string, unknown>>;
    const createWorktree = workspace.createWorktree;
    const target = createWorktree.target as Record<string, unknown>;
    target[field] = value;

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: `workspace.createWorktree.target.${field}`,
      }),
    );
  });

  it("validates every action and ordered bounded map declaration", () => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    flows.child = {
      initial: "finish",
      inputs: {},
      states: { finish: { return: { output: "{{ inputs }}" } } },
    };
    const main = flows.main;
    const states = main.states as Record<string, Record<string, unknown>>;
    states.work = {
      call: { flow: "child", with: { objective: "{{ inputs.objective }}" } },
      on: { returned: "fanout", "error.agent": "failed", "error.protocol": "failed" },
    };
    states.fanout = {
      map: {
        group: "branches",
        items: "{{ event.data.items }}",
        as: "branch",
        call: { flow: "child", with: { branch: "{{ branch }}" } },
        join: "all",
        concurrency: 2,
      },
      on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
    };
    expect(validateWorkflowTemplate(spec)).toMatchObject({ valid: true, issues: [] });
  });
});
