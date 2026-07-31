import { describe, expect, it, vi } from "vitest";
import { PaseoWorkflowRuntimeAdapter } from "./paseo-runtime-adapter.js";
import type { JsonObject } from "./spec.js";

describe("PaseoWorkflowRuntimeAdapter", () => {
  it("does not report an unrelated foreground turn as the workflow turn", async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(
      (
        callback: (event: {
          type: "agent_state";
          agent: { activeForegroundTurnId: string };
        }) => void,
      ) => {
        callback({
          type: "agent_state",
          agent: { activeForegroundTurnId: "native-other" },
        });
        return unsubscribe;
      },
    );
    const runAgent = vi.fn(async () => {
      throw new Error("Agent agent-shared already has an active run");
    });
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {
        subscribe,
        getActiveForegroundClientMessageId: vi.fn(() => "client-other"),
        runAgent,
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    const turn = adapter.startTurn({
      runId: "run-shared",
      workflowTurnId: "workflow-turn",
      clientMessageId: "client-workflow",
      instanceId: "root",
      agentId: "agent-shared",
      prompt: "Do workflow work",
      labels: {},
    });

    await expect(turn.nativeTurnId).resolves.toBeNull();
    await expect(turn.result).resolves.toMatchObject({
      agentId: "agent-shared",
      nativeTurnId: null,
      status: "failed",
      lastError: "Agent agent-shared already has an active run",
    });
    expect(runAgent).toHaveBeenCalledWith("agent-shared", "Do workflow work", {
      clientMessageId: "client-workflow",
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("recovers a canceled native turn from its durable terminal receipt", async () => {
    const agent = {
      id: "agent-workflow",
      activeForegroundTurnId: null,
      lifecycle: "idle",
      recentTurnReceipts: [
        {
          turnId: "native-workflow",
          clientMessageId: "client-workflow",
          status: "canceled",
          error: null,
        },
      ],
    };
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {
        getAgent: vi.fn(() => agent),
        getActiveForegroundClientMessageId: vi.fn(() => null),
        getTimelineRows: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        hasInFlightRun: vi.fn(() => false),
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.reconcileTurn({
        agentId: agent.id,
        nativeTurnId: "native-workflow",
        clientMessageId: "client-workflow",
      }),
    ).resolves.toEqual({
      state: "completed",
      result: {
        agentId: agent.id,
        nativeTurnId: "native-workflow",
        status: "canceled",
        lastMessage: "",
        lastError: null,
      },
    });
  });

  it("uses a durable historical receipt before waiting on unrelated busy work", async () => {
    const agent = {
      id: "agent-shared",
      activeForegroundTurnId: "native-new",
      lifecycle: "running",
      recentTurnReceipts: [
        {
          turnId: "native-workflow",
          clientMessageId: "client-workflow",
          status: "completed",
          error: null,
        },
      ],
    };
    const subscribe = vi.fn(() => {
      throw new Error("waited on unrelated busy work");
    });
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {
        getAgent: vi.fn(() => agent),
        getActiveForegroundClientMessageId: vi.fn(() => "client-new"),
        getTimelineRows: vi.fn(async () => [
          {
            item: {
              type: "user_message",
              clientMessageId: "client-workflow",
            },
          },
        ]),
        subscribe,
        hasInFlightRun: vi.fn(() => true),
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.reconcileTurn({
        agentId: agent.id,
        nativeTurnId: "native-workflow",
        clientMessageId: "client-workflow",
      }),
    ).resolves.toEqual({
      state: "completed",
      result: {
        agentId: agent.id,
        nativeTurnId: "native-workflow",
        status: "completed",
        lastMessage: "",
        lastError: null,
      },
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not adopt an unrelated foreground turn without matching client identity", async () => {
    const agent = {
      id: "agent-shared",
      activeForegroundTurnId: "native-other",
      lifecycle: "running",
    };
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {
        getAgent: vi.fn(() => agent),
        getActiveForegroundClientMessageId: vi.fn(() => "client-other"),
        getTimelineRows: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        hasInFlightRun: vi.fn(() => true),
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.reconcileTurn({
        agentId: agent.id,
        nativeTurnId: null,
        clientMessageId: "client-workflow",
      }),
    ).resolves.toEqual({ state: "missing" });
  });

  it("does not validate unused create-agent fallback data for a bound role", async () => {
    const getProvider = vi.fn(async () => {
      throw new Error("fallback provider is unavailable");
    });
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {} as never,
      agentStorage: {} as never,
      providerSnapshotManager: { getProvider } as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });
    const spec: JsonObject = {
      bindings: {
        worktree: process.cwd(),
        agents: { worker: "agent-existing" },
      },
      workspace: {
        createWorktree: {
          cwd: process.cwd(),
        },
      },
      agents: {
        worker: {
          createAgent: {
            provider: "unavailable-fallback",
          },
        },
      },
    };

    await expect(adapter.validateMaterializedSpec(spec, {})).resolves.toBeUndefined();
    expect(getProvider).not.toHaveBeenCalled();

    (spec.bindings as JsonObject).agents = {};
    await expect(adapter.validateMaterializedSpec(spec, {})).rejects.toThrow(
      "fallback provider is unavailable",
    );
    expect(getProvider).toHaveBeenCalledOnce();
  });

  it("validates a bound role fallback when a child flow uses that role", async () => {
    const getProvider = vi.fn(async () => {
      throw new Error("child fallback provider is unavailable");
    });
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {} as never,
      agentStorage: {} as never,
      providerSnapshotManager: {
        getProvider,
        resolveCreateConfig: vi.fn(async () => ({})),
      } as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });
    const spec: JsonObject = {
      bindings: {
        worktree: process.cwd(),
        agents: { worker: "agent-existing" },
      },
      workspace: { createWorktree: { cwd: process.cwd() } },
      agents: {
        worker: {
          createAgent: { provider: "unavailable-child-fallback" },
        },
      },
      flows: {
        main: {
          states: {
            launch: { call: { flow: "child" } },
          },
        },
        child: {
          states: {
            work: { turn: { agent: "worker" } },
          },
        },
      },
    };

    await expect(adapter.validateMaterializedSpec(spec, {})).rejects.toThrow(
      "child fallback provider is unavailable",
    );
    expect(getProvider).toHaveBeenCalledOnce();
  });

  it.each(["codex/", "/gpt-5.4"])(
    "rejects a provider/model value with an empty segment: %s",
    async (provider) => {
      const getProvider = vi.fn(async () => ({ status: "ready", models: [] }));
      const adapter = new PaseoWorkflowRuntimeAdapter({
        agentManager: {} as never,
        agentStorage: {} as never,
        providerSnapshotManager: {
          getProvider,
          resolveCreateConfig: vi.fn(async () => ({})),
        } as never,
        workspaceRegistry: {} as never,
        createAgent: (() => undefined) as never,
        createPaseoWorktree: (() => undefined) as never,
        logger: {} as never,
      });
      const spec: JsonObject = {
        bindings: { worktree: process.cwd(), agents: {} },
        workspace: { createWorktree: { cwd: process.cwd() } },
        agents: {
          worker: {
            createAgent: { provider },
          },
        },
      };

      await expect(adapter.validateMaterializedSpec(spec, {})).rejects.toThrow(
        "provider and model must both be non-empty",
      );
      expect(getProvider).not.toHaveBeenCalled();
    },
  );

  it("normalizes validated mode and thinking aliases before creating an agent", async () => {
    const createAgent = vi.fn(async () => ({ snapshot: { id: "agent-created" } }));
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {} as never,
      agentStorage: { list: vi.fn(async () => []) } as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: createAgent as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.ensureAgent({
        runId: "run-settings",
        workflowName: "settings-workflow",
        instanceId: "root",
        flow: "main",
        role: "worker",
        agentKey: "worker",
        create: {
          title: "Workflow worker",
          provider: "codex",
          settings: { mode: "plan", thinking: "high" },
        },
        workspace: {
          workspaceId: "workspace-1",
          cwd: process.cwd(),
          name: "Workspace",
        },
        existingAgentId: null,
      }),
    ).resolves.toBe("agent-created");
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          modeId: "plan",
          thinkingOptionId: "high",
        }),
      }),
    );
  });
});
