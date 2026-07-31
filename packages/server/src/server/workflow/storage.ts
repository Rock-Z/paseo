import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkflowEventRecord,
  WorkflowRenderedPrompt,
  WorkflowRunDetails,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSpecSummary,
} from "@getpaseo/protocol/workflow/types";
import { WorkflowEventRecordSchema } from "@getpaseo/protocol/workflow/types";
import { parse as parseYaml } from "yaml";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";
import { canonicalJson, type JsonObject } from "./json.js";
import { validateWorkflowTemplate } from "./spec.js";

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PENDING_COMMIT_FILE = "pending-commit.json";

export interface WorkflowCommitBoundary {
  step: "journal" | "event" | "state" | "journal-cleanup";
  phase: "before" | "after";
  index?: number;
}

export interface WorkflowRunTransaction {
  state: JsonObject;
  events: WorkflowEventRecord[];
}

export interface WorkflowStorageOptions {
  paseoHome: string;
  builtInDirectory: string;
  commitBoundaryHook?: (boundary: WorkflowCommitBoundary) => void | Promise<void>;
}

export class WorkflowStorage {
  readonly root: string;
  readonly userSpecRoot: string;
  readonly runRoot: string;
  readonly legacyRunRoot: string;
  private readonly builtInDirectory: string;
  private readonly commitBoundaryHook:
    | ((boundary: WorkflowCommitBoundary) => void | Promise<void>)
    | undefined;
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(options: WorkflowStorageOptions) {
    this.root = path.join(options.paseoHome, "workflows");
    this.userSpecRoot = path.join(this.root, "specs");
    this.runRoot = path.join(this.root, "runs");
    this.legacyRunRoot = path.join(options.paseoHome, "workflow-runs");
    this.builtInDirectory = options.builtInDirectory;
    this.commitBoundaryHook = options.commitBoundaryHook;
  }

  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);
    await this.ensureDirectory(this.userSpecRoot);
    await this.ensureDirectory(this.runRoot);
    for (const runId of await listDirectories(this.runRoot)) {
      if (RUN_ID.test(runId)) await this.recoverRun(runId);
    }
  }

  async listSpecs(): Promise<WorkflowSpecSummary[]> {
    const results = new Map<string, WorkflowSpecSummary>();
    for (const [source, directory] of [
      ["user", this.userSpecRoot],
      ["built-in", this.builtInDirectory],
    ] as const) {
      for (const file of await listJsonFiles(directory)) {
        const spec = await readJsonObject(path.join(directory, file), "workflow spec");
        const validation = validateWorkflowTemplate(spec, source);
        if (!validation.valid || !validation.summary) {
          continue;
        }
        const stat = source === "user" ? await fs.stat(path.join(directory, file)) : null;
        results.set(validation.summary.id, {
          ...validation.summary,
          updatedAt: stat?.mtime.toISOString() ?? null,
        });
      }
    }
    return [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getSpec(id: string): Promise<JsonObject> {
    assertWorkflowId(id);
    const builtInPath = path.join(this.builtInDirectory, `${id}.json`);
    if (await exists(builtInPath)) {
      await assertNotSymlink(builtInPath);
      return readJsonObject(builtInPath, "workflow spec");
    }
    const userPath = path.join(this.userSpecRoot, `${id}.json`);
    if (await exists(userPath)) {
      await assertNotSymlink(userPath);
      return readJsonObject(userPath, "workflow spec");
    }
    throw new Error(`workflow spec not found: ${id}`);
  }

  async saveUserSpec(id: string, value: JsonObject): Promise<string> {
    assertWorkflowId(id);
    if (value.name !== id) throw new Error(`workflow spec identity mismatch: ${id}`);
    const builtInPath = path.join(this.builtInDirectory, `${id}.json`);
    if (await exists(builtInPath)) {
      throw new Error(`built-in workflow specs cannot be replaced: ${id}`);
    }
    await this.ensureDirectory(this.userSpecRoot);
    const filePath = path.join(this.userSpecRoot, `${id}.json`);
    if (await exists(filePath)) {
      await assertNotSymlink(filePath);
    }
    await writeFileAtomic(
      filePath,
      `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`,
    );
    return (await fs.stat(filePath)).mtime.toISOString();
  }

  async createRun(
    runId: string,
    spec: JsonObject,
    state: JsonObject,
    events: WorkflowEventRecord[] = [],
  ): Promise<void> {
    assertRunId(runId);
    await this.ensureDirectory(this.runRoot);
    const runDirectory = path.join(this.runRoot, runId);
    if (await exists(runDirectory)) {
      throw new Error(`workflow run already exists: ${runId}`);
    }
    const temporaryDirectory = path.join(
      this.runRoot,
      `.${runId}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.mkdir(temporaryDirectory);
      await fs.mkdir(path.join(temporaryDirectory, "rendered-prompts"));
      await writeFileAtomic(
        path.join(temporaryDirectory, "spec.json"),
        `${JSON.stringify(spec, null, 2)}\n`,
      );
      await writeJsonFileAtomic(path.join(temporaryDirectory, "state.json"), state);
      await writeFileAtomic(
        path.join(temporaryDirectory, "events.jsonl"),
        events.length > 0 ? `${events.map(canonicalJson).join("\n")}\n` : "",
      );
      await fs.rename(temporaryDirectory, runDirectory);
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      if (isNodeError(error) && ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
        throw new Error(`workflow run already exists: ${runId}`, { cause: error });
      }
      throw error;
    }
  }

  async readState(runId: string): Promise<JsonObject> {
    await this.recoverRun(runId);
    const { directory } = await this.resolveRun(runId);
    try {
      return await readJsonObject(path.join(directory, "state.json"), "workflow state");
    } catch (error) {
      throw new Error(`corrupt workflow state for ${runId}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async commitRunTransaction(runId: string, transaction: WorkflowRunTransaction): Promise<void> {
    assertRunId(runId);
    await this.withRunLock(runId, async () => {
      const { directory, legacy } = await this.resolveRun(runId);
      if (legacy) {
        throw new Error(`legacy workflow state is read-only: ${runId}`);
      }
      await this.recoverPendingCommit(directory, runId);
      const pending: PendingWorkflowCommit = {
        schemaVersion: "paseo.workflows.commit.v1",
        runId,
        state: transaction.state,
        events: transaction.events,
      };
      const journalPath = path.join(directory, PENDING_COMMIT_FILE);
      await this.reachCommitBoundary({ step: "journal", phase: "before" });
      await writeJsonFileAtomic(journalPath, pending);
      await this.reachCommitBoundary({ step: "journal", phase: "after" });
      await this.applyPendingCommit(directory, pending, true);
    });
  }

  async writePrompt(
    runId: string,
    prompt: Omit<WorkflowRenderedPrompt, "content"> & { content: string },
  ): Promise<string> {
    const { directory, legacy } = await this.resolveRun(runId);
    if (legacy) {
      throw new Error(`legacy workflow prompts are read-only: ${runId}`);
    }
    const name = safePromptName(prompt.name);
    const promptDirectory = path.join(directory, "rendered-prompts");
    await assertDirectoryNotSymlink(promptDirectory);
    await writeFileAtomic(path.join(promptDirectory, name), prompt.content);
    return name;
  }

  async readRenderedPrompt(runId: string, promptName: string): Promise<string> {
    const name = safePromptName(promptName);
    const state = await this.readState(runId);
    if (!promptIdentities(state).has(name)) {
      throw new Error(`rendered prompt is not referenced by workflow state: ${name}`);
    }
    const { directory } = await this.resolveRun(runId);
    const promptDirectory = path.join(directory, "rendered-prompts");
    const filePath = path.join(promptDirectory, name);
    if (!(await exists(promptDirectory)) || !(await exists(filePath))) {
      throw new Error(`rendered prompt is missing: ${name}`);
    }
    await assertDirectoryNotSymlink(promptDirectory);
    await assertNotSymlink(filePath);
    return fs.readFile(filePath, "utf8");
  }

  async inspectRun(runId: string): Promise<WorkflowRunDetails> {
    await this.recoverRun(runId);
    const resolved = await this.resolveRun(runId);
    const state = await this.readState(runId);
    const spec = await this.readRunSpec(resolved);
    const events = await readEvents(path.join(resolved.directory, "events.jsonl"));
    const prompts = await readPrompts(path.join(resolved.directory, "rendered-prompts"), state);
    return {
      run: summarizeRun(runId, state, resolved.legacy),
      state,
      spec,
      events,
      prompts,
    };
  }

  async listRuns(): Promise<WorkflowRunSummary[]> {
    const rows: WorkflowRunSummary[] = [];
    for (const [directory, legacy] of [
      [this.runRoot, false],
      [this.legacyRunRoot, true],
    ] as const) {
      for (const runId of await listDirectories(directory)) {
        if (!RUN_ID.test(runId)) {
          continue;
        }
        try {
          const resolved = await this.resolveRun(runId);
          if (resolved.legacy !== legacy) {
            continue;
          }
          const state = await this.readState(runId);
          rows.push(summarizeRun(runId, state, legacy));
        } catch {
          continue;
        }
      }
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readRunSpec(resolved: ResolvedRun): Promise<JsonObject> {
    const jsonPath = path.join(resolved.directory, "spec.json");
    if (await exists(jsonPath)) {
      await assertNotSymlink(jsonPath);
      return readJsonObject(jsonPath, "materialized workflow spec");
    }
    const yamlPath = path.join(resolved.directory, "spec.yaml");
    await assertNotSymlink(yamlPath);
    const text = await fs.readFile(yamlPath, "utf8");
    const value = parseYaml(text);
    if (!isObject(value)) {
      throw new Error(`legacy workflow spec is not an object: ${resolved.directory}`);
    }
    return value;
  }

  private async resolveRun(runId: string): Promise<ResolvedRun> {
    assertRunId(runId);
    const native = path.join(this.runRoot, runId);
    if (await exists(native)) {
      await assertDirectoryNotSymlink(native);
      return { directory: native, legacy: false };
    }
    const legacy = path.join(this.legacyRunRoot, runId);
    if (await exists(legacy)) {
      await assertDirectoryNotSymlink(legacy);
      return { directory: legacy, legacy: true };
    }
    throw new Error(`workflow run not found: ${runId}`);
  }

  private async recoverRun(runId: string): Promise<void> {
    assertRunId(runId);
    await this.withRunLock(runId, async () => {
      const resolved = await this.resolveRun(runId);
      if (!resolved.legacy) {
        await this.recoverPendingCommit(resolved.directory, runId);
      }
    });
  }

  private async recoverPendingCommit(directory: string, runId: string): Promise<void> {
    const journalPath = path.join(directory, PENDING_COMMIT_FILE);
    if (!(await exists(journalPath))) return;
    await assertNotSymlink(journalPath);
    const value = JSON.parse(await fs.readFile(journalPath, "utf8")) as unknown;
    const pending = parsePendingCommit(value);
    if (pending.runId !== runId) {
      throw new Error(
        `workflow commit journal identity mismatch: expected ${runId}, got ${pending.runId}`,
      );
    }
    await this.applyPendingCommit(directory, pending, false);
  }

  private async applyPendingCommit(
    directory: string,
    pending: PendingWorkflowCommit,
    notifyBoundaries: boolean,
  ): Promise<void> {
    const eventsPath = path.join(directory, "events.jsonl");
    const statePath = path.join(directory, "state.json");
    await assertNotSymlink(eventsPath);
    await assertNotSymlink(statePath);
    const auditTail = await readRecoverableAuditTail(eventsPath, pending.events);
    const eventsBySequence = new Map(auditTail.map((event) => [event.seq, event]));
    let auditSequence = auditTail.at(-1)?.seq ?? 0;
    for (const [index, event] of pending.events.entries()) {
      if (notifyBoundaries) {
        await this.reachCommitBoundary({ step: "event", phase: "before", index });
      }
      const sameSequence = eventsBySequence.get(event.seq);
      if (sameSequence) {
        if (canonicalJson(sameSequence) !== canonicalJson(event)) {
          throw new Error(`workflow audit event ${event.seq} conflicts with pending transaction`);
        }
      } else {
        if (event.seq !== auditSequence + 1) {
          throw new Error(
            `workflow audit event ${event.seq} is not contiguous after ${auditSequence}`,
          );
        }
        await appendCanonicalEvent(eventsPath, event);
        eventsBySequence.set(event.seq, event);
        auditSequence = event.seq;
      }
      if (notifyBoundaries) {
        await this.reachCommitBoundary({ step: "event", phase: "after", index });
      }
    }
    if (pending.state.eventSeq !== auditSequence) {
      throw new Error(
        `workflow state event sequence ${String(pending.state.eventSeq)} does not match audit ${auditSequence}`,
      );
    }
    if (notifyBoundaries) {
      await this.reachCommitBoundary({ step: "state", phase: "before" });
    }
    await writeJsonFileAtomic(statePath, pending.state);
    if (notifyBoundaries) {
      await this.reachCommitBoundary({ step: "state", phase: "after" });
      await this.reachCommitBoundary({ step: "journal-cleanup", phase: "before" });
    }
    await fs.rm(path.join(directory, PENDING_COMMIT_FILE));
    if (notifyBoundaries) {
      await this.reachCommitBoundary({ step: "journal-cleanup", phase: "after" });
    }
  }

  private async reachCommitBoundary(boundary: WorkflowCommitBoundary): Promise<void> {
    await this.commitBoundaryHook?.(boundary);
  }

  private async withRunLock<T>(runId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.runLocks.set(runId, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.runLocks.get(runId) === tail) {
        void tail.finally(() => {
          if (this.runLocks.get(runId) === tail) this.runLocks.delete(runId);
        });
      }
    }
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    await assertDirectoryNotSymlink(directory);
  }
}

interface ResolvedRun {
  directory: string;
  legacy: boolean;
}

interface PendingWorkflowCommit extends WorkflowRunTransaction {
  schemaVersion: "paseo.workflows.commit.v1";
  runId: string;
}

function summarizeRun(runId: string, state: JsonObject, legacy: boolean): WorkflowRunSummary {
  const status = normalizeStatus(state.status);
  const instances = isObject(state.instances) ? Object.values(state.instances) : [];
  const activeTurns = instances.filter(
    (instance) => isObject(instance) && isObject(instance.activeTurn),
  ).length;
  const agentIds = new Set<string>();
  const workspaceIds = new Set<string>();
  collectIdentities(state, "agentId", agentIds);
  collectIdentities(state, "workspaceId", workspaceIds);
  const workflow = isObject(state.workflow) ? state.workflow : {};
  const loop = isObject(state.loop) ? state.loop : {};
  const now = new Date(0).toISOString();
  const schemaVersion = state.schemaVersion;
  const workflowId = firstString(workflow.id, workflow.name) ?? "legacy";
  const workflowName = firstString(workflow.name, workflow.id) ?? "Legacy workflow";
  const reason = firstString(state.reason, state.stopReason);
  return {
    id: runId,
    workflowId,
    workflowName,
    status,
    reason,
    createdAt: stringOr(state.createdAt, now),
    updatedAt: stringOr(state.updatedAt, stringOr(state.completedAt, now)),
    startedAt: nullableString(state.startedAt),
    completedAt: nullableString(state.completedAt),
    iteration: typeof loop.iteration === "number" ? loop.iteration : 0,
    activeTurns,
    legacy,
    resumable:
      status === "stopped" &&
      reason === "requested" &&
      schemaVersion === "paseo.workflows.run.v0.2" &&
      isObject(state.instances),
    workspaceIds: [...workspaceIds],
    agentIds: [...agentIds],
  };
}

function collectIdentities(value: unknown, key: string, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIdentities(item, key, result);
    return;
  }
  if (!isObject(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === key && typeof item === "string" && item) result.add(item);
    else collectIdentities(item, key, result);
  }
}

async function readEvents(filePath: string): Promise<WorkflowEventRecord[]> {
  if (!(await exists(filePath))) return [];
  await assertNotSymlink(filePath);
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => normalizeEvent(JSON.parse(line) as unknown, index + 1));
}

function normalizeEvent(value: unknown, seq: number): WorkflowEventRecord {
  if (!isObject(value)) {
    return {
      seq,
      timestamp: new Date(0).toISOString(),
      type: "invalid_legacy_event",
      details: { value },
    };
  }
  const known = new Set([
    "seq",
    "timestamp",
    "type",
    "instanceId",
    "flow",
    "state",
    "agent",
    "agentId",
    "event",
    "message",
    "data",
    "details",
  ]);
  const legacyDetails = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  const details = {
    ...(isObject(value.details) ? value.details : {}),
    ...legacyDetails,
  };
  return {
    seq: typeof value.seq === "number" ? value.seq : seq,
    timestamp: stringOr(value.timestamp, new Date(0).toISOString()),
    type: stringOr(value.type, "legacy_event"),
    ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
    ...(typeof value.flow === "string" ? { flow: value.flow } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.event === "string" ? { event: value.event } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...("data" in value ? { data: value.data } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

async function readPrompts(
  directory: string,
  state: JsonObject,
): Promise<WorkflowRenderedPrompt[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  const identities = promptIdentities(state);
  const prompts: WorkflowRenderedPrompt[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!name.endsWith(".txt")) continue;
    const filePath = path.join(directory, name);
    await assertNotSymlink(filePath);
    const identity = identities.get(name);
    if (!identity) continue;
    prompts.push({
      name,
      workflowTurnId: identity.workflowTurnId,
      instanceId: identity.instanceId,
      agentId: identity.agentId,
      createdAt: identity.createdAt,
      content: await fs.readFile(filePath, "utf8"),
    });
  }
  return prompts;
}

function promptIdentities(
  state: JsonObject,
): Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">> {
  const result = new Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">>();
  collectPromptIdentities(state, result);
  return result;
}

function collectPromptIdentities(
  value: unknown,
  result: Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPromptIdentities(item, result);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.promptPath === "string") {
    const name = path.basename(value.promptPath);
    result.set(name, {
      workflowTurnId: nullableString(value.workflowTurnId),
      instanceId: nullableString(value.instanceId),
      agentId: nullableString(value.agentId),
      createdAt: nullableString(value.createdAt),
    });
  }
  for (const item of Object.values(value)) collectPromptIdentities(item, result);
}

function parsePendingCommit(value: unknown): PendingWorkflowCommit {
  if (
    !isObject(value) ||
    value.schemaVersion !== "paseo.workflows.commit.v1" ||
    typeof value.runId !== "string" ||
    !isObject(value.state) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("invalid workflow commit journal");
  }
  const events = value.events.map((event) => WorkflowEventRecordSchema.parse(event));
  return {
    schemaVersion: "paseo.workflows.commit.v1",
    runId: value.runId,
    state: value.state,
    events,
  };
}

async function readRecoverableAuditTail(
  filePath: string,
  pendingEvents: WorkflowEventRecord[],
): Promise<WorkflowEventRecord[]> {
  const handle = await fs.open(filePath, "r");
  let fileSize = 0;
  let start = 0;
  const chunks: Buffer[] = [];
  try {
    fileSize = (await handle.stat()).size;
    start = fileSize;
    const requiredRecords = Math.max(1, pendingEvents.length + 1);
    let newlineCount = 0;
    while (start > 0 && newlineCount <= requiredRecords) {
      const length = Math.min(64 * 1024, start);
      start -= length;
      const chunk = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(chunk, offset, length - offset, start + offset);
        if (bytesRead === 0) throw new Error("workflow audit ended during tail read");
        offset += bytesRead;
      }
      const value = chunk.subarray(0, offset);
      for (const byte of value) {
        if (byte === 0x0a) newlineCount += 1;
      }
      chunks.push(value);
    }
  } finally {
    await handle.close();
  }

  let buffer = Buffer.concat(chunks.toReversed());
  if (start > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) {
      throw new Error("workflow audit tail does not contain a complete record");
    }
    buffer = buffer.subarray(firstNewline + 1);
  }
  if (buffer.length > 0 && buffer.at(-1) !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    const trailing = buffer.subarray(lastNewline + 1);
    const trailingText = trailing.toString("utf8");
    const matchesPendingEvent = pendingEvents.some((event) =>
      `${canonicalJson(event)}\n`.startsWith(trailingText),
    );
    if (!matchesPendingEvent) {
      throw new Error("workflow audit has a partial record outside the pending transaction");
    }
    await fs.truncate(filePath, fileSize - trailing.length);
    buffer = buffer.subarray(0, lastNewline + 1);
  }

  const events = buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-(pendingEvents.length + 1))
    .map((line) => WorkflowEventRecordSchema.parse(JSON.parse(line) as unknown));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq <= events[index - 1]!.seq) {
      throw new Error("workflow audit event sequences are not strictly increasing");
    }
  }
  return events;
}

async function appendCanonicalEvent(filePath: string, event: WorkflowEventRecord): Promise<void> {
  const handle = await fs.open(filePath, "a");
  try {
    await handle.writeFile(`${canonicalJson(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonObject(filePath: string, label: string): Promise<JsonObject> {
  await assertNotSymlink(filePath);
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function listJsonFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  return (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
}

async function listDirectories(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

async function assertDirectoryNotSymlink(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`expected directory: ${directory}`);
}

async function assertNotSymlink(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${filePath}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertWorkflowId(id: string): void {
  if (!WORKFLOW_ID.test(id)) throw new Error(`invalid workflow id: ${id}`);
}

function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`invalid workflow run id: ${id}`);
}

function safePromptName(name: string): string {
  const basename = path.basename(name);
  if (basename !== name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.txt$/.test(name)) {
    throw new Error(`invalid rendered prompt name: ${name}`);
  }
  return name;
}

function normalizeStatus(value: unknown): WorkflowRunStatus {
  if (value === "succeeded") return "complete";
  if (["queued", "running", "stopping", "stopped", "complete", "failed"].includes(String(value))) {
    return value as WorkflowRunStatus;
  }
  return "failed";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
