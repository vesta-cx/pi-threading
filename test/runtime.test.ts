/**
 * Tests for src/runtime.ts.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentConfig } from "../src/agents.js";
import { type FinishTaskResult, type PendingQuestion, ThreadRuntime } from "../src/runtime.js";
import { createStore, type Store } from "../src/store.js";

class FakeRpcClient extends EventEmitter {
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly responses: Array<{ id: string; response: unknown }> = [];
	readonly killTimeouts: number[] = [];
	alive = true;
	stderr = "";
	autoExitOnKill = true;
	messages: unknown[] = [];

	prompt(message: string): void {
		this.prompts.push(message);
	}

	steer(message: string): void {
		this.steers.push(message);
	}

	async kill(timeout = 1000): Promise<void> {
		this.killTimeouts.push(timeout);
		this.alive = false;
		if (this.autoExitOnKill) {
			this.emit("exit", 0, "SIGTERM");
		}
	}

	respondToUiRequest(id: string, response: unknown): void {
		this.responses.push({ id, response });
	}

	async getMessages(): Promise<unknown[]> {
		return this.messages;
	}

	getStderr(): string {
		return this.stderr;
	}

	isAlive(): boolean {
		return this.alive;
	}
}

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Worker agent",
		aliases: [],
		systemPrompt: "You are a worker.",
		source: "pi",
		filePath: "/fake/worker.md",
		...overrides,
	};
}

function assistantMessage(
	text: string,
	usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 0.25, totalTokens: 18 },
) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: {
				input: 0.1,
				output: 0.1,
				cacheRead: 0.01,
				cacheWrite: 0.04,
				total: usage.total,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

let store: Store;
let sessionRootDir: string;

beforeEach(() => {
	store = createStore(":memory:");
	sessionRootDir = mkdtempSync(join(tmpdir(), "runtime-test-"));
});

afterEach(() => {
	store.close();
	rmSync(sessionRootDir, { recursive: true, force: true });
});

describe("ThreadRuntime", () => {
	it("spawn() creates a trunk, starts a client, persists a running agent, and builds the tree", () => {
		const clients: FakeRpcClient[] = [];
		const spawnCwds: Array<string | undefined> = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: (options) => {
				const client = new FakeRpcClient();
				clients.push(client);
				spawnCwds.push(options.cwd);
				return client;
			},
		});

		const root = runtime.spawn(createAgentConfig({ cwd: "/tmp/project" }), "Inspect the repo");
		const child = runtime.spawn(createAgentConfig({ name: "reviewer" }), "Review the repo", { parentId: root.id });

		assert.equal(clients.length, 2);
		assert.deepEqual(spawnCwds, ["/tmp/project", undefined]);
		assert.deepEqual(clients[0].prompts, ["Inspect the repo"]);
		assert.deepEqual(clients[1].prompts, ["Review the repo"]);

		const rootAgent = store.getAgent(root.id);
		const childAgent = store.getAgent(child.id);
		assert.ok(rootAgent);
		assert.ok(childAgent);
		assert.equal(rootAgent?.status, "running");
		assert.equal(childAgent?.status, "running");
		assert.ok(rootAgent?.sessionPath);
		assert.equal(existsSync(dirname(rootAgent?.sessionPath ?? "")), true);
		assert.equal(runtime.listChildren().length, 1);
		assert.equal(runtime.listChildren(root.id).length, 1);
		assert.equal(runtime.getTree().children[0]?.id, root.id);
		assert.equal(runtime.getTree().children[0]?.children[0]?.id, child.id);
		assert.equal(root.getResult(), null);

		root.steer("Keep going");
		assert.deepEqual(clients[0].steers, ["Keep going"]);
	});

	it("aggregates usage from message_end and emits agent:activity for tool and message events", () => {
		const client = new FakeRpcClient();
		const activities: string[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Do work");
		runtime.on("agent:activity", (_agentId, activity) => activities.push(activity.kind));

		client.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
		});
		client.emit("message_end", {
			type: "message_end",
			message: assistantMessage("Finished reading the README."),
		});

		const agent = store.getAgent(handle.id);
		assert.ok(agent?.usage);
		assert.deepEqual(agent?.usage, {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cost: 0.25,
			contextTokens: 18,
			turns: 1,
		});
		assert.deepEqual(activities, ["tool_execution_start", "message_end"]);
		assert.equal(runtime.getTreeCost(), 0.25);
	});

	it("ignores malformed assistant usage payloads instead of throwing", () => {
		const client = new FakeRpcClient();
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Do work");
		assert.doesNotThrow(() => {
			client.emit("message_end", {
				type: "message_end",
				message: {
					...assistantMessage("Still working"),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 18,
					},
				},
			});
		});
		assert.equal(store.getAgent(handle.id)?.usage, null);
	});

	it("stores pending questions and answers them through the active client", () => {
		const client = new FakeRpcClient();
		const questions: PendingQuestion[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Ask if you get stuck");
		runtime.on("agent:question", (_agentId, question) => questions.push(question));

		client.emit("extension_ui_request", {
			type: "extension_ui_request",
			id: "q-1",
			method: "input",
			title: "Need a decision",
			placeholder: "enter answer",
		});

		assert.equal(runtime.getPendingQuestions().length, 1);
		assert.equal(questions[0]?.agentId, handle.id);

		runtime.answerQuestion(handle.id, "Ship it");

		assert.equal(runtime.getPendingQuestions().length, 0);
		assert.deepEqual(client.responses, [{ id: "q-1", response: { value: "Ship it" } }]);
	});

	it("captures finish_task results, emits completion, and marks the agent exited on process exit", () => {
		const client = new FakeRpcClient();
		const completed: FinishTaskResult[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Finish the task");
		runtime.on("agent:completed", (_agentId, result) => completed.push(result));

		client.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-9",
			toolName: "finish_task",
			result: { summary: "Indexed the repo", artifacts: ["src/runtime.ts"] },
			isError: false,
		});
		client.emit("exit", 0, null);

		assert.deepEqual(completed, [
			{
				summary: "Indexed the repo",
				artifacts: ["src/runtime.ts"],
				source: "finish_task",
				data: { summary: "Indexed the repo", artifacts: ["src/runtime.ts"] },
			},
		]);
		assert.deepEqual(runtime.getResult(handle.id), completed[0]);
		assert.equal(store.getAgent(handle.id)?.status, "exited");
	});

	it("detects crashes, synthesizes a fallback summary, and emits agent:crashed", () => {
		const client = new FakeRpcClient();
		client.stderr = "subprocess exploded";
		const crashes: string[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Try your best");
		runtime.on("agent:crashed", (_agentId, error) => crashes.push(error.summary));

		client.emit("message_end", {
			type: "message_end",
			message: assistantMessage("Last known status: indexing src/ directory."),
		});
		client.emit("exit", 1, "SIGTERM");

		assert.equal(store.getAgent(handle.id)?.status, "crashed");
		assert.equal(runtime.getResult(handle.id)?.summary, "Last known status: indexing src/ directory.");
		assert.deepEqual(crashes, ["Last known status: indexing src/ directory."]);
	});

	it("prefers the latest tool activity over stale assistant text in crash summaries", () => {
		const client = new FakeRpcClient();
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 5,
			maxTreeDepth: 5,
			maxTreeAgents: 10,
			rpcClientFactory: () => client,
		});

		const handle = runtime.spawn(createAgentConfig(), "Try your best");
		client.emit("message_end", {
			type: "message_end",
			message: assistantMessage("Planning next step."),
		});
		client.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "npm test" },
		});
		client.emit("exit", 1, "SIGTERM");

		assert.equal(runtime.getResult(handle.id)?.summary, "Agent crashed while running tool bash.");
	});

	it("enforces max_children, max_tree_depth, and max_tree_agents", () => {
		const clients: FakeRpcClient[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 1,
			maxTreeDepth: 2,
			maxTreeAgents: 2,
			rpcClientFactory: () => {
				const client = new FakeRpcClient();
				clients.push(client);
				return client;
			},
		});

		runtime.spawn(createAgentConfig({ name: "root-worker" }), "Root job");
		assert.throws(
			() => runtime.spawn(createAgentConfig({ name: "second-root" }), "Too many root children"),
			/max_children exceeded/,
		);

		const depthRuntimeStore = createStore(":memory:");
		const childRuntime = new ThreadRuntime(depthRuntimeStore, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 3,
			maxTreeDepth: 1,
			maxTreeAgents: 10,
			rpcClientFactory: () => new FakeRpcClient(),
		});
		const depthRoot = childRuntime.spawn(createAgentConfig(), "depth root");
		assert.throws(
			() => childRuntime.spawn(createAgentConfig({ name: "too-deep" }), "depth child", { parentId: depthRoot.id }),
			/max_tree_depth exceeded/,
		);
		depthRuntimeStore.close();

		const countRuntimeStore = createStore(":memory:");
		const countRuntime = new ThreadRuntime(countRuntimeStore, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 10,
			maxTreeDepth: 10,
			maxTreeAgents: 1,
			rpcClientFactory: () => new FakeRpcClient(),
		});
		countRuntime.spawn(createAgentConfig(), "only child");
		assert.throws(
			() => countRuntime.spawn(createAgentConfig({ name: "overflow" }), "too many agents"),
			/max_tree_agents exceeded/,
		);
		countRuntimeStore.close();
	});

	it("keeps an existing empty trunk when client construction fails", () => {
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 10,
			maxTreeDepth: 10,
			maxTreeAgents: 10,
			rpcClientFactory: () => {
				throw new Error("spawn failed");
			},
		});
		const trunk = store.createTrunk({ id: "existing-trunk" });
		(runtime as any).trunkId = trunk.id;

		assert.throws(() => runtime.spawn(createAgentConfig(), "Will fail"), /spawn failed/);
		assert.ok(store.getTrunk(trunk.id));
		assert.deepEqual(store.getAgentsInTrunk(trunk.id), []);
	});

	it("shutdown() kills active agents and marks the trunk completed", async () => {
		const clients: FakeRpcClient[] = [];
		const runtime = new ThreadRuntime(store, {
			dbPath: "/tmp/threading.db",
			sessionRootDir,
			maxChildren: 10,
			maxTreeDepth: 10,
			maxTreeAgents: 10,
			rpcClientFactory: () => {
				const client = new FakeRpcClient();
				clients.push(client);
				return client;
			},
		});

		const first = runtime.spawn(createAgentConfig({ name: "first" }), "One");
		const second = runtime.spawn(createAgentConfig({ name: "second" }), "Two");
		const trunkId = store.getAgent(first.id)?.trunkId;
		assert.ok(trunkId);

		await runtime.shutdown();

		assert.deepEqual(
			clients.map((client) => client.killTimeouts),
			[[5000], [5000]],
		);
		assert.equal(store.getAgent(first.id)?.status, "killed");
		assert.equal(store.getAgent(second.id)?.status, "killed");
		assert.equal(store.getTrunk(trunkId ?? "")?.status, "completed");
	});
});
