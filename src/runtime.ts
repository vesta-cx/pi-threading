/**
 * In-memory orchestration runtime for pi-threading.
 *
 * Sits on top of `Store` for durable tree state and `RpcClient` for child
 * transport. Owns live child processes, runtime events, concurrency limits,
 * question routing state, and synthesized results for crashed agents.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, DiscoverOptions } from "./agents.js";
import { resolveAgent } from "./agents.js";
import type {
	Message,
	RpcClientOptions,
	RpcExtensionUIRequest,
	RpcExtensionUIResponsePayload,
	RpcMessageEndEvent,
	RpcToolExecutionEndEvent,
	RpcToolExecutionStartEvent,
} from "./rpc-client.js";
import { RpcClient } from "./rpc-client.js";
import type { Agent, AgentUsage, Store } from "./store.js";

/** Spawn-time overrides for tree placement and transport wiring. */
export interface SpawnOptions {
	id?: string;
	parentId?: string | null;
	displayName?: string | null;
	cwd?: string;
	env?: Record<string, string>;
}

/** Structured result captured from a child's `finish_task` call or crash fallback synthesis. */
export interface FinishTaskResult {
	summary: string;
	artifacts?: string[];
	source: "finish_task" | "crash_fallback";
	data?: Record<string, unknown>;
}

/** Interactive question that requires an answer from the orchestrator or user. */
export interface PendingQuestion {
	agentId: string;
	questionId: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	placeholder?: string;
	options?: string[];
	requestedAt: number;
	rawRequest: RpcExtensionUIRequest;
}

/** Runtime activity event emitted for live child progress. */
export type AgentActivity =
	| {
			kind: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
			timestamp: number;
	  }
	| {
			kind: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			timestamp: number;
	  }
	| {
			kind: "message_end";
			summary: string;
			message: Message;
			timestamp: number;
	  };

/** Crash information emitted when a child exits without calling `finish_task`. */
export interface CrashInfo {
	agentId: string;
	summary: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

/** Lightweight handle returned from `spawn()`. */
export interface AgentHandle {
	id: string;
	steer(message: string): void;
	stop(): Promise<void>;
	getResult(): FinishTaskResult | null;
}

/** Tree view used by UI layers and tests. */
export interface TreeNode {
	kind: "trunk" | "agent";
	id: string;
	agent: Agent | null;
	children: TreeNode[];
}

/** Settings for a runtime instance. */
export interface ThreadingSettings {
	dbPath: string;
	cwd?: string;
	cliPath?: string;
	env?: Record<string, string>;
	discoverOptions?: DiscoverOptions;
	sessionRootDir?: string;
	maxChildren: number;
	maxTreeDepth: number;
	maxTreeAgents: number;
	rootSessionPath?: string | null;
	rpcClientFactory?: RpcClientFactory;
}

interface RpcClientLike {
	on(event: "message_end", listener: (event: RpcMessageEndEvent) => void): this;
	on(event: "tool_execution_start", listener: (event: RpcToolExecutionStartEvent) => void): this;
	on(event: "tool_execution_end", listener: (event: RpcToolExecutionEndEvent) => void): this;
	on(event: "extension_ui_request", listener: (event: RpcExtensionUIRequest) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: string, listener: (...args: any[]) => void): this;
	prompt(message: string): void;
	steer(message: string): void;
	kill(timeout?: number): Promise<void>;
	respondToUiRequest(id: string, response: RpcExtensionUIResponsePayload): void;
	getMessages(): Promise<Message[]>;
	getStderr(): string;
	isAlive(): boolean;
}

type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

interface ActiveAgentState {
	client: RpcClientLike;
	stopRequested: boolean;
	finishResult: FinishTaskResult | null;
	lastActivity: AgentActivity | null;
	questions: PendingQuestion[];
}

/**
 * Create deterministic per-agent session file paths under the pi-threading
 * session root.
 */
export function generateSessionPath(trunkId: string, agentId: string, sessionRootDir?: string): string {
	const safeTrunkId = assertSafeSessionPathSegment(trunkId, "trunk id");
	const safeAgentId = assertSafeSessionPathSegment(agentId, "agent id");
	const root = sessionRootDir ?? path.join(os.homedir(), ".pi", "agent", "sessions", "pi-threading");
	const dir = path.join(root, safeTrunkId);
	mkdirSync(dir, { recursive: true });
	return path.join(dir, `${safeAgentId}.jsonl`);
}

/**
 * Live runtime for orchestrating a single trunk of child agents.
 *
 * Owns the active `RpcClient` instances, persists lifecycle state to the
 * store, and emits higher-level events for UI and tool layers.
 */
export class ThreadRuntime extends EventEmitter {
	private readonly settings: ThreadingSettings;
	private readonly rpcClientFactory: RpcClientFactory;
	private trunkId: string | null = null;
	private shuttingDown = false;
	private closed = false;
	private readonly activeAgents = new Map<string, ActiveAgentState>();
	private readonly results = new Map<string, FinishTaskResult>();

	constructor(
		private readonly store: Store,
		settings: ThreadingSettings,
	) {
		super();
		this.settings = settings;
		this.rpcClientFactory = settings.rpcClientFactory ?? ((options) => new RpcClient(options));
	}

	override on(event: "agent:activity", listener: (agentId: string, activity: AgentActivity) => void): this;
	override on(event: "agent:question", listener: (agentId: string, question: PendingQuestion) => void): this;
	override on(event: "agent:completed", listener: (agentId: string, result: FinishTaskResult) => void): this;
	override on(event: "agent:crashed", listener: (agentId: string, error: CrashInfo) => void): this;
	override on(event: string, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}

	/** Spawn a child agent and return a lightweight handle immediately. */
	spawn(configOrRef: AgentConfig | string, task: string, options: SpawnOptions = {}): AgentHandle {
		if (this.shuttingDown || this.closed) {
			throw new Error("Runtime is shutting down");
		}

		const config = this.resolveSpawnConfig(configOrRef);
		const hadTrunkBefore = this.trunkId !== null;
		const agentId = options.id ?? crypto.randomUUID();
		this.assertWithinLimits(options.parentId ?? null);

		let createdTrunkThisCall = false;
		let agentPersistedThisCall = false;
		let client: RpcClientLike | null = null;
		let activeAdded = false;

		try {
			const trunk = this.ensureTrunk();
			createdTrunkThisCall = !hadTrunkBefore;
			const sessionPath = generateSessionPath(trunk.id, agentId, config.sessionDir ?? this.settings.sessionRootDir);
			const persistedSessionPath = config.noSession ? null : sessionPath;

			this.store.createAgent({
				id: agentId,
				trunkId: trunk.id,
				parentAgentId: options.parentId ?? null,
				name: config.name,
				displayName: options.displayName ?? null,
				task,
				sessionPath: persistedSessionPath,
				config: serializeAgentConfig(config),
			});
			agentPersistedThisCall = true;

			client = this.rpcClientFactory({
				config: config,
				agentId,
				trunkId: trunk.id,
				dbPath: this.settings.dbPath,
				sessionPath,
				parentId: options.parentId ?? null,
				cwd: options.cwd ?? config.cwd ?? this.settings.cwd,
				env: { ...this.settings.env, ...options.env },
				cliPath: this.settings.cliPath,
			});

			const active: ActiveAgentState = {
				client,
				stopRequested: false,
				finishResult: null,
				lastActivity: null,
				questions: [],
			};
			this.activeAgents.set(agentId, active);
			activeAdded = true;
			this.attachClientListeners(agentId, active);
			this.store.updateAgentStatus(agentId, "running");
			client.prompt(task);

			return {
				id: agentId,
				steer: (message) => this.steer(agentId, message),
				stop: () => this.stop(agentId),
				getResult: () => this.getResult(agentId),
			};
		} catch (error) {
			if (activeAdded) {
				this.activeAgents.delete(agentId);
			}
			if (client) {
				void client.kill(1).catch(() => {});
			}
			if (this.trunkId && (createdTrunkThisCall || agentPersistedThisCall)) {
				this.rollbackSpawn(agentId, createdTrunkThisCall);
			}
			throw error;
		}
	}

	/** Send a steering message to a live child agent. */
	steer(agentId: string, message: string): void {
		const active = this.requireActiveAgent(agentId);
		active.client.steer(message);
	}

	/** Stop a live child agent using the transport-layer kill escalation. */
	async stop(agentId: string): Promise<void> {
		const active = this.activeAgents.get(agentId);
		if (!active) {
			const agent = this.store.getAgent(agentId);
			if (agent && isTerminalAgentStatus(agent.status)) return;
			throw new Error(`Agent is not running: ${agentId}`);
		}

		await this.killRequestedAgent(agentId, active, 1000);
		const agent = this.store.getAgent(agentId);
		if (agent?.status === "running") {
			this.store.updateAgentStatus(agentId, "killed");
		}
	}

	/** Return the captured finish result or synthesized crash fallback. */
	getResult(agentId: string): FinishTaskResult | null {
		return this.results.get(agentId) ?? null;
	}

	/** List the direct children of the given parent, or root-level children when omitted. */
	listChildren(parentId?: string): Agent[] {
		if (!this.trunkId) return [];
		return this.store
			.getAgentsInTrunk(this.trunkId)
			.filter((agent) => agent.parentAgentId === (parentId ?? null))
			.sort((a, b) => a.spawnedAt - b.spawnedAt);
	}

	/** Return the full current tree as a virtual trunk node. */
	getTree(): TreeNode {
		if (!this.trunkId) {
			return { kind: "trunk", id: "uninitialized", agent: null, children: [] };
		}

		const agents = this.store.getAgentsInTrunk(this.trunkId).sort((a, b) => a.spawnedAt - b.spawnedAt);
		const nodes = new Map<string, TreeNode>(
			agents.map((agent) => [agent.id, { kind: "agent", id: agent.id, agent, children: [] }]),
		);
		const roots: TreeNode[] = [];

		for (const agent of agents) {
			const node = nodes.get(agent.id);
			if (!node) continue;
			if (agent.parentAgentId) {
				const parent = nodes.get(agent.parentAgentId);
				if (parent) {
					parent.children.push(node);
					continue;
				}
			}
			roots.push(node);
		}

		return { kind: "trunk", id: this.trunkId, agent: null, children: roots };
	}

	/** Return the cumulative cost of the current trunk. */
	getTreeCost(): number {
		if (!this.trunkId) return 0;
		return this.store.getTreeCost(this.trunkId);
	}

	/** Answer the oldest pending interactive question for an agent. */
	answerQuestion(agentId: string, answer: string): void {
		const active = this.requireActiveAgent(agentId);
		const question = active.questions[0];
		if (!question) throw new Error(`No pending question for agent ${agentId}`);
		active.client.respondToUiRequest(question.questionId, buildUiResponse(question, answer));
		active.questions.shift();
	}

	/** Return all currently pending interactive questions, oldest first. */
	getPendingQuestions(): PendingQuestion[] {
		return Array.from(this.activeAgents.values())
			.flatMap((active) => active.questions)
			.sort((a, b) => a.requestedAt - b.requestedAt);
	}

	/** Gracefully stop all live children, then mark the trunk completed. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.shuttingDown = true;

		const activeEntries = Array.from(this.activeAgents.entries());
		const errors: Error[] = [];
		try {
			await Promise.all(
				activeEntries.map(async ([agentId, active]) => {
					try {
						await this.killRequestedAgent(agentId, active, 5000);
					} catch (error) {
						errors.push(error instanceof Error ? error : new Error(String(error)));
					} finally {
						const agent = this.store.getAgent(agentId);
						if (agent?.status === "running" && !active.client.isAlive()) {
							this.store.updateAgentStatus(agentId, "killed");
						}
					}
				}),
			);
		} finally {
			if (this.trunkId && this.store.getTrunk(this.trunkId)) {
				this.store.updateTrunkStatus(this.trunkId, "completed");
			}
			this.closed = true;
		}

		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, "Failed to stop one or more agents during shutdown");
		}
	}

	private resolveSpawnConfig(configOrRef: AgentConfig | string): AgentConfig {
		if (typeof configOrRef !== "string") return configOrRef;

		const resolved = resolveAgent(configOrRef, this.settings.cwd ?? process.cwd(), this.settings.discoverOptions);
		if (!resolved) {
			throw new Error(`Agent not found: ${configOrRef}`);
		}
		return resolved;
	}

	private ensureTrunk(): { id: string; status: string } {
		if (this.trunkId) {
			const trunk = this.store.getTrunk(this.trunkId);
			if (!trunk) throw new Error(`Trunk missing from store: ${this.trunkId}`);
			if (trunk.status === "completed") {
				throw new Error("Runtime has been shut down");
			}
			return trunk;
		}

		const trunk = this.store.createTrunk({
			id: crypto.randomUUID(),
			rootSessionPath: this.settings.rootSessionPath ?? null,
		});
		this.trunkId = trunk.id;
		return trunk;
	}

	private rollbackSpawn(agentId: string, createdTrunkThisCall: boolean): void {
		if (!this.trunkId) return;
		const trunkCleared = this.store.rollbackSpawn(agentId, this.trunkId, createdTrunkThisCall);
		if (trunkCleared) {
			this.trunkId = null;
		}
	}

	private async killRequestedAgent(agentId: string, active: ActiveAgentState, timeout: number): Promise<void> {
		active.stopRequested = true;
		try {
			await active.client.kill(timeout);
		} catch (error) {
			if (this.activeAgents.get(agentId) === active) {
				active.stopRequested = false;
			}
			throw error;
		}
	}

	private assertWithinLimits(parentId: string | null): void {
		if (parentId) {
			if (!this.trunkId) {
				throw new Error(`Cannot spawn agent: parent not found in trunk (${parentId})`);
			}
			const parent = this.store.getAgent(parentId);
			if (!parent || parent.trunkId !== this.trunkId) {
				throw new Error(`Cannot spawn agent: parent not found in trunk (${parentId})`);
			}
		}

		const allAgents = this.trunkId ? this.store.getAgentsInTrunk(this.trunkId) : [];
		const liveAgents = allAgents.filter((agent) => !isTerminalAgentStatus(agent.status));
		const siblingCount = liveAgents.filter((agent) => agent.parentAgentId === parentId).length;
		if (siblingCount >= this.settings.maxChildren) {
			throw new Error(`Cannot spawn agent: max_children exceeded (${this.settings.maxChildren})`);
		}

		const depth = parentId ? this.store.getAncestors(parentId).length + 2 : 1;
		if (depth > this.settings.maxTreeDepth) {
			throw new Error(`Cannot spawn agent: max_tree_depth exceeded (${this.settings.maxTreeDepth})`);
		}

		if (liveAgents.length >= this.settings.maxTreeAgents) {
			throw new Error(`Cannot spawn agent: max_tree_agents exceeded (${this.settings.maxTreeAgents})`);
		}
	}

	private attachClientListeners(agentId: string, active: ActiveAgentState): void {
		active.client.on("message_end", (event) => this.handleMessageEnd(agentId, event));
		active.client.on("tool_execution_start", (event) => this.handleToolExecutionStart(agentId, event));
		active.client.on("tool_execution_end", (event) => this.handleToolExecutionEnd(agentId, event));
		active.client.on("extension_ui_request", (event) => this.handleUiRequest(agentId, event));
		active.client.on("exit", (code, signal) => this.handleExit(agentId, code, signal));
	}

	private handleMessageEnd(agentId: string, event: RpcMessageEndEvent): void {
		const active = this.activeAgents.get(agentId);
		if (!active) return;

		const usageDelta = extractUsageDelta(event.message);
		if (usageDelta) {
			const current = this.store.getAgent(agentId)?.usage ?? emptyUsage();
			this.store.updateAgentUsage(agentId, addUsage(current, usageDelta));
		}

		const summary = summarizeMessage(event.message);
		active.lastActivity = { kind: "message_end", summary, message: event.message, timestamp: Date.now() };
		this.emit("agent:activity", agentId, active.lastActivity);
	}

	private handleToolExecutionStart(agentId: string, event: RpcToolExecutionStartEvent): void {
		const active = this.activeAgents.get(agentId);
		if (!active) return;

		active.lastActivity = {
			kind: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			timestamp: Date.now(),
		};
		this.emit("agent:activity", agentId, active.lastActivity);
	}

	private handleToolExecutionEnd(agentId: string, event: RpcToolExecutionEndEvent): void {
		const active = this.activeAgents.get(agentId);
		if (!active) return;

		active.lastActivity = {
			kind: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
			timestamp: Date.now(),
		};
		this.emit("agent:activity", agentId, active.lastActivity);

		if (event.toolName !== "finish_task" || event.isError) return;
		const result = normalizeFinishTaskResult(event.result);
		active.finishResult = result;
		this.results.set(agentId, result);
		this.emit("agent:completed", agentId, result);
	}

	private handleUiRequest(agentId: string, request: RpcExtensionUIRequest): void {
		const active = this.activeAgents.get(agentId);
		if (!active) return;
		if (!isInteractiveUiRequest(request)) return;

		const question: PendingQuestion = {
			agentId,
			questionId: request.id,
			method: request.method,
			title: request.title,
			message: "message" in request && typeof request.message === "string" ? request.message : undefined,
			placeholder:
				"placeholder" in request && typeof request.placeholder === "string" ? request.placeholder : undefined,
			options: "options" in request && Array.isArray(request.options) ? request.options : undefined,
			requestedAt: Date.now(),
			rawRequest: request,
		};
		active.questions.push(question);
		this.emit("agent:question", agentId, question);
	}

	private handleExit(agentId: string, code: number | null, signal: NodeJS.Signals | null): void {
		const active = this.activeAgents.get(agentId);
		this.activeAgents.delete(agentId);
		if (!active) return;

		const agent = this.store.getAgent(agentId);
		if (!agent) return;

		active.questions.length = 0;

		if (active.finishResult) {
			if (agent.status === "running") {
				this.store.updateAgentStatus(agentId, "exited");
			}
			return;
		}

		if (active.stopRequested) {
			if (agent.status === "running") {
				this.store.updateAgentStatus(agentId, "killed");
			}
			return;
		}

		const crashResult = synthesizeCrashResult(active);
		this.results.set(agentId, crashResult);
		if (agent.status === "running") {
			this.store.updateAgentStatus(agentId, "crashed");
		}
		this.emit("agent:crashed", agentId, {
			agentId,
			summary: crashResult.summary,
			stderr: active.client.getStderr(),
			exitCode: code,
			signal,
		});
	}

	private requireActiveAgent(agentId: string): ActiveAgentState {
		const active = this.activeAgents.get(agentId);
		if (!active) throw new Error(`Agent is not running: ${agentId}`);
		return active;
	}
}

function serializeAgentConfig(config: AgentConfig): Record<string, unknown> {
	return {
		name: config.name,
		description: config.description,
		aliases: config.aliases,
		model: config.model,
		thinking: config.thinking,
		tools: config.tools,
		extensions: config.extensions,
		noExtensions: config.noExtensions,
		skills: config.skills,
		noSkills: config.noSkills,
		cwd: config.cwd,
		sessionDir: config.sessionDir,
		noSession: config.noSession,
		maxTurns: config.maxTurns,
		canOrchestrate: config.canOrchestrate,
		systemPrompt: config.systemPrompt,
		source: config.source,
		filePath: config.filePath,
	};
}

function assertSafeSessionPathSegment(value: string, label: string): string {
	if (!value || value === "." || value === "..") {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	if (
		path.isAbsolute(value) ||
		value.includes(path.sep) ||
		value.includes(path.posix.sep) ||
		value.includes(path.win32.sep)
	) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return value;
}

function emptyUsage(): AgentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
		contextTokens: left.contextTokens + right.contextTokens,
		turns: left.turns + right.turns,
	};
}

function readFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUsageDelta(message: Message): AgentUsage | null {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return null;
	}
	if (!("usage" in message) || !message.usage || typeof message.usage !== "object") {
		return null;
	}

	const usage = message.usage as Record<string, unknown>;
	const cost = usage.cost;
	if (!cost || typeof cost !== "object") {
		return null;
	}

	const input = readFiniteNumber(usage.input);
	const output = readFiniteNumber(usage.output);
	const cacheRead = readFiniteNumber(usage.cacheRead);
	const cacheWrite = readFiniteNumber(usage.cacheWrite);
	const totalTokens = readFiniteNumber(usage.totalTokens);
	const totalCost = readFiniteNumber((cost as Record<string, unknown>).total);
	if (
		input === null ||
		output === null ||
		cacheRead === null ||
		cacheWrite === null ||
		totalTokens === null ||
		totalCost === null
	) {
		return null;
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: totalCost,
		contextTokens: totalTokens,
		turns: 1,
	};
}

function summarizeMessage(message: Message): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return "Assistant message finished";
	}
	if (!("content" in message) || !Array.isArray(message.content)) {
		return "Assistant message finished";
	}

	const text = message.content
		.filter((item): item is { type: string; text?: string } =>
			Boolean(item && typeof item === "object" && "type" in item),
		)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text?.trim() ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();

	return text || "Assistant message finished";
}

function normalizeFinishTaskResult(result: unknown): FinishTaskResult {
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		const summary =
			typeof record.summary === "string" && record.summary.trim()
				? record.summary.trim()
				: summarizeUnknownResult(result);
		const artifacts = Array.isArray(record.artifacts)
			? record.artifacts.filter((value): value is string => typeof value === "string")
			: undefined;
		return {
			summary,
			artifacts: artifacts && artifacts.length > 0 ? artifacts : undefined,
			source: "finish_task",
			data: record,
		};
	}

	if (typeof result === "string" && result.trim()) {
		return { summary: result.trim(), source: "finish_task", data: { summary: result.trim() } };
	}

	return { summary: "Agent completed without a structured summary.", source: "finish_task" };
}

function summarizeUnknownResult(result: unknown): string {
	if (typeof result === "string" && result.trim()) return result.trim();
	try {
		return JSON.stringify(result);
	} catch {
		return "Agent completed without a readable summary.";
	}
}

function isInteractiveUiRequest(
	request: RpcExtensionUIRequest,
): request is Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }> {
	return (
		request.method === "select" ||
		request.method === "confirm" ||
		request.method === "input" ||
		request.method === "editor"
	);
}

function buildUiResponse(question: PendingQuestion, answer: string): RpcExtensionUIResponsePayload {
	if (question.method === "confirm") {
		return { confirmed: parseConfirmation(answer) };
	}
	return { value: answer };
}

function parseConfirmation(answer: string): boolean {
	const value = answer.trim().toLowerCase();
	if (["y", "yes", "true", "1", "ok", "okay", "confirm"].includes(value)) return true;
	if (["n", "no", "false", "0", "cancel"].includes(value)) return false;
	return false;
}

function synthesizeCrashResult(active: ActiveAgentState): FinishTaskResult {
	if (active.lastActivity?.kind === "tool_execution_start") {
		return {
			summary: `Agent crashed while running tool ${active.lastActivity.toolName}.`,
			source: "crash_fallback",
		};
	}

	if (active.lastActivity?.kind === "tool_execution_end") {
		return {
			summary: `Agent crashed after finishing tool ${active.lastActivity.toolName}.`,
			source: "crash_fallback",
		};
	}

	if (active.lastActivity?.kind === "message_end") {
		return { summary: active.lastActivity.summary, source: "crash_fallback" };
	}

	const stderr = active.client.getStderr().trim();
	if (stderr) {
		return { summary: stderr, source: "crash_fallback" };
	}

	return {
		summary: "Agent exited unexpectedly before producing a result.",
		source: "crash_fallback",
	};
}

function isTerminalAgentStatus(status: Agent["status"]): boolean {
	return status === "exited" || status === "crashed" || status === "killed";
}
