/**
 * RPC client for a single spawned pi subagent process.
 *
 * Pure transport layer: spawn process, write JSONL commands, parse JSONL events,
 * correlate request/response pairs, and manage process lifecycle.
 *
 * This layer does NOT interpret agent behavior. Higher-level lifecycle tracking,
 * question routing, and result synthesis live in runtime.ts.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./agents.js";

/** Re-export of pi-agent-core's AgentMessage for convenience. */
export type Message = AgentMessage;

/** Session state snapshot returned by `getState()`. */
export type RpcState = {
	model?: unknown;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
};

/** JSON response from the child pi process, correlated by `id`. */
export type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

/**
 * Extension UI request emitted by the child process on stdout.
 * Uses an extensible base so later slices can attach extra fields
 * (e.g. reasoning, context for question routing) without transport changes.
 */
type RpcExtensionUIRequestBase = {
	type: "extension_ui_request";
	id: string;
	[key: string]: unknown;
};

export type RpcExtensionUIRequest =
	| (RpcExtensionUIRequestBase & {
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "editor";
			title: string;
			prefill?: string;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  })
	| (RpcExtensionUIRequestBase & {
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  })
	| (RpcExtensionUIRequestBase & {
			method: "setTitle";
			title: string;
	  })
	| (RpcExtensionUIRequestBase & {
			method: "set_editor_text";
			text: string;
	  });

/** Response sent to the child process to answer an `extension_ui_request`. */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Error event emitted when an extension in the child process throws. */
export interface RpcExtensionError {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

/** Union of all event types that `RpcClient` can emit. */
export type RpcClientEvent = AgentEvent | RpcExtensionUIRequest | RpcExtensionError;
/** Narrowed type for `message_end` events (usage aggregation). */
export type RpcMessageEndEvent = Extract<AgentEvent, { type: "message_end" }>;
/** Narrowed type for `tool_execution_start` events (activity tracking). */
export type RpcToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
/** Narrowed type for `tool_execution_end` events. */
export type RpcToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

/** Configuration for spawning a single pi subagent process. */
export interface RpcClientOptions {
	config: AgentConfig;
	agentId: string;
	trunkId: string;
	dbPath: string;
	sessionPath: string;
	parentId?: string | null;
	cwd?: string;
	env?: Record<string, string>;
	cliPath?: string;
	spawnImpl?: typeof spawn;
}

/** Resolved command + args for spawning the pi CLI. */
export interface RpcInvocation {
	command: string;
	args: string[];
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	command: string;
}

interface SpawnedProcess extends ChildProcess {
	stdout: NonNullable<ChildProcess["stdout"]>;
	stderr: NonNullable<ChildProcess["stderr"]>;
	stdin: NonNullable<ChildProcess["stdin"]>;
}

/**
 * Determine the correct command and args to spawn pi.
 *
 * Tries, in order: explicit `cliPath`, `process.argv[1]` (if the current
 * process is pi), the executable name (if it's not a generic runtime like
 * node/bun), and finally falls back to `"pi"` on `$PATH`.
 */
export function getPiInvocation(args: string[], cliPath?: string): RpcInvocation {
	if (cliPath) {
		return { command: process.execPath, args: [cliPath, ...args] };
	}

	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Build the child process environment with `PI_THREADING_*` variables set.
 *
 * Inherits `process.env` and layers on trunk/agent/DB coordination vars
 * plus any extra env from `options.env`.
 */
export function createThreadingEnv(options: RpcClientOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };

	env.PI_THREADING_TRUNK_ID = options.trunkId;
	env.PI_THREADING_DB_PATH = options.dbPath;
	env.PI_THREADING_AGENT_ID = options.agentId;
	if (options.parentId) {
		env.PI_THREADING_PARENT_ID = options.parentId;
	} else {
		delete env.PI_THREADING_PARENT_ID;
	}

	for (const [key, value] of Object.entries(options.env ?? {})) {
		env[key] = value;
	}

	return env;
}

/**
 * Build the CLI argument list for `pi --mode rpc` from an agent config.
 *
 * Translates `AgentConfig` fields into the corresponding CLI flags:
 * `--model`, `--thinking`, `--tools`, `--session`, `--append-system-prompt`,
 * `--no-extensions`, `-e`, `--no-skills`, `--skill`.
 */
export function buildRpcArgs(config: AgentConfig, sessionPath: string, systemPromptPath?: string): string[] {
	const args = ["--mode", "rpc"];

	if (config.model) args.push("--model", config.model);
	if (config.thinking) args.push("--thinking", config.thinking);
	if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));

	if (config.noSession) {
		args.push("--no-session");
	} else {
		args.push("--session", sessionPath);
	}

	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	if (config.noExtensions) args.push("--no-extensions");
	for (const extension of config.extensions ?? []) args.push("-e", extension);
	if (config.noSkills) args.push("--no-skills");
	for (const skill of config.skills ?? []) args.push("--skill", skill);

	return args;
}

/**
 * Transport layer for a single spawned pi subagent process.
 *
 * Manages the child process lifecycle, writes JSONL commands to stdin,
 * parses JSONL events from stdout with partial-line buffering, and
 * correlates async request/response pairs by ID.
 *
 * Does NOT interpret agent behavior — lifecycle tracking, question routing,
 * and result synthesis belong in `runtime.ts`.
 */
export class RpcClient extends EventEmitter {
	private readonly spawnImpl: typeof spawn;
	private readonly child: SpawnedProcess;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly exitPromise: Promise<void>;
	private resolveExit!: () => void;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private nextRequestId = 0;
	private tempPromptDir: string | null = null;
	private tempPromptPath: string | null = null;
	private stdoutFlushed = false;
	private alive = true;

	override on(event: "message_end", listener: (event: RpcMessageEndEvent) => void): this;
	override on(event: "tool_execution_start", listener: (event: RpcToolExecutionStartEvent) => void): this;
	override on(event: "tool_execution_end", listener: (event: RpcToolExecutionEndEvent) => void): this;
	override on(event: "extension_ui_request", listener: (event: RpcExtensionUIRequest) => void): this;
	override on(event: "extension_error", listener: (event: RpcExtensionError) => void): this;
	override on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	override on(event: string, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}

	constructor(options: RpcClientOptions) {
		super();
		this.spawnImpl = options.spawnImpl ?? spawn;
		this.exitPromise = new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});

		const spawnCwd = options.cwd ?? options.config.cwd ?? process.cwd();
		const systemPromptPath = this.createSystemPromptFile(options.config.systemPrompt);
		const args = buildRpcArgs(options.config, options.sessionPath, systemPromptPath ?? undefined);
		const invocation = getPiInvocation(args, options.cliPath);
		const spawnOptions: SpawnOptions = {
			cwd: spawnCwd,
			env: createThreadingEnv(options),
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		};

		try {
			this.child = this.spawnImpl(invocation.command, invocation.args, spawnOptions) as SpawnedProcess;
		} catch (error) {
			this.cleanupTempPrompt();
			throw error;
		}

		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
		this.child.stdout.on("end", () => this.flushStdoutBuffer());
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
		});
		this.child.on("close", (code, signal) => this.handleClose(code, signal));
	}

	get pid(): number | undefined {
		return this.child.pid ?? undefined;
	}

	isAlive(): boolean {
		return this.alive;
	}

	getStderr(): string {
		return this.stderrBuffer;
	}

	prompt(message: string): void {
		this.send({ type: "prompt", message });
	}

	steer(message: string): void {
		this.send({ type: "steer", message });
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	getState(): Promise<RpcState> {
		return this.request<RpcState>({ type: "get_state" });
	}

	async getMessages(): Promise<Message[]> {
		const data = await this.request<{ messages: Message[] }>({ type: "get_messages" });
		return data.messages;
	}

	respondToUiRequest(id: string, response: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
		this.send({ type: "extension_ui_response", id, ...response });
	}

	async kill(timeout = 1000): Promise<void> {
		if (!this.alive) return;

		this.abortSafely();
		await Promise.race([this.exitPromise, delay(timeout)]);
		if (!this.alive) return;

		this.child.kill("SIGTERM");
		await Promise.race([this.exitPromise, delay(timeout)]);
		if (!this.alive) return;

		this.child.kill("SIGKILL");
		await Promise.race([this.exitPromise, delay(timeout)]);
	}

	private createSystemPromptFile(systemPrompt: string): string | null {
		if (!systemPrompt.trim()) return null;

		this.tempPromptDir = mkdtempSync(path.join(os.tmpdir(), "pi-threading-rpc-"));
		this.tempPromptPath = path.join(this.tempPromptDir, "system-prompt.md");
		try {
			writeFileSync(this.tempPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			this.cleanupTempPrompt();
			throw error;
		}
		return this.tempPromptPath;
	}

	private cleanupTempPrompt(): void {
		if (!this.tempPromptDir) return;
		rmSync(this.tempPromptDir, { recursive: true, force: true });
		this.tempPromptDir = null;
		this.tempPromptPath = null;
	}

	private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
		this.flushStdoutBuffer();
		this.alive = false;
		this.cleanupTempPrompt();
		this.rejectPendingRequests(new Error(`RPC process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
		this.emit("exit", code, signal);
		this.resolveExit();
	}

	private handleStdoutChunk(chunk: string): void {
		this.stdoutBuffer += chunk;

		for (;;) {
			const newlineIndex = this.stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) break;

			let line = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleStdoutLine(line);
		}
	}

	private flushStdoutBuffer(): void {
		if (this.stdoutFlushed) return;
		this.stdoutFlushed = true;
		if (this.stdoutBuffer.length === 0) return;

		let line = this.stdoutBuffer;
		this.stdoutBuffer = "";
		if (line.endsWith("\r")) line = line.slice(0, -1);
		this.handleStdoutLine(line);
	}

	private handleStdoutLine(line: string): void {
		if (!line.trim()) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}

		if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
		const event = parsed as { type: string; id?: string; success?: boolean; error?: string };

		if (event.type === "response") {
			this.handleResponse(parsed as RpcResponse);
			return;
		}

		if (event.type === "extension_ui_request") {
			this.emit("extension_ui_request", parsed as RpcExtensionUIRequest);
			return;
		}

		if (event.type === "extension_error") {
			this.emit("extension_error", parsed as RpcExtensionError);
			return;
		}

		this.emit(event.type, parsed);
	}

	private handleResponse(response: RpcResponse): void {
		if (!response.id) return;
		const pending = this.pendingRequests.get(response.id);
		if (!pending) return;
		this.pendingRequests.delete(response.id);

		if (!response.success) {
			pending.reject(new Error(response.error ?? `RPC command failed: ${pending.command}`));
			return;
		}

		pending.resolve(response.data);
	}

	private send(command: Record<string, unknown>): void {
		if (!this.alive) {
			throw new Error("RPC process is not alive");
		}
		if (this.child.stdin.destroyed || !this.child.stdin.writable) {
			throw new Error("RPC stdin is not writable");
		}
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	private request<T>(command: Record<string, unknown>): Promise<T> {
		const id = `rpc-${++this.nextRequestId}-${crypto.randomUUID()}`;
		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, {
				command: String(command.type ?? "unknown"),
				resolve: (value) => resolve(value as T),
				reject,
			});

			try {
				this.send({ ...command, id });
			} catch (error) {
				this.pendingRequests.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private rejectPendingRequests(error: Error): void {
		for (const [id, pending] of this.pendingRequests.entries()) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private abortSafely(): void {
		try {
			this.abort();
		} catch {
			// Process may already be gone; kill escalation handles the rest.
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

/** Read a system prompt file from disk. Utility for tests. */
export function readSystemPromptFile(filePath: string): string {
	return readFileSync(filePath, "utf8");
}
