/**
 * Tests for src/store.ts — SQLite tree-state store.
 *
 * All tests run against in-memory SQLite (:memory:).
 * Uses Node's built-in test runner.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { type AgentUsage, createStore, type Store } from "../src/store.js";

let store: Store;

beforeEach(() => {
	store = createStore(":memory:");
});

/** Assert a value is non-null and return it typed. */
function must<T>(value: T | null | undefined, label = "value"): T {
	assert.ok(value != null, `Expected ${label} to be non-null`);
	return value as T;
}

// ---------------------------------------------------------------------------
// Schema & migrations
// ---------------------------------------------------------------------------

describe("schema", () => {
	it("creates cleanly on fresh DB", () => {
		const trunk = store.createTrunk({});
		assert.ok(trunk.id);
	});

	it("migrations are idempotent (same file opened twice)", () => {
		const dir = mkdtempSync(join(tmpdir(), "store-test-"));
		try {
			const dbPath = join(dir, "test.db");
			const s1 = createStore(dbPath);
			s1.createTrunk({ id: "t1" });
			s1.close();

			// Re-open the same DB — migrations run again, data survives
			const s2 = createStore(dbPath);
			const trunk = must(s2.getTrunk("t1"), "trunk t1 after reopen");
			assert.equal(trunk.id, "t1");
			s2.close();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Trunk CRUD
// ---------------------------------------------------------------------------

describe("trunks", () => {
	it("creates a trunk with defaults", () => {
		const trunk = store.createTrunk({});
		assert.ok(trunk.id);
		assert.equal(trunk.status, "active");
		assert.equal(trunk.parentTrunkId, null);
		assert.equal(trunk.rootSessionPath, null);
		assert.equal(typeof trunk.createdAt, "number");
	});

	it("creates a trunk with explicit fields", () => {
		const trunk = store.createTrunk({
			id: "trunk-1",
			parentTrunkId: null,
			rootSessionPath: "/sessions/trunk-1.jsonl",
		});
		assert.equal(trunk.id, "trunk-1");
		assert.equal(trunk.rootSessionPath, "/sessions/trunk-1.jsonl");
	});

	it("getTrunk returns null for missing ID", () => {
		assert.equal(store.getTrunk("nonexistent"), null);
	});

	it("updateTrunkStatus changes status", () => {
		store.createTrunk({ id: "t1" });

		store.updateTrunkStatus("t1", "completed");
		const trunk = must(store.getTrunk("t1"), "trunk t1");
		assert.equal(trunk.status, "completed");
	});

	it("updateTrunkStatus throws for missing trunk", () => {
		assert.throws(() => store.updateTrunkStatus("nope", "completed"), /Trunk not found/);
	});
});

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

describe("agents", () => {
	it("creates an agent with defaults", () => {
		store.createTrunk({ id: "t1" });
		const agent = store.createAgent({ trunkId: "t1", name: "scout" });

		assert.ok(agent.id);
		assert.equal(agent.trunkId, "t1");
		assert.equal(agent.name, "scout");
		assert.equal(agent.status, "spawned");
		assert.equal(agent.parentAgentId, null);
		assert.equal(agent.displayName, null);
		assert.equal(agent.task, null);
		assert.equal(agent.sessionPath, null);
		assert.equal(agent.config, null);
		assert.equal(agent.usage, null);
		assert.equal(agent.exitedAt, null);
		assert.equal(typeof agent.spawnedAt, "number");
	});

	it("creates an agent with all fields", () => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "root", trunkId: "t1", name: "orchestrator" });
		const config = { model: "claude-sonnet-4-5", thinking: "medium", tools: ["read", "grep"] };

		const agent = store.createAgent({
			id: "a1",
			trunkId: "t1",
			parentAgentId: "root",
			name: "scout",
			displayName: "Scout Alpha",
			task: "Find all TypeScript files",
			sessionPath: "/sessions/a1.jsonl",
			config,
		});

		assert.equal(agent.id, "a1");
		assert.equal(agent.parentAgentId, "root");
		assert.equal(agent.displayName, "Scout Alpha");
		assert.equal(agent.task, "Find all TypeScript files");
		assert.equal(agent.sessionPath, "/sessions/a1.jsonl");
		assert.deepEqual(agent.config, config);
	});

	it("getAgent returns null for missing ID", () => {
		assert.equal(store.getAgent("nonexistent"), null);
	});

	it("rejects self-parenting", () => {
		store.createTrunk({ id: "t1" });
		assert.throws(
			() => store.createAgent({ id: "a1", trunkId: "t1", parentAgentId: "a1", name: "ouroboros" }),
			/cannot be its own parent/,
		);
	});

	it("rejects cross-trunk parenting", () => {
		store.createTrunk({ id: "t1" });
		store.createTrunk({ id: "t2" });
		store.createAgent({ id: "parent", trunkId: "t1", name: "root" });
		assert.throws(
			() => store.createAgent({ id: "child", trunkId: "t2", parentAgentId: "parent", name: "orphan" }),
			/Cross-trunk parenting not allowed/,
		);
	});

	it("rejects parenting under nonexistent agent", () => {
		store.createTrunk({ id: "t1" });
		assert.throws(
			() => store.createAgent({ trunkId: "t1", parentAgentId: "ghost", name: "lost" }),
			/Parent agent not found/,
		);
	});

	it("config_json round-trips correctly", () => {
		store.createTrunk({ id: "t1" });
		const config = {
			model: "claude-haiku-4-5",
			thinking: "low",
			tools: ["read", "grep", "find", "ls", "bash"],
			can_orchestrate: false,
			nested: { deep: { value: 42 } },
		};
		store.createAgent({ id: "a1", trunkId: "t1", name: "scout", config });
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.deepEqual(agent.config, config);
	});
});

// ---------------------------------------------------------------------------
// Agent status transitions
// ---------------------------------------------------------------------------

describe("agent status transitions", () => {
	beforeEach(() => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "worker" });
	});

	it("spawned → running", () => {
		store.updateAgentStatus("a1", "running");
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.equal(agent.status, "running");
	});

	it("running → exited (sets exitedAt)", () => {
		store.updateAgentStatus("a1", "running");
		store.updateAgentStatus("a1", "exited");
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.equal(agent.status, "exited");
		assert.equal(typeof agent.exitedAt, "number");
	});

	it("running → crashed (sets exitedAt)", () => {
		store.updateAgentStatus("a1", "running");
		store.updateAgentStatus("a1", "crashed");
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.equal(agent.status, "crashed");
		assert.ok(agent.exitedAt);
	});

	it("running → killed (sets exitedAt)", () => {
		store.updateAgentStatus("a1", "running");
		store.updateAgentStatus("a1", "killed");
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.equal(agent.status, "killed");
		assert.ok(agent.exitedAt);
	});

	it("rejects spawned → exited", () => {
		assert.throws(() => store.updateAgentStatus("a1", "exited"), /Invalid status transition: spawned → exited/);
	});

	it("rejects spawned → crashed", () => {
		assert.throws(() => store.updateAgentStatus("a1", "crashed"), /Invalid status transition/);
	});

	it("rejects exited → running", () => {
		store.updateAgentStatus("a1", "running");
		store.updateAgentStatus("a1", "exited");
		assert.throws(() => store.updateAgentStatus("a1", "running"), /Invalid status transition: exited → running/);
	});

	it("rejects crashed → running", () => {
		store.updateAgentStatus("a1", "running");
		store.updateAgentStatus("a1", "crashed");
		assert.throws(() => store.updateAgentStatus("a1", "running"), /Invalid status transition/);
	});

	it("throws for missing agent", () => {
		assert.throws(() => store.updateAgentStatus("nope", "running"), /Agent not found/);
	});
});

// ---------------------------------------------------------------------------
// Agent usage
// ---------------------------------------------------------------------------

describe("agent usage", () => {
	const usage: AgentUsage = {
		input: 1000,
		output: 500,
		cacheRead: 200,
		cacheWrite: 100,
		cost: 0.015,
		contextTokens: 8000,
		turns: 3,
	};

	beforeEach(() => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "worker" });
	});

	it("updates and round-trips usage_json", () => {
		store.updateAgentUsage("a1", usage);
		const agent = must(store.getAgent("a1"), "agent a1");
		assert.deepEqual(agent.usage, usage);
	});

	it("throws for missing agent", () => {
		assert.throws(() => store.updateAgentUsage("nope", usage), /Agent not found/);
	});
});

// ---------------------------------------------------------------------------
// Tree traversal
// ---------------------------------------------------------------------------

describe("tree traversal", () => {
	/**
	 * Tree shape:
	 *   root
	 *   ├── scout
	 *   └── planner
	 *       └── worker
	 */
	beforeEach(() => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "root", trunkId: "t1", name: "orchestrator" });
		store.createAgent({ id: "scout", trunkId: "t1", parentAgentId: "root", name: "scout" });
		store.createAgent({ id: "planner", trunkId: "t1", parentAgentId: "root", name: "planner" });
		store.createAgent({ id: "worker", trunkId: "t1", parentAgentId: "planner", name: "worker" });
	});

	it("getChildren returns only direct children", () => {
		const children = store.getChildren("root");
		const names = children.map((a) => a.name);
		assert.deepEqual(names, ["scout", "planner"]);
	});

	it("getChildren returns empty array for leaf", () => {
		assert.deepEqual(store.getChildren("worker"), []);
	});

	it("getSubtree returns full recursive subtree (not including root)", () => {
		const subtree = store.getSubtree("root");
		const names = subtree.map((a) => a.name);
		assert.deepEqual(names, ["scout", "planner", "worker"]);
	});

	it("getSubtree of planner returns only worker", () => {
		const subtree = store.getSubtree("planner");
		assert.equal(subtree.length, 1);
		assert.equal(subtree[0].name, "worker");
	});

	it("getSubtree of leaf returns empty array", () => {
		assert.deepEqual(store.getSubtree("worker"), []);
	});

	it("getAncestors returns path to root", () => {
		const ancestors = store.getAncestors("worker");
		const names = ancestors.map((a) => a.name);
		assert.deepEqual(names, ["orchestrator", "planner"]);
	});

	it("getAncestors of root returns empty array", () => {
		assert.deepEqual(store.getAncestors("root"), []);
	});
});

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

describe("getTreeCost", () => {
	it("aggregates cost across multiple agents", () => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "scout" });
		store.createAgent({ id: "a2", trunkId: "t1", name: "worker" });
		store.createAgent({ id: "a3", trunkId: "t1", name: "reviewer" });

		store.updateAgentUsage("a1", {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 1000,
			turns: 1,
		});
		store.updateAgentUsage("a2", {
			input: 500,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.05,
			contextTokens: 4000,
			turns: 3,
		});
		// a3 has no usage yet

		const cost = store.getTreeCost("t1");
		assert.ok(Math.abs(cost - 0.06) < 1e-10, `Expected ~0.06, got ${cost}`);
	});

	it("returns 0 for trunk with no usage", () => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "scout" });
		assert.equal(store.getTreeCost("t1"), 0);
	});

	it("returns 0 for empty trunk", () => {
		store.createTrunk({ id: "t1" });
		assert.equal(store.getTreeCost("t1"), 0);
	});

	it("scopes cost to the specified trunk only", () => {
		store.createTrunk({ id: "t1" });
		store.createTrunk({ id: "t2" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "scout" });
		store.createAgent({ id: "a2", trunkId: "t2", name: "worker" });

		store.updateAgentUsage("a1", {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 1000,
			turns: 1,
		});
		store.updateAgentUsage("a2", {
			input: 500,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.99,
			contextTokens: 4000,
			turns: 3,
		});

		assert.equal(store.getTreeCost("t1"), 0.01);
		assert.equal(store.getTreeCost("t2"), 0.99);
	});
});

// ---------------------------------------------------------------------------
// clearTrunk
// ---------------------------------------------------------------------------

describe("clearTrunk", () => {
	it("removes all agents and the trunk itself", () => {
		store.createTrunk({ id: "t1" });
		store.createAgent({ id: "root", trunkId: "t1", name: "orch" });
		store.createAgent({ id: "scout", trunkId: "t1", parentAgentId: "root", name: "scout" });

		store.clearTrunk("t1");

		assert.equal(store.getTrunk("t1"), null);
		assert.equal(store.getAgent("root"), null);
		assert.equal(store.getAgent("scout"), null);
	});

	it("does not affect other trunks", () => {
		store.createTrunk({ id: "t1" });
		store.createTrunk({ id: "t2" });
		store.createAgent({ id: "a1", trunkId: "t1", name: "scout" });
		store.createAgent({ id: "a2", trunkId: "t2", name: "worker" });

		store.clearTrunk("t1");

		assert.equal(store.getTrunk("t1"), null);
		assert.ok(store.getTrunk("t2"));
		assert.equal(store.getAgent("a1"), null);
		assert.ok(store.getAgent("a2"));
	});
});
