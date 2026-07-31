import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowRunSummary } from "@getpaseo/protocol/workflow/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowRuntimeAdapter,
  WorkflowTurnHandle,
  WorkflowTurnReconciliation,
  WorkflowTurnRequest,
  WorkflowTurnResult,
} from "./runtime-adapter.js";
import { WorkflowService } from "./service.js";
import type { JsonObject, WorkflowCallerContext } from "./spec.js";
import type { WorkflowWorkspace } from "./state.js";
import { WorkflowStorage, type WorkflowStorageOptions } from "./storage.js";

const roots: string[] = [];

interface PendingTurn {
  request: WorkflowTurnRequest;
  nativeTurnId: string;
  resolve: (result: WorkflowTurnResult) => void;
  result: Promise<WorkflowTurnResult>;
}

class FakeRuntimeAdapter implements WorkflowRuntimeAdapter {
  readonly starts: PendingTurn[] = [];
  readonly prompts: string[] = [];
  readonly externalEffects: string[] = [];
  readonly agentCreates: Array<{ instanceId: string; role: string; agentId: string }> = [];
  readonly workspaceCreates: string[] = [];
  readonly idleWaits: string[] = [];
  readonly reconciliations: Array<{
    agentId: string;
    nativeTurnId: string | null;
  }> = [];
  validationCalls = 0;
  validateGate: Promise<void> = Promise.resolve();
  workspaceGate: Promise<void> = Promise.resolve();
  ensureGate: Promise<void> = Promise.resolve();
  idleGate: Promise<void> = Promise.resolve();
  pauseAfterNativeSubmission = false;
  workspaceFailure: { instanceId: string; afterStarts: number; message: string } | null = null;
  concurrentStartRejections = 0;
  maxActive = 0;
  private active = new Map<string, PendingTurn>();
  private nextAgent = 1;
  private nextTurn = 1;
  private waiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private agentIdleWaiters = new Map<string, Array<() => void>>();
  private reconciliationWaiters: Array<() => void> = [];
  private validationWaiters: Array<() => void> = [];
  private workspaceWaiters: Array<() => void> = [];
  private agentCreateWaiters: Array<() => void> = [];

  async resolveCallerContext(input: {
    workspaceId?: string;
    agentId?: string;
  }): Promise<WorkflowCallerContext> {
    return {
      workspaceId: input.workspaceId,
      worktreePath: input.workspaceId ? "/repo" : undefined,
      agentId: input.agentId,
    };
  }

  async validateMaterializedSpec(): Promise<void> {
    this.validationCalls += 1;
    for (const resolve of this.validationWaiters.splice(0)) resolve();
    await this.validateGate;
  }

  async ensureWorkspace(input: {
    instanceId: string;
    create: JsonObject;
  }): Promise<WorkflowWorkspace> {
    this.workspaceCreates.push(input.instanceId);
    for (const resolve of this.workspaceWaiters.splice(0)) resolve();
    await this.workspaceGate;
    if (this.workspaceFailure?.instanceId === input.instanceId) {
      await this.waitForStarts(this.workspaceFailure.afterStarts);
      throw new Error(this.workspaceFailure.message);
    }
    return {
      workspaceId: `workspace-${input.instanceId}`,
      cwd: String(input.create.cwd ?? "/repo"),
      branch: `branch-${input.instanceId}`,
    };
  }

  async resolveBoundWorkspace(input: {
    workspaceId: string;
    worktreePath: string;
  }): Promise<WorkflowWorkspace> {
    return { workspaceId: input.workspaceId, cwd: input.worktreePath };
  }

  async ensureAgent(input: {
    instanceId: string;
    role: string;
    agentKey: string;
    existingAgentId: string | null;
  }): Promise<string> {
    if (input.existingAgentId) return input.existingAgentId;
    const agentId = `agent-${this.nextAgent++}`;
    this.agentCreates.push({ instanceId: input.instanceId, role: input.role, agentId });
    for (const resolve of this.agentCreateWaiters.splice(0)) resolve();
    await this.ensureGate;
    return agentId;
  }

  async waitUntilAgentIdle(agentId: string): Promise<void> {
    this.idleWaits.push(agentId);
    this.flushIdleWaiters();
    await this.idleGate;
    while (this.active.has(agentId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.agentIdleWaiters.get(agentId) ?? [];
        waiters.push(resolve);
        this.agentIdleWaiters.set(agentId, waiters);
      });
    }
  }

  startTurn(request: WorkflowTurnRequest): WorkflowTurnHandle {
    if (this.active.has(request.agentId)) {
      this.concurrentStartRejections += 1;
      return {
        nativeTurnId: Promise.resolve(null),
        result: Promise.resolve({
          agentId: request.agentId,
          nativeTurnId: null,
          status: "failed",
          lastMessage: "",
          lastError: "native agent already has an active turn",
        }),
      };
    }
    const nativeTurnId = `native-turn-${this.nextTurn++}`;
    let resolve!: (result: WorkflowTurnResult) => void;
    const result = new Promise<WorkflowTurnResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const pending = { request, nativeTurnId, resolve, result };
    this.starts.push(pending);
    this.prompts.push(request.prompt);
    this.externalEffects.push(request.clientMessageId);
    this.active.set(request.agentId, pending);
    this.maxActive = Math.max(this.maxActive, this.active.size);
    if (this.pauseAfterNativeSubmission) {
      this.flushWaiters();
      return {
        nativeTurnId: new Promise<string | null>(() => undefined),
        result,
      };
    }
    this.flushWaiters();
    return { nativeTurnId: Promise.resolve(nativeTurnId), result };
  }

  async reconcileTurn(input: {
    agentId: string;
    nativeTurnId: string | null;
  }): Promise<WorkflowTurnReconciliation> {
    this.reconciliations.push(input);
    this.flushReconciliationWaiters();
    const pending = this.active.get(input.agentId);
    if (!pending) return { state: "missing" };
    return {
      state: "active",
      nativeTurnId: pending.nativeTurnId,
      result: pending.result,
    };
  }

  getActiveTurnId(agentId: string): string | null {
    return this.active.get(agentId)?.nativeTurnId ?? null;
  }

  getActiveTurnClientMessageId(agentId: string): string | null {
    return this.active.get(agentId)?.request.clientMessageId ?? null;
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.starts.length >= count) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.starts.length < count) await this.waitForStarts(count);
  }

  async waitForIdleWaits(count: number): Promise<void> {
    if (this.idleWaits.length >= count) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    if (this.idleWaits.length < count) await this.waitForIdleWaits(count);
  }

  async waitForReconciliations(count: number): Promise<void> {
    if (this.reconciliations.length >= count) return;
    await new Promise<void>((resolve) => this.reconciliationWaiters.push(resolve));
    if (this.reconciliations.length < count) await this.waitForReconciliations(count);
  }

  async waitForValidations(count: number): Promise<void> {
    if (this.validationCalls >= count) return;
    await new Promise<void>((resolve) => this.validationWaiters.push(resolve));
    if (this.validationCalls < count) await this.waitForValidations(count);
  }

  async waitForWorkspaceCreates(count: number): Promise<void> {
    if (this.workspaceCreates.length >= count) return;
    await new Promise<void>((resolve) => this.workspaceWaiters.push(resolve));
    if (this.workspaceCreates.length < count) await this.waitForWorkspaceCreates(count);
  }

  async waitForAgentCreates(count: number): Promise<void> {
    if (this.agentCreates.length >= count) return;
    await new Promise<void>((resolve) => this.agentCreateWaiters.push(resolve));
    if (this.agentCreates.length < count) await this.waitForAgentCreates(count);
  }

  complete(agentId: string, status: WorkflowTurnResult["status"] = "completed"): void {
    const pending = this.active.get(agentId);
    if (!pending) throw new Error(`no active turn for ${agentId}`);
    this.active.delete(agentId);
    for (const resolve of this.agentIdleWaiters.get(agentId) ?? []) resolve();
    this.agentIdleWaiters.delete(agentId);
    pending.resolve({
      agentId,
      nativeTurnId: pending.nativeTurnId,
      status,
      lastMessage: status === "completed" ? "finished" : "failed",
      lastError: status === "completed" ? null : "controlled failure",
    });
  }

  adopt(request: WorkflowTurnRequest, nativeTurnId: string): void {
    let resolve!: (result: WorkflowTurnResult) => void;
    const result = new Promise<WorkflowTurnResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.active.set(request.agentId, { request, nativeTurnId, resolve, result });
  }

  replaceActiveNativeTurnId(agentId: string, nativeTurnId: string): void {
    const pending = this.active.get(agentId);
    if (!pending) throw new Error(`no active turn for ${agentId}`);
    pending.nativeTurnId = nativeTurnId;
  }

  replaceActiveClientMessageId(agentId: string, clientMessageId: string): void {
    const pending = this.active.get(agentId);
    if (!pending) throw new Error(`no active turn for ${agentId}`);
    pending.request.clientMessageId = clientMessageId;
  }

  private flushWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private flushIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private flushReconciliationWaiters(): void {
    for (const resolve of this.reconciliationWaiters.splice(0)) resolve();
  }
}

class ReadHookWorkflowStorage extends WorkflowStorage {
  private readHook:
    | {
        predicate: (state: JsonObject) => boolean;
        callback: () => void | Promise<void>;
      }
    | undefined;

  armReadHook(
    predicate: (state: JsonObject) => boolean,
    callback: () => void | Promise<void>,
  ): void {
    this.readHook = { predicate, callback };
  }

  override async readState(runId: string): Promise<JsonObject> {
    const state = await super.readState(runId);
    const hook = this.readHook;
    if (!hook || !hook.predicate(state)) return state;
    this.readHook = undefined;
    await hook.callback();
    return state;
  }
}

class CountingReadHookWorkflowStorage extends ReadHookWorkflowStorage {
  inspectRunCalls = 0;
  readRenderedPromptCalls = 0;

  override async inspectRun(runId: string) {
    this.inspectRunCalls += 1;
    return super.inspectRun(runId);
  }

  override async readRenderedPrompt(runId: string, name: string) {
    this.readRenderedPromptCalls += 1;
    return super.readRenderedPrompt(runId, name);
  }
}

async function setup(spec: JsonObject): Promise<{
  service: WorkflowService;
  storage: WorkflowStorage;
  adapter: FakeRuntimeAdapter;
}>;
async function setup<TStorage extends WorkflowStorage>(
  spec: JsonObject,
  createStorage: (options: WorkflowStorageOptions) => TStorage,
): Promise<{
  service: WorkflowService;
  storage: TStorage;
  adapter: FakeRuntimeAdapter;
}>;
async function setup<TStorage extends WorkflowStorage = WorkflowStorage>(
  spec: JsonObject,
  createStorage?: (options: WorkflowStorageOptions) => TStorage,
): Promise<{
  service: WorkflowService;
  storage: TStorage;
  adapter: FakeRuntimeAdapter;
}> {
  const paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-service-"));
  roots.push(paseoHome);
  const builtIns = path.join(paseoHome, "built-ins");
  await fs.mkdir(builtIns);
  await fs.writeFile(path.join(builtIns, `${String(spec.name)}.json`), JSON.stringify(spec));
  const storage = createStorage
    ? createStorage({ paseoHome, builtInDirectory: builtIns })
    : (new WorkflowStorage({ paseoHome, builtInDirectory: builtIns }) as TStorage);
  const adapter = new FakeRuntimeAdapter();
  const service = new WorkflowService({ storage, adapter });
  await service.initialize();
  await service.start();
  return { service, storage, adapter };
}

async function waitForRunTerminal(
  service: WorkflowService,
  runId: string,
  timeoutMs = 10_000,
): Promise<WorkflowRunSummary> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await service.inspectRun(runId);
    if (["stopped", "complete", "failed"].includes(run.run.status)) return run.run;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for workflow run ${runId}`);
}

async function waitForRunStatus(
  service: WorkflowService,
  runId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<WorkflowRunSummary> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await service.inspectRun(runId);
    if (statuses.includes(run.run.status)) return run.run;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for workflow run ${runId} status ${statuses.join(", ")}`);
}

async function waitForActiveTurnPhase(
  storage: WorkflowStorage,
  runId: string,
  phase: "provisioning" | "queued" | "launching" | "running",
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const state = await storage.readState(runId);
    const instances = state.instances as JsonObject | undefined;
    const root = instances?.root as JsonObject | undefined;
    const activeTurn = root?.activeTurn as JsonObject | undefined;
    if (activeTurn?.phase === phase) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for workflow turn phase ${phase}`);
}

async function waitForStoredRunStatus(
  storage: WorkflowStorage,
  runId: string,
  status: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if ((await storage.readState(runId)).status === status) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for stored workflow run ${runId} status ${status}`);
}

function baseSpec(): JsonObject {
  return {
    schemaVersion: "paseo.workflows.v0.2",
    name: "runtime-fixture",
    description: "A sanitized runtime fixture",
    parameters: {
      objective: { type: "string", required: true },
      workspace: {
        type: "string",
        required: true,
        defaultFrom: "current.workspace",
      },
      worktree: {
        type: "path",
        required: true,
        defaultFrom: "current.worktree",
      },
    },
    bindings: {
      workspace: "{{ parameters.workspace }}",
      worktree: "{{ parameters.worktree }}",
    },
    workspace: {
      createWorktree: { cwd: "{{ parameters.worktree }}", target: { mode: "branch-off" } },
    },
    agents: {
      worker: {
        persistence: "reuse-agent",
        createAgent: {
          title: "Worker",
          provider: "codex",
          settings: { mode: "default" },
        },
      },
    },
    protocol: { maxAttempts: 2 },
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
                  description: "Completed",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    },
    limits: { maxIterations: 10, maxRuntime: "1h" },
    inputs: { objective: "{{ parameters.objective }}" },
    prompts: { work: "Complete {{ objective }}." },
  };
}

function twoTurnSpec(persistence: "reuse-agent" | "fresh-agent"): JsonObject {
  const spec = baseSpec();
  const agents = spec.agents as JsonObject;
  const worker = agents.worker as JsonObject;
  worker.persistence = persistence;
  const flows = spec.flows as JsonObject;
  const main = flows.main as JsonObject;
  const states = main.states as JsonObject;
  states.work = {
    turn: {
      agent: "worker",
      prompt: "work",
      emits: { revised: { description: "Continue with a handoff" } },
    },
    on: { revised: "review", "error.agent": "failed", "error.protocol": "failed" },
  };
  states.review = {
    turn: {
      agent: "worker",
      prompt: "review",
      emits: { done: { description: "Finish" } },
    },
    on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
  };
  (spec.prompts as JsonObject).review = "Review handoff: {{ event.message }}";
  return spec;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkflowService runtime", () => {
  it("reads only the rendered prompt needed to launch a turn", async () => {
    let releaseValidation!: () => void;
    const { service, storage, adapter } = await setup(
      baseSpec(),
      (options) => new CountingReadHookWorkflowStorage(options),
    );
    adapter.validateGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Read one prompt" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForValidations(1);
    const inspectCallsBeforeLaunch = storage.inspectRunCalls;

    releaseValidation();
    await adapter.waitForStarts(1);

    expect(storage.inspectRunCalls).toBe(inspectCallsBeforeLaunch);
    expect(storage.readRenderedPromptCalls).toBe(1);
    expect(adapter.starts[0].request.prompt).toContain("Complete Read one prompt.");
    await service.emitEvent({
      callerAgentId: adapter.starts[0].request.agentId,
      event: "done",
      data: { value: "complete" },
    });
    adapter.complete(adapter.starts[0].request.agentId);
    await waitForStoredRunStatus(storage, run.id, "complete");
    service.dispose();
  });

  it("retains a resume kick while the current driver is exiting", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { service, storage, adapter } = await setup(
      twoTurnSpec("reuse-agent"),
      (options) => new ReadHookWorkflowStorage(options),
    );
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Do not lose the next turn" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, run.id, "running");
    const first = adapter.starts[0];
    const runtimeTimer = setTimeoutSpy.mock.calls
      .toReversed()
      .find((call) => typeof call[1] === "number" && call[1] > 3_000_000)?.[0];
    expect(runtimeTimer).toBeTypeOf("function");

    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopping" });
    await service.emitEvent({
      callerAgentId: first.request.agentId,
      event: "revised",
      message: "launch the second turn",
    });
    adapter.complete(first.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
    });

    storage.armReadHook(
      (state) => state.status === "stopped",
      () => service.resumeRun(run.id),
    );
    (runtimeTimer as () => void)();

    const started = Date.now();
    while (adapter.starts.length < 2 && Date.now() - started < 1_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(adapter.starts).toHaveLength(2);
    const second = adapter.starts[1];
    await service.emitEvent({
      callerAgentId: second.request.agentId,
      event: "done",
      data: { value: "complete" },
    });
    adapter.complete(second.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("does not create the root workspace after stop during materialized validation", async () => {
    const spec = baseSpec();
    spec.bindings = {};
    const { service, adapter } = await setup(spec);
    let releaseValidation!: () => void;
    adapter.validateGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Stop before root creation" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForValidations(1);

    await expect(service.stopRun(run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
    });
    releaseValidation();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(adapter.workspaceCreates).toHaveLength(0);
    const details = await service.inspectRun(run.id);
    expect(details.run).toMatchObject({ status: "stopped", reason: "requested" });
    expect(details.events.filter((event) => event.type === "workspace_ready")).toHaveLength(0);
  });

  it("drains agent provisioning, records its identity, and reuses it after stop and resume", async () => {
    const spec = baseSpec();
    const worker = (spec.agents as JsonObject).worker as JsonObject;
    worker.persistence = "fresh-agent";
    const { service, storage, adapter } = await setup(spec);
    let releaseEnsure!: () => void;
    adapter.ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Reuse provisioned identity" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForAgentCreates(1);
    const agentId = adapter.agentCreates[0].agentId;

    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopping" });
    expect(adapter.starts).toHaveLength(0);
    releaseEnsure();
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
      agentIds: [agentId],
    });
    const stopped = await service.inspectRun(run.id);
    expect(stopped.events).toContainEqual(
      expect.objectContaining({
        type: "agent_ready",
        agentId,
        details: expect.objectContaining({
          workflowTurnId: expect.any(String),
        }),
      }),
    );
    expect(stopped.events).toContainEqual(
      expect.objectContaining({
        type: "turn_not_started",
        agentId,
        details: expect.objectContaining({ reason: "stop_requested" }),
      }),
    );
    expect(adapter.starts).toHaveLength(0);

    await service.resumeRun(run.id);
    await adapter.waitForStarts(1);
    expect(adapter.agentCreates).toHaveLength(1);
    expect(adapter.starts[0].request.agentId).toBe(agentId);
    await service.emitEvent({
      callerAgentId: agentId,
      event: "done",
      data: { value: "complete" },
    });
    adapter.complete(agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
    expect((await storage.readState(run.id)).status).toBe("complete");
  });

  it("applies a runtime deadline while native workspace provisioning is blocked", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const spec = baseSpec();
    spec.bindings = {};
    let releaseWorkspace!: () => void;
    const { service, storage, adapter } = await setup(spec);
    adapter.workspaceGate = new Promise<void>((resolve) => {
      releaseWorkspace = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Bound blocked provisioning" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForWorkspaceCreates(1);
    const runtimeTimer = setTimeoutSpy.mock.calls
      .toReversed()
      .find((call) => typeof call[1] === "number" && call[1] > 3_000_000)?.[0];
    expect(runtimeTimer).toBeTypeOf("function");

    const state = await storage.readState(run.id);
    state.startedAt = new Date(0).toISOString();
    await storage.commitRunTransaction(run.id, { state, events: [] });
    (runtimeTimer as () => void)();
    (runtimeTimer as () => void)();

    await expect(waitForRunStatus(service, run.id, ["stopped"], 1_000)).resolves.toMatchObject({
      reason: "max_runtime",
    });
    const limited = await service.inspectRun(run.id);
    expect(limited.events.filter((event) => event.type === "limit_reached")).toHaveLength(1);
    expect(limited.events.filter((event) => event.type === "run_stopped")).toHaveLength(1);

    releaseWorkspace();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const settled = await service.inspectRun(run.id);
    expect(adapter.starts).toHaveLength(0);
    expect(settled.events.filter((event) => event.type === "workspace_ready")).toHaveLength(0);
  });

  it("evicts a stopped run spec and reloads it when the run resumes", async () => {
    const spec = baseSpec();
    spec.bindings = {};
    const main = (spec.flows as JsonObject).main as JsonObject;
    main.initial = "finish";
    main.states = { finish: { return: { output: "resumed" } } };
    const { service, storage, adapter } = await setup(
      spec,
      (options) => new CountingReadHookWorkflowStorage(options),
    );
    let releaseValidation!: () => void;
    adapter.validateGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Reload the durable materialized spec" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForValidations(1);
    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopped" });

    let observedTerminalRead!: () => void;
    const terminalRead = new Promise<void>((resolve) => {
      observedTerminalRead = resolve;
    });
    storage.armReadHook((state) => state.status === "stopped", observedTerminalRead);
    releaseValidation();
    await terminalRead;
    await Promise.resolve();
    await Promise.resolve();

    const inspectCallsBeforeResume = storage.inspectRunCalls;
    await service.resumeRun(run.id);
    await waitForStoredRunStatus(storage, run.id, "complete");
    expect(storage.inspectRunCalls - inspectCallsBeforeResume).toBe(3);
    expect(adapter.starts).toHaveLength(0);
  });

  it("queues caller reuse immediately and waits for the invoking turn to become idle", async () => {
    const spec = baseSpec();
    (spec.parameters as JsonObject).workerThreadRef = {
      type: "string",
      required: true,
      defaultFrom: "current.agent",
    };
    (spec.bindings as JsonObject).agents = {
      worker: "{{ parameters.workerThreadRef }}",
    };
    const { service, adapter } = await setup(spec);
    let releaseIdle!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });

    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Continue this native thread" },
      context: { workspaceId: "workspace-root", agentId: "agent-caller" },
    });
    expect(run.status).toBe("queued");
    await adapter.waitForIdleWaits(1);
    expect(adapter.idleWaits).toEqual(["agent-caller"]);
    expect(adapter.starts).toHaveLength(0);

    releaseIdle();
    await adapter.waitForStarts(1);
    const turn = adapter.starts[0];
    expect(turn?.request.agentId).toBe("agent-caller");
    await service.emitEvent({
      callerAgentId: "agent-caller",
      event: "done",
      message: "caller thread continued",
      data: { value: "complete" },
    });
    adapter.complete("agent-caller");
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("routes a shared agent event to its foreground native turn while another run waits", async () => {
    const spec = baseSpec();
    (spec.parameters as JsonObject).workerThreadRef = {
      type: "string",
      required: true,
      defaultFrom: "current.agent",
    };
    (spec.bindings as JsonObject).agents = {
      worker: "{{ parameters.workerThreadRef }}",
    };
    const { service, storage, adapter } = await setup(spec);
    const context = { workspaceId: "workspace-root", agentId: "agent-shared" };
    const first = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Finish the foreground run" },
      context,
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, first.id, "running");

    let releaseWaitingRun!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseWaitingRun = resolve;
    });
    const second = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Wait for the shared agent" },
      context,
    });
    await adapter.waitForIdleWaits(2);
    await waitForActiveTurnPhase(storage, second.id, "queued");

    await service.emitEvent({
      callerAgentId: "agent-shared",
      event: "done",
      message: "the foreground turn finished",
      data: { value: "first" },
    });
    expect((await service.inspectRun(first.id)).events).toContainEqual(
      expect.objectContaining({ type: "event_accepted", event: "done" }),
    );
    expect((await service.inspectRun(second.id)).events).not.toContainEqual(
      expect.objectContaining({ type: "event_accepted" }),
    );
    adapter.complete("agent-shared");
    await expect(waitForRunTerminal(service, first.id)).resolves.toMatchObject({
      status: "complete",
    });

    releaseWaitingRun();
    await adapter.waitForStarts(2);
    await service.emitEvent({
      callerAgentId: "agent-shared",
      event: "done",
      message: "the waiting run continued",
      data: { value: "second" },
    });
    adapter.complete("agent-shared");
    await expect(waitForRunTerminal(service, second.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("serializes the idle check and native submission for a shared agent", async () => {
    const spec = baseSpec();
    (spec.parameters as JsonObject).workerThreadRef = {
      type: "string",
      required: true,
      defaultFrom: "current.agent",
    };
    (spec.bindings as JsonObject).agents = {
      worker: "{{ parameters.workerThreadRef }}",
    };
    const { service, adapter } = await setup(spec);
    const context = { workspaceId: "workspace-root", agentId: "agent-shared" };
    let releaseIdle!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });

    const first = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "First shared turn" },
      context,
    });
    const second = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Second shared turn" },
      context,
    });
    await adapter.waitForIdleWaits(2);
    releaseIdle();
    await adapter.waitForStarts(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(adapter.concurrentStartRejections).toBe(0);
    expect(adapter.starts).toHaveLength(1);
    const firstTurn = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: firstTurn.request.agentId,
      event: "done",
      message: "first finished",
      data: { value: "first" },
    });
    adapter.complete(firstTurn.request.agentId);

    await adapter.waitForStarts(2);
    const secondTurn = adapter.starts[1];
    expect(secondTurn.request.runId).not.toBe(firstTurn.request.runId);
    await service.emitEvent({
      callerAgentId: secondTurn.request.agentId,
      event: "done",
      message: "second finished",
      data: { value: "second" },
    });
    adapter.complete(secondTurn.request.agentId);

    await expect(waitForRunTerminal(service, first.id)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(waitForRunTerminal(service, second.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("does not authorize a launching workflow from an unrelated native client message", async () => {
    const { service, storage, adapter } = await setup(baseSpec());
    adapter.pauseAfterNativeSubmission = true;
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Authorize the exact native request" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, run.id, "launching");
    const turn = adapter.starts[0];
    adapter.replaceActiveClientMessageId(turn.request.agentId, "unrelated-client-message");

    await expect(
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "from another native turn",
        data: { value: "wrong" },
      }),
    ).rejects.toThrow("does not own the active native turn");
    expect((await service.inspectRun(run.id)).events).not.toContainEqual(
      expect.objectContaining({ type: "event_accepted" }),
    );
    service.dispose();
  });

  it("cancels a queued native turn without waiting for an unrelated agent to become idle", async () => {
    const spec = baseSpec();
    spec.limits = { maxIterations: 1, maxRuntime: "1h" };
    const { service, adapter } = await setup(spec);
    let releaseIdle!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Stop before submission" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForIdleWaits(1);

    await expect(service.stopRun(run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
      resumable: true,
    });
    await expect(service.inspectRun(run.id)).resolves.toMatchObject({
      run: { iteration: 0 },
    });
    expect(adapter.starts).toHaveLength(0);
    expect(adapter.externalEffects).toHaveLength(0);
    const details = await service.inspectRun(run.id);
    expect(details.events.find((event) => event.type === "turn_not_started")).toMatchObject({
      details: { reason: "stop_requested" },
    });

    await service.resumeRun(run.id);
    await adapter.waitForIdleWaits(2);
    releaseIdle();
    await adapter.waitForStarts(1);
    const resumed = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: resumed.request.agentId,
      event: "done",
      message: "completed after resume",
      data: { value: "resumed" },
    });
    adapter.complete(resumed.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("lets a reserved queued turn run when another map child reaches max iterations", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["one", "two"] };
    workflow.limits = { maxIterations: 1, maxRuntime: "1h" };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: { flow: "child", with: { value: "{{ item }}" } },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: { done: { description: "Child completed" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ inputs.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    let releaseIdle!: () => void;
    adapter.idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForIdleWaits(1);
    await waitForRunStatus(service, run.id, ["stopping", "stopped"]);

    await expect(service.inspectRun(run.id)).resolves.toMatchObject({
      run: {
        status: "stopping",
        reason: "max_iterations",
        iteration: 1,
        activeTurns: 1,
      },
    });
    expect(adapter.starts).toHaveLength(0);

    releaseIdle();
    await adapter.waitForStarts(1);
    const reserved = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: reserved.request.agentId,
      event: "done",
      message: "completed inside the reservation budget",
    });
    adapter.complete(reserved.request.agentId);

    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_iterations",
    });
    expect(adapter.starts).toHaveLength(1);
  });

  it("lets a reserved provisioning turn run when another map child reaches max iterations", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["one", "two"] };
    workflow.limits = { maxIterations: 1, maxRuntime: "1h" };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: { flow: "child", with: { value: "{{ item }}" } },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: { done: { description: "Child completed" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ inputs.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    let releaseEnsure!: () => void;
    adapter.ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForAgentCreates(1);
    await waitForRunStatus(service, run.id, ["stopping", "stopped"]);

    await expect(service.inspectRun(run.id)).resolves.toMatchObject({
      run: {
        status: "stopping",
        reason: "max_iterations",
        iteration: 1,
        activeTurns: 1,
      },
    });
    expect(adapter.starts).toHaveLength(0);

    releaseEnsure();
    await adapter.waitForStarts(1);
    const reserved = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: reserved.request.agentId,
      event: "done",
      message: "completed after provisioning inside the reservation budget",
    });
    adapter.complete(reserved.request.agentId);

    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_iterations",
    });
    expect(adapter.starts).toHaveLength(1);
  });

  it("accepts immediately, authorizes the active native turn, validates data, and routes by tool event", async () => {
    const { service, adapter } = await setup(baseSpec());
    let releaseValidation!: () => void;
    adapter.validateGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });

    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Verify the native runtime" },
      context: { workspaceId: "workspace-root" },
    });
    expect(run.status).toBe("queued");
    expect(adapter.starts).toHaveLength(0);

    releaseValidation();
    await adapter.waitForStarts(1);
    const turn = adapter.starts[0];
    await expect(
      service.emitEvent({
        callerAgentId: "wrong-agent",
        event: "done",
        message: "not authorized",
        data: { value: "wrong" },
      }),
    ).rejects.toThrow("not an active workflow turn");
    await expect(
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "invalid",
        data: {},
      }),
    ).rejects.toThrow("event data");
    const originalNativeTurnId = turn.nativeTurnId;
    adapter.replaceActiveNativeTurnId(turn.request.agentId, "native-turn-stale");
    await expect(
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "stale",
        data: { value: "stale" },
      }),
    ).rejects.toThrow("does not own the active native turn");
    adapter.replaceActiveNativeTurnId(turn.request.agentId, originalNativeTurnId);

    const concurrent = await Promise.allSettled([
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "handoff",
        data: { value: "ordered result" },
      }),
      service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "replay",
        data: { value: "ordered result" },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    adapter.complete(turn.request.agentId);

    const finished = await waitForRunTerminal(service, run.id);
    expect(finished).toMatchObject({ status: "complete", reason: "returned" });
    const details = await service.inspectRun(run.id);
    expect(details.state.result).toBe("ordered result");
    expect(details.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn_started",
        "event_accepted",
        "state_transition",
        "run_completed",
      ]),
    );
    expect(details.prompts[0].content).toContain("call `emit_event` exactly once");
  });

  it("uses same-agent repair when prose ends without an event", async () => {
    const { service, adapter } = await setup(baseSpec());
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Repair routing" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    const first = adapter.starts[0];
    adapter.complete(first.request.agentId);
    await adapter.waitForStarts(2);
    const repair = adapter.starts[1];
    expect(repair.request.agentId).toBe(first.request.agentId);
    expect(repair.request.prompt).toContain("could not be routed");
    await service.emitEvent({
      callerAgentId: repair.request.agentId,
      event: "done",
      message: "repaired",
      data: { value: "done" },
    });
    adapter.complete(repair.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("routes exhausted repair and native agent failures through explicit runtime routes", async () => {
    const protocolCase = await setup(baseSpec());
    const protocolRun = await protocolCase.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Exhaust repair" },
      context: { workspaceId: "workspace-root" },
    });
    await protocolCase.adapter.waitForStarts(1);
    protocolCase.adapter.complete(protocolCase.adapter.starts[0].request.agentId);
    await protocolCase.adapter.waitForStarts(2);
    protocolCase.adapter.complete(protocolCase.adapter.starts[1].request.agentId);
    await expect(waitForRunTerminal(protocolCase.service, protocolRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: expect.stringContaining("without one allowed workflow event"),
    });

    const agentCase = await setup(baseSpec());
    const agentRun = await agentCase.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Route failure" },
      context: { workspaceId: "workspace-root" },
    });
    await agentCase.adapter.waitForStarts(1);
    agentCase.adapter.complete(agentCase.adapter.starts[0].request.agentId, "failed");
    await expect(waitForRunTerminal(agentCase.service, agentRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: "controlled failure",
    });
  });

  it("preserves event.message handoff while honoring reuse-agent and fresh-agent declarations", async () => {
    for (const [persistence, expectedCreates] of [
      ["reuse-agent", 1],
      ["fresh-agent", 2],
    ] as const) {
      const { service, adapter } = await setup(twoTurnSpec(persistence));
      const run = await service.startRun({
        workflowId: "runtime-fixture",
        parameters: { objective: persistence },
        context: { workspaceId: "workspace-root" },
      });
      await adapter.waitForStarts(1);
      const first = adapter.starts[0];
      await service.emitEvent({
        callerAgentId: first.request.agentId,
        event: "revised",
        message: "review this exact handoff",
      });
      adapter.complete(first.request.agentId);
      await adapter.waitForStarts(2);
      const second = adapter.starts[1];
      expect(second.request.prompt).toContain("review this exact handoff");
      if (persistence === "reuse-agent") {
        expect(second.request.agentId).toBe(first.request.agentId);
      } else {
        expect(second.request.agentId).not.toBe(first.request.agentId);
      }
      await service.emitEvent({
        callerAgentId: second.request.agentId,
        event: "done",
        message: "complete",
        data: { value: "done" },
      });
      adapter.complete(second.request.agentId);
      await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
        status: "complete",
      });
      expect(adapter.agentCreates).toHaveLength(expectedCreates);
    }
  });

  it("runs bounded maps concurrently and gathers results in input order", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["first", "second", "third"] };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: {
                flow: "child",
                with: { value: "{{ item }}" },
                workspace: {
                  createWorktree: {
                    cwd: "/repo",
                    name: "child-{{ task.index }}",
                    target: { mode: "branch-off", base: "main" },
                  },
                },
              },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: {
                done: {
                  description: "Completed child",
                  dataSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                  },
                },
              },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ event.data.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(2);
    expect(adapter.maxActive).toBe(2);
    expect(adapter.workspaceCreates).toHaveLength(2);

    const second = adapter.starts[1];
    await service.emitEvent({
      callerAgentId: second.request.agentId,
      event: "done",
      message: "second first",
      data: { value: "SECOND" },
    });
    adapter.complete(second.request.agentId);
    await adapter.waitForStarts(3);
    expect(adapter.maxActive).toBe(2);

    const first = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: first.request.agentId,
      event: "done",
      message: "first second",
      data: { value: "FIRST" },
    });
    adapter.complete(first.request.agentId);
    const third = adapter.starts[2];
    await service.emitEvent({
      callerAgentId: third.request.agentId,
      event: "done",
      message: "third",
      data: { value: "THIRD" },
    });
    adapter.complete(third.request.agentId);

    await waitForRunTerminal(service, run.id);
    expect(adapter.workspaceCreates).toHaveLength(3);
    const details = await service.inspectRun(run.id);
    const result = details.state.result as Array<{ index: number; output: string }>;
    expect(result.map(({ index, output }) => ({ index, output }))).toEqual([
      { index: 0, output: "FIRST" },
      { index: 1, output: "SECOND" },
      { index: 2, output: "THIRD" },
    ]);
  });

  it("drains active map turns before finalizing a provisioning failure", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["active", "provisioning-error"] };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: {
                flow: "child",
                with: { value: "{{ item }}" },
                workspace: {
                  createWorktree: {
                    cwd: "/repo",
                    target: { mode: "branch-off", base: "main" },
                  },
                },
              },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: { done: { description: "Child completed" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ inputs.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, storage, adapter } = await setup(workflow);
    adapter.workspaceFailure = {
      instanceId: "i2",
      afterStarts: 1,
      message: "controlled provisioning failure",
    };
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });

    await adapter.waitForStarts(1);
    await expect(waitForRunStatus(service, run.id, ["stopping", "failed"])).resolves.toMatchObject({
      status: "stopping",
      reason: "controlled provisioning failure",
    });
    const draining = await service.inspectRun(run.id);
    expect(draining.state).toMatchObject({
      pendingTerminal: { status: "failed", reason: "controlled provisioning failure" },
    });
    expect(draining.events.filter((event) => event.type === "run_failed")).toHaveLength(0);

    const active = adapter.starts[0];
    service.dispose();
    const restartedAdapter = new FakeRuntimeAdapter();
    restartedAdapter.adopt(active.request, active.nativeTurnId);
    const restartedService = new WorkflowService({ storage, adapter: restartedAdapter });
    await restartedService.initialize();
    await restartedService.start();
    await restartedAdapter.waitForReconciliations(1);
    await restartedService.emitEvent({
      callerAgentId: active.request.agentId,
      event: "done",
      message: "drained after sibling failure",
    });
    restartedAdapter.complete(active.request.agentId);

    await expect(waitForRunTerminal(restartedService, run.id)).resolves.toMatchObject({
      status: "failed",
      reason: "controlled provisioning failure",
    });
    const failed = await restartedService.inspectRun(run.id);
    expect(failed.events.filter((event) => event.type === "event_accepted")).toHaveLength(1);
    expect(failed.events.filter((event) => event.type === "run_failed")).toHaveLength(1);
    expect(failed.events.filter((event) => event.type === "run_stopped")).toHaveLength(0);
    expect(adapter.starts).toHaveLength(1);
    expect(restartedAdapter.starts).toHaveLength(0);
  });

  it("drains active turns on stop, launches nothing new, then resumes remaining map work", async () => {
    const workflow = baseSpec();
    workflow.inputs = { items: ["one", "two", "three"] };
    workflow.flows = {
      main: {
        initial: "fanout",
        states: {
          fanout: {
            map: {
              group: "items",
              items: "{{ inputs.items }}",
              as: "item",
              call: { flow: "child", with: { value: "{{ item }}" } },
              join: "all",
              concurrency: 2,
            },
            on: { joined: "finish" },
          },
          finish: { return: { output: "{{ event.data.results }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
      child: {
        initial: "work",
        inputs: { value: "" },
        states: {
          work: {
            turn: {
              agent: "worker",
              prompt: "child",
              emits: { done: { description: "Child completed" } },
            },
            on: { done: "finish", "error.agent": "failed", "error.protocol": "failed" },
          },
          finish: { return: { output: "{{ inputs.value }}" } },
          failed: { stop: { reason: "{{ event.message }}" } },
        },
      },
    };
    (workflow.prompts as JsonObject).child = "Process {{ inputs.value }}.";
    const { service, adapter } = await setup(workflow);
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "unused" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(2);
    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopping" });
    for (const turn of adapter.starts.slice(0, 2)) {
      await service.emitEvent({
        callerAgentId: turn.request.agentId,
        event: "done",
        message: "drained",
      });
      adapter.complete(turn.request.agentId);
    }
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "requested",
    });
    expect(adapter.starts).toHaveLength(2);

    await service.resumeRun(run.id);
    await adapter.waitForStarts(3);
    const third = adapter.starts[2];
    await service.emitEvent({
      callerAgentId: third.request.agentId,
      event: "done",
      message: "resumed",
    });
    adapter.complete(third.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("does not resume a failed run as if it were gracefully stopped", async () => {
    const { service, storage, adapter } = await setup(baseSpec());
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Fail once" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, run.id, "running");
    service.dispose();
    const failedState = await storage.readState(run.id);
    failedState.status = "failed";
    failedState.reason = "controlled failure";
    await storage.commitRunTransaction(run.id, { state: failedState, events: [] });

    await expect(service.resumeRun(run.id)).rejects.toThrow(
      `failed workflow runs cannot be resumed: ${run.id}`,
    );
    await expect(service.inspectRun(run.id)).resolves.toMatchObject({
      run: { status: "failed", resumable: false },
    });
  });

  it("reconciles a persisted native turn after restart without launching a duplicate", async () => {
    const firstProcess = await setup(baseSpec());
    const run = await firstProcess.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Restart safely" },
      context: { workspaceId: "workspace-root" },
    });
    await firstProcess.adapter.waitForStarts(1);
    await waitForActiveTurnPhase(firstProcess.storage, run.id, "running");
    const active = firstProcess.adapter.starts[0];
    firstProcess.service.dispose();

    const restartedAdapter = new FakeRuntimeAdapter();
    restartedAdapter.adopt(active.request, active.nativeTurnId);
    const restartedService = new WorkflowService({
      storage: firstProcess.storage,
      adapter: restartedAdapter,
    });
    await restartedService.initialize();
    expect(restartedAdapter.reconciliations).toHaveLength(0);
    await restartedService.start();
    await restartedAdapter.waitForReconciliations(1);
    await restartedService.emitEvent({
      callerAgentId: active.request.agentId,
      event: "done",
      message: "continued after restart",
      data: { value: "reconciled" },
    });
    restartedAdapter.complete(active.request.agentId);

    await expect(waitForRunTerminal(restartedService, run.id)).resolves.toMatchObject({
      status: "complete",
      reason: "returned",
    });
    expect(restartedAdapter.starts).toHaveLength(0);
    const details = await restartedService.inspectRun(run.id);
    expect(details.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(details.events.filter((event) => event.type === "event_accepted")).toHaveLength(1);
  });

  it("preserves a canceled native outcome when restart wins the workflow result commit", async () => {
    const firstProcess = await setup(baseSpec());
    const run = await firstProcess.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Recover cancellation" },
      context: { workspaceId: "workspace-root" },
    });
    await firstProcess.adapter.waitForStarts(1);
    await waitForActiveTurnPhase(firstProcess.storage, run.id, "running");
    const active = firstProcess.adapter.starts[0];
    firstProcess.service.dispose();

    const restartedAdapter = new (class extends FakeRuntimeAdapter {
      override async reconcileTurn(): Promise<WorkflowTurnReconciliation> {
        return {
          state: "completed",
          result: {
            agentId: active.request.agentId,
            nativeTurnId: active.nativeTurnId,
            status: "canceled",
            lastMessage: "",
            lastError: null,
          },
        };
      }
    })();
    const restartedService = new WorkflowService({
      storage: firstProcess.storage,
      adapter: restartedAdapter,
    });
    await restartedService.initialize();
    await restartedService.start();

    await expect(waitForRunTerminal(restartedService, run.id)).resolves.toMatchObject({
      status: "complete",
    });
    expect(restartedAdapter.starts).toHaveLength(0);
    const details = await restartedService.inspectRun(run.id);
    expect(details.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    const roles = Object.values(details.state.instances).flatMap((instance) =>
      Object.values(instance.agents),
    );
    expect(roles.flatMap((role) => role.turns)).toEqual([
      expect.objectContaining({
        clientMessageId: active.request.clientMessageId,
        nativeTurnId: active.nativeTurnId,
        status: "canceled",
        emission: expect.objectContaining({
          event: "error.agent",
          data: { status: "canceled" },
        }),
      }),
    ]);
  });

  it("reconciles a native submission that crashed before its turn ID was persisted", async () => {
    const firstProcess = await setup(baseSpec());
    firstProcess.adapter.pauseAfterNativeSubmission = true;
    const run = await firstProcess.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Submit exactly once" },
      context: { workspaceId: "workspace-root" },
    });
    await firstProcess.adapter.waitForStarts(1);
    const submitted = firstProcess.adapter.starts[0];
    const beforeRestart = await firstProcess.storage.readState(run.id);
    expect(beforeRestart.instances).toMatchObject({
      root: {
        activeTurn: {
          clientMessageId: submitted.request.clientMessageId,
          phase: "launching",
          agentId: submitted.request.agentId,
          nativeTurnId: null,
        },
      },
    });
    firstProcess.service.dispose();

    const restartedAdapter = new FakeRuntimeAdapter();
    restartedAdapter.adopt(submitted.request, submitted.nativeTurnId);
    const restartedService = new WorkflowService({
      storage: firstProcess.storage,
      adapter: restartedAdapter,
    });
    await restartedService.initialize();
    await restartedService.start();
    await restartedAdapter.waitForReconciliations(1);
    await restartedService.emitEvent({
      callerAgentId: submitted.request.agentId,
      event: "done",
      message: "continued from the durable native request",
      data: { value: "one side effect" },
    });
    restartedAdapter.complete(submitted.request.agentId);

    await expect(waitForRunTerminal(restartedService, run.id)).resolves.toMatchObject({
      status: "complete",
      reason: "returned",
    });
    expect(firstProcess.adapter.starts).toHaveLength(1);
    expect(restartedAdapter.starts).toHaveLength(0);
    expect([...firstProcess.adapter.prompts, ...restartedAdapter.prompts]).toHaveLength(1);
    expect([...firstProcess.adapter.externalEffects, ...restartedAdapter.externalEffects]).toEqual([
      submitted.request.clientMessageId,
    ]);
    const details = await restartedService.inspectRun(run.id);
    expect(details.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(details.events.filter((event) => event.type === "event_accepted")).toHaveLength(1);
  });

  it("preserves explicit null event data for schema validation and routing", async () => {
    const spec = baseSpec();
    const flows = spec.flows as JsonObject;
    const main = flows.main as JsonObject;
    const states = main.states as JsonObject;
    const work = states.work as JsonObject;
    const turn = work.turn as JsonObject;
    const emits = turn.emits as JsonObject;
    emits.done = {
      description: "Complete with null data",
      dataSchema: { type: "null" },
    };
    states.finish = { return: { output: "accepted explicit null" } };
    const { service, adapter } = await setup(spec);
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Preserve null" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    const active = adapter.starts[0];

    await service.emitEvent({
      callerAgentId: active.request.agentId,
      event: "done",
      message: "null is intentional",
      data: null,
    });
    adapter.complete(active.request.agentId);

    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
    const details = await service.inspectRun(run.id);
    expect(details.events.find((event) => event.type === "event_accepted")).toMatchObject({
      event: "done",
      data: null,
    });
  });

  it("defaults schema-parsed undefined event data without losing the accepted event", async () => {
    const { service, adapter } = await setup(twoTurnSpec("reuse-agent"));
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Default omitted data" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    const active = adapter.starts[0];

    await service.emitEvent({
      callerAgentId: active.request.agentId,
      event: "revised",
      message: "wire validation materialized data as undefined",
      data: undefined,
    });
    adapter.complete(active.request.agentId);

    await adapter.waitForStarts(2);
    const details = await service.inspectRun(run.id);
    expect(details.events.find((event) => event.type === "event_accepted")).toMatchObject({
      event: "revised",
      data: {},
    });
    const finalTurn = adapter.starts[1];
    await service.emitEvent({
      callerAgentId: finalTurn.request.agentId,
      event: "done",
      data: { value: "complete" },
    });
    adapter.complete(finalTurn.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("applies turn and runtime limits without blocking a terminal return", async () => {
    const turnLimitedSpec = twoTurnSpec("reuse-agent");
    turnLimitedSpec.limits = { maxIterations: 1, maxRuntime: "1h" };
    const turnLimited = await setup(turnLimitedSpec);
    const turnRun = await turnLimited.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "One turn only" },
      context: { workspaceId: "workspace-root" },
    });
    await turnLimited.adapter.waitForStarts(1);
    const first = turnLimited.adapter.starts[0];
    await turnLimited.service.emitEvent({
      callerAgentId: first.request.agentId,
      event: "revised",
      message: "would require another turn",
    });
    turnLimited.adapter.complete(first.request.agentId);
    await expect(waitForRunTerminal(turnLimited.service, turnRun.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_iterations",
      resumable: false,
    });
    expect(turnLimited.adapter.starts).toHaveLength(1);
    await expect(turnLimited.service.resumeRun(turnRun.id)).rejects.toThrow(
      `only user-stopped workflow runs can be resumed: ${turnRun.id}`,
    );

    const terminalSpec = baseSpec();
    terminalSpec.limits = { maxIterations: 1, maxRuntime: "1h" };
    const terminal = await setup(terminalSpec);
    const terminalRun = await terminal.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Return after one turn" },
      context: { workspaceId: "workspace-root" },
    });
    await terminal.adapter.waitForStarts(1);
    const only = terminal.adapter.starts[0];
    await terminal.service.emitEvent({
      callerAgentId: only.request.agentId,
      event: "done",
      message: "done",
      data: { value: "terminal" },
    });
    terminal.adapter.complete(only.request.agentId);
    await expect(waitForRunTerminal(terminal.service, terminalRun.id)).resolves.toMatchObject({
      status: "complete",
      reason: "returned",
    });

    const runtime = await setup(baseSpec());
    const runtimeRun = await runtime.service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Runtime bound" },
      context: { workspaceId: "workspace-root" },
    });
    await runtime.adapter.waitForStarts(1);
    await waitForActiveTurnPhase(runtime.storage, runtimeRun.id, "running");
    const runtimeTurn = runtime.adapter.starts[0];
    const state = await runtime.storage.readState(runtimeRun.id);
    state.startedAt = new Date(0).toISOString();
    await runtime.storage.commitRunTransaction(runtimeRun.id, { state, events: [] });
    await runtime.service.emitEvent({
      callerAgentId: runtimeTurn.request.agentId,
      event: "done",
      message: "too late",
      data: { value: "late" },
    });
    runtime.adapter.complete(runtimeTurn.request.agentId);
    await expect(waitForRunTerminal(runtime.service, runtimeRun.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_runtime",
    });
  });

  it("preserves a runtime-limit stop reason when stop is requested again", async () => {
    const { service, storage, adapter } = await setup(baseSpec());
    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Keep the limit reason" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, run.id, "running");
    const state = await storage.readState(run.id);
    state.stopRequested = true;
    state.status = "stopping";
    state.reason = "max_runtime";
    await storage.commitRunTransaction(run.id, { state, events: [] });

    await expect(service.stopRun(run.id)).resolves.toMatchObject({
      status: "stopping",
      reason: "max_runtime",
      resumable: false,
    });

    const turn = adapter.starts[0];
    await service.emitEvent({
      callerAgentId: turn.request.agentId,
      event: "done",
      message: "drained after limit",
      data: { value: "late" },
    });
    adapter.complete(turn.request.agentId);
    await expect(waitForRunTerminal(service, run.id)).resolves.toMatchObject({
      status: "stopped",
      reason: "max_runtime",
      resumable: false,
    });
  });

  it("schedules long runtime limits within Node's maximum timer delay", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const spec = baseSpec();
    spec.limits = { maxIterations: 10, maxRuntime: "25d" };
    const { service, storage, adapter } = await setup(spec);

    const run = await service.startRun({
      workflowId: "runtime-fixture",
      parameters: { objective: "Long-running work" },
      context: { workspaceId: "workspace-root" },
    });
    await adapter.waitForStarts(1);
    await waitForActiveTurnPhase(storage, run.id, "running");
    service.dispose();

    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays).toContain(2_147_483_647);
    expect(delays.every((delay) => delay <= 2_147_483_647)).toBe(true);
  });
});
