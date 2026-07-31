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

  it("materializes an array parameter into map items", () => {
    const spec = baseSpec();
    const parameters = spec.parameters as Record<string, unknown>;
    parameters.branches = { type: "array", required: true };
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    flows.child = {
      initial: "finish",
      inputs: {},
      states: { finish: { return: { output: "{{ inputs.branch }}" } } },
    };
    const mainStates = flows.main.states as Record<string, unknown>;
    mainStates.work = {
      map: {
        group: "branches",
        items: "{{ parameters.branches }}",
        as: "branch",
        call: { flow: "child", with: { branch: "{{ branch }}" } },
        join: "all",
      },
      on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
    };

    const result = materializeWorkflowSpec(
      spec,
      {
        objective: "Fan out",
        branches: [{ id: "first" }, { id: "second" }],
      },
      { workspaceId: "workspace-1", worktreePath: "/repo/worktree" },
    );

    expect(result.spec).toMatchObject({
      flows: {
        main: {
          states: {
            work: {
              map: {
                items: [{ id: "first" }, { id: "second" }],
              },
            },
          },
        },
      },
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

  it.each(["boolean", "integer", "number", "object", "array"])(
    "rejects a current-context default for a %s parameter",
    (type) => {
      const spec = baseSpec();
      const parameters = spec.parameters as Record<string, unknown>;
      parameters.contextual = {
        type,
        defaultFrom: "current.workspace",
      };

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        path: "parameters.contextual.defaultFrom",
        message: "requires a string-compatible parameter type",
      });
    },
  );

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

  it("matches parameter references only inside template expressions", () => {
    const prose = baseSpec();
    prose.description = "Documents parameters.timeout without referencing it.";
    (prose.prompts as Record<string, unknown>).work =
      "Treat parameters.timeout as ordinary prose outside template delimiters.";
    expect(validateWorkflowTemplate(prose)).toMatchObject({ valid: true, issues: [] });

    const expression = baseSpec();
    (expression.prompts as Record<string, unknown>).work =
      '{% if parameters.notDeclared == "yes" %}Run it.{% endif %}';
    expect(validateWorkflowTemplate(expression).issues).toContainEqual({
      path: "parameters.notDeclared",
      message: "referenced but not declared",
    });

    const nested = baseSpec();
    (nested.prompts as Record<string, unknown>).work =
      "{{ inputs.parameters.timeout }} {{ event.data.parameters.result }}";
    expect(validateWorkflowTemplate(nested)).toMatchObject({ valid: true, issues: [] });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-sensitive parameter name %j",
    (name) => {
      const spec = baseSpec();
      spec.parameters = {
        ...(spec.parameters as Record<string, unknown>),
        [name]: { type: "string", default: "declared" },
      };

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        path: `parameters.${name}`,
        message: "invalid parameter name",
      });
    },
  );

  it("rejects the reserved but unreachable error.timeout route", () => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const states = flows.main.states as Record<string, Record<string, Record<string, unknown>>>;
    states.work.on["error.timeout"] = "failed";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "flows.main.states.work.on.error.timeout",
      message: "unsupported event",
    });
  });

  it("rejects unsupported prompt template tags before a run is saved", () => {
    const spec = baseSpec();
    (spec.prompts as Record<string, unknown>).work =
      "{% for item in inputs %}{{ item }}{% endfor %}";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "prompts.work",
      message: "has unsupported template tag: for item in inputs",
    });
  });

  it.each([
    ["{{ inputs.objective | uppercase }}", "inputs.objective | uppercase"],
    ["{{ inputs..objective }}", "inputs..objective"],
  ])(
    "rejects unsupported prompt interpolation %j before a run is saved",
    (template, expression) => {
      const spec = baseSpec();
      (spec.prompts as Record<string, unknown>).work = template;

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        path: "prompts.work",
        message: `has unsupported interpolation: ${expression}`,
      });
    },
  );

  it("rejects recursive flow calls", () => {
    const spec = baseSpec();
    spec.flows = {
      main: {
        initial: "recurse",
        states: {
          recurse: {
            call: { flow: "main" },
            on: { returned: "finish" },
          },
          finish: { return: { output: "unreachable" } },
        },
      },
    };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "flows.main.states.recurse.call.flow",
      message: "recursive flow call cycle: main -> main",
    });
  });

  it("allows a recursive call when every invocation reaches a turn first", () => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const main = flows.main;
    const states = main.states as Record<string, Record<string, unknown>>;
    (states.work.on as Record<string, unknown>).done = "recurse";
    states.recurse = {
      call: { flow: "main" },
      on: { returned: "finish" },
    };

    expect(validateWorkflowTemplate(spec).valid).toBe(true);
  });

  it("rejects scheduler-state cycles that can repeat without a turn", () => {
    const spec = baseSpec();
    spec.flows = {
      main: {
        initial: "loop",
        states: {
          loop: {
            call: { flow: "leaf" },
            on: { returned: "loop" },
          },
        },
      },
      leaf: {
        initial: "finish",
        states: {
          finish: { return: { output: "done" } },
        },
      },
    };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "flows.main.states.loop.on.returned",
      message: "scheduler state cycle: main.loop -> main.loop",
    });
  });

  it("allows a scheduler-state cycle when each pass reaches a turn", () => {
    const spec = baseSpec();
    spec.flows = {
      main: {
        initial: "loop",
        states: {
          loop: {
            call: { flow: "child" },
            on: { returned: "loop" },
          },
        },
      },
      child: {
        initial: "work",
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "work",
              emits: { done: { description: "Finished one pass" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "done" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };

    expect(validateWorkflowTemplate(spec)).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects a turn with no emitted events", () => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const states = flows.main.states as Record<string, Record<string, Record<string, unknown>>>;
    states.work.turn.emits = {};

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "flows.main.states.work.turn.emits",
      message: "must declare at least one event",
    });
  });

  it.each(["", "   "])("rejects an empty emitted event name %j", (event) => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const states = flows.main.states as Record<string, Record<string, Record<string, unknown>>>;
    states.work.turn.emits = {
      [event]: { description: "Cannot be emitted reliably" },
    };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "flows.main.states.work.turn.emits",
      message: "event names must be non-empty strings",
    });
  });

  it.each([
    ["workspace", ""],
    ["workspace", "   "],
    ["worktree", ""],
    ["worktree", "   "],
  ])("rejects empty %s binding value %j", (field, value) => {
    const spec = baseSpec();
    (spec.bindings as Record<string, unknown>)[field] = value;

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: `bindings.${field}`,
      message: "must be a non-empty string or null",
    });
  });

  it.each(["", "   "])("rejects empty agent binding value %j", (value) => {
    const spec = baseSpec();
    (spec.bindings as Record<string, unknown>).agents = { worker: value };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "bindings.agents.worker",
      message: "must be a non-empty string or null",
    });
  });

  it.each([
    ["finish", "return"],
    ["failed", "stop"],
  ])("rejects unknown fields in a %s state", (stateName, action) => {
    const spec = baseSpec();
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    const states = flows.main.states as Record<string, Record<string, Record<string, unknown>>>;
    states[stateName][action].status = "failed";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: `flows.main.states.${stateName}.${action}.status`,
      message: "unknown field",
    });
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

  it("rejects a whitespace-only native agent provider", () => {
    const spec = baseSpec();
    const agents = spec.agents as Record<string, Record<string, Record<string, unknown>>>;
    agents.worker.createAgent.provider = "   ";

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "agents.worker.createAgent.provider",
      message: "must be a non-empty string",
    });
  });

  it.each(["mode", "modeId", "thinking", "thinkingOptionId"])(
    "rejects an empty %s agent setting",
    (field) => {
      const spec = baseSpec();
      const agents = spec.agents as Record<string, Record<string, Record<string, unknown>>>;
      agents.worker.createAgent.settings = { [field]: "" };

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        path: `agents.worker.createAgent.settings.${field}`,
        message: "must be a non-empty string",
      });
    },
  );

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

  it.each([null, 1, {}, [], ""])("rejects createWorktree name value %j", (value) => {
    const spec = baseSpec();
    const workspace = spec.workspace as Record<string, Record<string, unknown>>;
    workspace.createWorktree.name = value;

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "workspace.createWorktree.name",
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

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-sensitive map group %j",
    (group) => {
      const spec = baseSpec();
      const flows = spec.flows as Record<string, Record<string, unknown>>;
      flows.child = {
        initial: "finish",
        inputs: {},
        states: { finish: { return: { output: "{{ inputs }}" } } },
      };
      const states = flows.main.states as Record<string, Record<string, unknown>>;
      states.work = {
        map: {
          group,
          items: "{{ inputs.items }}",
          as: "item",
          call: { flow: "child", with: { item: "{{ item }}" } },
          join: "all",
        },
        on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
      };

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        path: "flows.main.states.work.map.group",
        message: "must not be a prototype-sensitive name",
      });
    },
  );

  it("requires integer parameters for numeric-only fields", () => {
    const spec = baseSpec();
    const parameter = { type: "string", default: "2" };
    (spec.parameters as Record<string, unknown>).count = parameter;
    const count = "{{ parameters.count }}";
    spec.protocol = { maxAttempts: count };
    spec.limits = { maxIterations: count, maxRuntime: "1h" };
    const workspace = spec.workspace as Record<string, Record<string, unknown>>;
    workspace.createWorktree.target = { mode: "checkout-pr", prNumber: count };
    const flows = spec.flows as Record<string, Record<string, unknown>>;
    flows.child = {
      initial: "finish",
      inputs: {},
      states: { finish: { return: { output: "{{ inputs }}" } } },
    };
    const states = flows.main.states as Record<string, Record<string, unknown>>;
    states.work = {
      map: {
        group: "items",
        items: "{{ inputs.items }}",
        as: "item",
        call: { flow: "child", with: { item: "{{ item }}" } },
        join: "all",
        concurrency: count,
      },
      on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
    };

    const result = validateWorkflowTemplate(spec);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "workspace.createWorktree.target.prNumber",
        "protocol.maxAttempts",
        "limits.maxIterations",
        "flows.main.states.work.map.concurrency",
      ]),
    );

    parameter.type = "integer";
    parameter.default = 2;
    expect(validateWorkflowTemplate(spec)).toMatchObject({ valid: true, issues: [] });
  });

  it("requires string parameters for maxRuntime", () => {
    const spec = baseSpec();
    const duration: Record<string, unknown> = { type: "integer", default: 2 };
    (spec.parameters as Record<string, unknown>).duration = duration;
    spec.limits = {
      maxIterations: 5,
      maxRuntime: "{{ parameters.duration }}",
    };

    expect(validateWorkflowTemplate(spec).issues).toContainEqual({
      path: "limits.maxRuntime",
      message: "invalid duration",
    });

    duration.type = "string";
    duration.default = "2h";
    expect(validateWorkflowTemplate(spec)).toMatchObject({ valid: true, issues: [] });
  });

  it.each(["branches", "[1, 2]", "prefix {{ event.data.items }}"])(
    "rejects map item string %j that cannot render to an array",
    (items) => {
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
        map: {
          group: "branches",
          items,
          as: "branch",
          call: { flow: "child", with: { branch: "{{ branch }}" } },
          join: "all",
        },
        on: { joined: "finish", "error.agent": "failed", "error.protocol": "failed" },
      };

      const result = validateWorkflowTemplate(spec);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "flows.main.states.work.map.items",
        }),
      );
    },
  );
});
