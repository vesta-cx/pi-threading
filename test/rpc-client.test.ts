/**
 * Tests for src/rpc-client.ts.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentConfig } from "../src/agents.js";
import { RpcClient, readSystemPromptFile } from "../src/rpc-client.js";

class FakeStream extends EventEmitter {
	writable = true;
	destroyed = false;
	readonly writes: string[] = [];
	encoding: BufferEncoding | null = null;

	setEncoding(encoding: BufferEncoding): this {
		this.encoding = encoding;
		return this;
	}

	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
}

class FakeChildProcess extends EventEmitter {
	pid = 4242;
	stdout = new FakeStream();
	stderr = new FakeStream();
	stdin = new FakeStream();
	readonly signals: NodeJS.Signals[] = [];
	autoCloseOnSignal: NodeJS.Signals | null = "SIGKILL";

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		if (this.autoCloseOnSignal === signal) {
			queueMicrotask(() => {
				this.emit("close", signal === "SIGKILL" ? null : 0, signal);
			});
		}
		return true;
	}
}

interface SpawnCall {
	command: string;
	args: string[];
	options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean };
}

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "Scout agent",
		aliases: [],
		systemPrompt: "You are a scout.",
		source: "pi",
		filePath: "/fake/scout.md",
		...overrides,
	};
}

function parseWrites(writes: string[]): unknown[] {
	return writes.map((write) => JSON.parse(write.trim()));
}

const clients: RpcClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		try {
			await client.kill(1);
		} catch {
			// ignore cleanup errors in tests
		}
	}
});

describe("RpcClient", () => {
	it("spawns pi in rpc mode with args/env derived from AgentConfig and cleans temp prompt files", () => {
		const child = new FakeChildProcess();
		const calls: SpawnCall[] = [];
		const client = new RpcClient({
			config: createAgentConfig({
				model: "claude-sonnet-4-5",
				thinking: "high",
				tools: ["read", "bash"],
				noExtensions: true,
				extensions: ["/tmp/ext-a.ts", "/tmp/ext-b.ts"],
				noSkills: true,
				skills: ["/tmp/skill-a"],
				systemPrompt: "system prompt text",
			}),
			agentId: "agent-123",
			trunkId: "trunk-456",
			dbPath: "/tmp/threading.db",
			sessionPath: "/tmp/sessions/agent-123.jsonl",
			parentId: "parent-789",
			cwd: "/tmp/project",
			env: { CUSTOM_ENV: "1" },
			cliPath: "/tmp/pi-cli.js",
			spawnImpl: ((command, args, options) => {
				calls.push({ command, args, options: options as SpawnCall["options"] });
				return child as any;
			}) as any,
		});
		clients.push(client);

		assert.equal(calls.length, 1);
		const [{ command, args, options }] = calls;
		assert.equal(command, process.execPath);
		assert.equal(args[0], "/tmp/pi-cli.js");
		assert.deepEqual(args.slice(1, 9), [
			"--mode",
			"rpc",
			"--model",
			"claude-sonnet-4-5",
			"--thinking",
			"high",
			"--tools",
			"read,bash",
		]);
		assert.ok(args.includes("--session"));
		assert.ok(args.includes("/tmp/sessions/agent-123.jsonl"));
		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("-e"));
		assert.ok(args.includes("/tmp/ext-a.ts"));
		assert.ok(args.includes("/tmp/ext-b.ts"));
		assert.ok(args.includes("--no-skills"));
		assert.ok(args.includes("--skill"));
		assert.ok(args.includes("/tmp/skill-a"));

		const promptPath = args[args.indexOf("--append-system-prompt") + 1];
		assert.ok(existsSync(promptPath));
		assert.equal(readSystemPromptFile(promptPath), "system prompt text");

		assert.equal(options.cwd, "/tmp/project");
		assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(options.shell, false);
		assert.equal(options.env?.PI_THREADING_TRUNK_ID, "trunk-456");
		assert.equal(options.env?.PI_THREADING_DB_PATH, "/tmp/threading.db");
		assert.equal(options.env?.PI_THREADING_AGENT_ID, "agent-123");
		assert.equal(options.env?.PI_THREADING_PARENT_ID, "parent-789");
		assert.equal(options.env?.CUSTOM_ENV, "1");

		child.emit("close", 0, null);
		assert.equal(existsSync(dirname(promptPath)), false);
	});

	it("writes prompt, steer, abort, and extension_ui_response as JSONL", () => {
		const child = new FakeChildProcess();
		const client = new RpcClient({
			config: createAgentConfig({ systemPrompt: "" }),
			agentId: "agent-1",
			trunkId: "trunk-1",
			dbPath: "/tmp/db.sqlite",
			sessionPath: "/tmp/session.jsonl",
			spawnImpl: (() => child as any) as any,
		});
		clients.push(client);

		client.prompt("first task");
		client.steer("do this instead");
		client.abort();
		client.respondToUiRequest("req-1", { value: "yes" });

		const writes = parseWrites(child.stdin.writes);
		assert.deepEqual(writes, [
			{ type: "prompt", message: "first task" },
			{ type: "steer", message: "do this instead" },
			{ type: "abort" },
			{ type: "extension_ui_response", id: "req-1", value: "yes" },
		]);
	});

	it("correlates getState and getMessages responses by id", async () => {
		const child = new FakeChildProcess();
		const client = new RpcClient({
			config: createAgentConfig({ systemPrompt: "" }),
			agentId: "agent-1",
			trunkId: "trunk-1",
			dbPath: "/tmp/db.sqlite",
			sessionPath: "/tmp/session.jsonl",
			spawnImpl: (() => child as any) as any,
		});
		clients.push(client);

		const statePromise = client.getState();
		const messagesPromise = client.getMessages();

		const requests = parseWrites(child.stdin.writes) as Array<{ id: string; type: string }>;
		assert.equal(requests.length, 2);
		assert.equal(requests[0].type, "get_state");
		assert.equal(requests[1].type, "get_messages");

		child.stdout.emit(
			"data",
			`${JSON.stringify({
				id: requests[1].id,
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] },
			})}\n`,
		);
		child.stdout.emit(
			"data",
			`${JSON.stringify({
				id: requests[0].id,
				type: "response",
				command: "get_state",
				success: true,
				data: {
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					sessionId: "sess-1",
					autoCompactionEnabled: true,
					messageCount: 1,
					pendingMessageCount: 0,
				},
			})}\n`,
		);

		const state = await statePromise;
		const messages = await messagesPromise;
		assert.equal(state.sessionId, "sess-1");
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0], { role: "assistant", content: [{ type: "text", text: "hi" }] });
	});

	it("parses stdout JSONL with partial chunks and flushes final line on stdout end", async () => {
		const child = new FakeChildProcess();
		const client = new RpcClient({
			config: createAgentConfig({ systemPrompt: "" }),
			agentId: "agent-1",
			trunkId: "trunk-1",
			dbPath: "/tmp/db.sqlite",
			sessionPath: "/tmp/session.jsonl",
			spawnImpl: (() => child as any) as any,
		});
		clients.push(client);

		const uiRequests: unknown[] = [];
		const messageEnds: unknown[] = [];
		client.on("extension_ui_request", (event) => uiRequests.push(event));
		client.on("message_end", (event) => messageEnds.push(event));

		const first = JSON.stringify({
			type: "extension_ui_request",
			id: "q-1",
			method: "input",
			title: "Need answer",
			reasoning: "Need a user choice",
			context: "working on auth",
		});
		const second = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});

		child.stdout.emit("data", first.slice(0, 18));
		child.stdout.emit("data", `${first.slice(18)}\n${second.slice(0, 20)}`);
		child.stdout.emit("data", second.slice(20));
		child.stdout.emit("end");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(uiRequests.length, 1);
		assert.equal(messageEnds.length, 1);
		assert.deepEqual(uiRequests[0], {
			type: "extension_ui_request",
			id: "q-1",
			method: "input",
			title: "Need answer",
			reasoning: "Need a user choice",
			context: "working on auth",
		});
	});

	it("captures stderr, emits exit, and rejects pending requests when the process exits", async () => {
		const child = new FakeChildProcess();
		const client = new RpcClient({
			config: createAgentConfig({ systemPrompt: "" }),
			agentId: "agent-1",
			trunkId: "trunk-1",
			dbPath: "/tmp/db.sqlite",
			sessionPath: "/tmp/session.jsonl",
			spawnImpl: (() => child as any) as any,
		});
		clients.push(client);

		const exits: Array<[number | null, NodeJS.Signals | null]> = [];
		client.on("exit", (code, signal) => exits.push([code, signal]));
		const pending = client.getState();

		child.stderr.emit("data", "stderr line 1\n");
		child.stderr.emit("data", "stderr line 2\n");
		child.emit("close", 7, "SIGTERM");

		await assert.rejects(pending, /RPC process exited/);
		assert.equal(client.getStderr(), "stderr line 1\nstderr line 2\n");
		assert.equal(client.isAlive(), false);
		assert.deepEqual(exits, [[7, "SIGTERM"]]);
	});

	it("kill() follows abort -> wait -> SIGTERM -> wait -> SIGKILL", async () => {
		const child = new FakeChildProcess();
		child.autoCloseOnSignal = "SIGKILL";
		const client = new RpcClient({
			config: createAgentConfig({ systemPrompt: "" }),
			agentId: "agent-1",
			trunkId: "trunk-1",
			dbPath: "/tmp/db.sqlite",
			sessionPath: "/tmp/session.jsonl",
			spawnImpl: (() => child as any) as any,
		});
		clients.push(client);

		await client.kill(1);

		const writes = parseWrites(child.stdin.writes);
		assert.deepEqual(writes, [{ type: "abort" }]);
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(client.isAlive(), false);
	});
});
