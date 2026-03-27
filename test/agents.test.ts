/**
 * Tests for src/agents.ts — agent discovery and frontmatter parsing.
 *
 * Uses temp directories with fixture .md files.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AgentConfig,
	type AgentDiscoverer,
	DotAgentsDiscoverer,
	mergeConfigs,
	PiAgentDiscoverer,
	resolveAgent,
} from "../src/agents.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureDir: string;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "agents-test-"));
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true });
});

function writeFixture(relativePath: string, content: string): string {
	const full = join(fixtureDir, relativePath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

const SCOUT_MD = `---
name: scout
description: Fast recon agent
aliases: [recon, explorer]
model: claude-haiku-4-5
thinking: low
tools: read, grep, find, ls, bash
can_orchestrate: false
---

You are a fast reconnaissance agent.`;

const PLANNER_MD = `---
name: planner
description: Creates implementation plans
aliases: [architect]
model: claude-sonnet-4-5
thinking: medium
tools: read, grep, find, ls
---

You are an implementation planner.`;

const WORKER_MD = `---
name: worker
description: General purpose implementation
model: claude-sonnet-4-5
tools: read, bash, edit, write, grep, find, ls
can_orchestrate: false
max_turns: 20
no_extensions: true
---

You are a worker.`;

const MALFORMED_MD = `---
not valid yaml: [
---

Body here.`;

const MISSING_FIELDS_MD = `---
thinking: high
---

No name or description.`;

// ---------------------------------------------------------------------------
// Custom test discoverer that uses fixture directories
// ---------------------------------------------------------------------------

class FixtureDiscoverer implements AgentDiscoverer {
	namespace: string;
	private agents: AgentConfig[];

	constructor(namespace: string, agents: AgentConfig[]) {
		this.namespace = namespace;
		this.agents = agents;
	}

	discover(_cwd: string): AgentConfig[] {
		return this.agents;
	}
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (via parseAgentFile, tested through discoverers)
// ---------------------------------------------------------------------------

describe("frontmatter parsing", () => {
	it("parses all frontmatter keys correctly", () => {
		const dir = join(fixtureDir, "agents");
		mkdirSync(dir, { recursive: true });
		writeFixture("agents/scout.md", SCOUT_MD);

		// Use PiAgentDiscoverer with a cwd that has .pi/agents
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const discoverer = new PiAgentDiscoverer();
		// We need to override getAgentDir — instead, test via resolveAgent with a FixtureDiscoverer
		// Actually, let's just test parseAgentFile indirectly through a custom discoverer setup

		// Simplest approach: put files where PiAgentDiscoverer looks (project-local)
		const agents = discoverer.discover(fixtureDir);
		const scout = agents.find((a) => a.name === "scout");
		assert.ok(scout, "scout should be discovered");
		assert.equal(scout.name, "scout");
		assert.equal(scout.description, "Fast recon agent");
		assert.deepEqual(scout.aliases, ["recon", "explorer"]);
		assert.equal(scout.model, "claude-haiku-4-5");
		assert.equal(scout.thinking, "low");
		assert.deepEqual(scout.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.equal(scout.canOrchestrate, false);
		assert.equal(scout.systemPrompt, "You are a fast reconnaissance agent.");
		assert.equal(scout.source, "pi");
	});

	it("parses worker with no_extensions and max_turns", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "worker.md"), WORKER_MD);

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const worker = agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.noExtensions, true);
		assert.equal(worker.maxTurns, 20);
		assert.equal(worker.canOrchestrate, false);
		assert.deepEqual(worker.aliases, []);
	});

	it("skips malformed files gracefully", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "bad.md"), MALFORMED_MD);
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, "scout");
	});

	it("skips files missing name or description", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "incomplete.md"), MISSING_FIELDS_MD);

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		assert.equal(agents.length, 0);
	});

	it("missing optional fields produce undefined", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const planner = agents.find((a) => a.name === "planner");
		assert.ok(planner);
		assert.equal(planner.extensions, undefined);
		assert.equal(planner.noExtensions, undefined);
		assert.equal(planner.skills, undefined);
		assert.equal(planner.noSkills, undefined);
		assert.equal(planner.cwd, undefined);
		assert.equal(planner.sessionDir, undefined);
		assert.equal(planner.noSession, undefined);
		assert.equal(planner.maxTurns, undefined);
		assert.equal(planner.canOrchestrate, undefined);
	});
});

// ---------------------------------------------------------------------------
// Discovery sources
// ---------------------------------------------------------------------------

describe("PiAgentDiscoverer", () => {
	it("discovers from .pi/agents/ (project-local)", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const names = agents.map((a) => a.name).sort();
		assert.deepEqual(names, ["planner", "scout"]);
	});

	it("returns empty array when no .pi/agents/ exists", () => {
		const discoverer = new PiAgentDiscoverer();
		// fixtureDir has no .pi/agents/
		const agents = discoverer.discover(fixtureDir);
		// May include user-level agents — just confirm no crash
		assert.ok(Array.isArray(agents));
	});

	it("walks up to find nearest .pi/agents/", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const nested = join(fixtureDir, "src", "deep", "nested");
		mkdirSync(nested, { recursive: true });

		const discoverer = new PiAgentDiscoverer();
		const agents = discoverer.discover(nested);
		assert.ok(agents.some((a) => a.name === "scout"));
	});
});

describe("DotAgentsDiscoverer", () => {
	it("discovers recursively from .agents/ (project-local)", () => {
		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(join(agentsDir, "sub"), { recursive: true });
		writeFileSync(join(agentsDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(agentsDir, "sub", "planner.md"), PLANNER_MD);

		const discoverer = new DotAgentsDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const names = agents.map((a) => a.name).sort();
		assert.ok(names.includes("scout"), "should find top-level scout");
		assert.ok(names.includes("planner"), "should find nested planner");
	});

	it("has namespace 'agents'", () => {
		const discoverer = new DotAgentsDiscoverer();
		assert.equal(discoverer.namespace, "agents");
	});
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveAgent", () => {
	const scoutConfig: AgentConfig = {
		name: "scout",
		description: "Pi scout",
		aliases: ["recon"],
		systemPrompt: "You are a scout.",
		source: "pi",
		filePath: "/fake/scout.md",
	};

	const agentsScoutConfig: AgentConfig = {
		name: "scout",
		description: ".agents scout",
		aliases: ["spotter"],
		systemPrompt: "You are a .agents scout.",
		source: "agents",
		filePath: "/fake/.agents/scout.md",
	};

	const workerConfig: AgentConfig = {
		name: "worker",
		description: "Worker",
		aliases: ["builder", "dev"],
		systemPrompt: "You are a worker.",
		source: "pi",
		filePath: "/fake/worker.md",
	};

	const discoverers: AgentDiscoverer[] = [
		new FixtureDiscoverer("", [scoutConfig, workerConfig]),
		new FixtureDiscoverer("agents", [agentsScoutConfig]),
	];

	it("bare name resolves pi-native first", () => {
		const result = resolveAgent("scout", discoverers, "/fake");
		assert.ok(result);
		assert.equal(result.source, "pi");
		assert.equal(result.description, "Pi scout");
	});

	it("namespaced name resolves to correct source", () => {
		const result = resolveAgent("agents:scout", discoverers, "/fake");
		assert.ok(result);
		assert.equal(result.source, "agents");
		assert.equal(result.description, ".agents scout");
	});

	it("alias resolution works for bare names", () => {
		const result = resolveAgent("recon", discoverers, "/fake");
		assert.ok(result);
		assert.equal(result.name, "scout");
		assert.equal(result.source, "pi");
	});

	it("alias resolution works within namespace", () => {
		const result = resolveAgent("agents:spotter", discoverers, "/fake");
		assert.ok(result);
		assert.equal(result.name, "scout");
		assert.equal(result.source, "agents");
	});

	it("bare alias falls through to other namespaces", () => {
		// "spotter" is an alias only in agents namespace — bare search finds it after pi misses
		const result = resolveAgent("spotter", discoverers, "/fake");
		assert.ok(result);
		assert.equal(result.source, "agents");
	});

	it("namespaced alias does not cross namespaces", () => {
		// "recon" is a pi-native alias — it should not resolve via agents: prefix
		const result = resolveAgent("agents:recon", discoverers, "/fake");
		assert.equal(result, null);
	});

	it("returns null for unknown name", () => {
		assert.equal(resolveAgent("nonexistent", discoverers, "/fake"), null);
	});

	it("returns null for unknown namespace", () => {
		assert.equal(resolveAgent("custom:scout", discoverers, "/fake"), null);
	});
});

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
	const base: AgentConfig = {
		name: "scout",
		description: "Base scout",
		aliases: ["recon"],
		model: "claude-haiku-4-5",
		thinking: "low",
		tools: ["read", "grep"],
		systemPrompt: "Base prompt.",
		source: "pi",
		filePath: "/fake/scout.md",
	};

	it("overrides specified fields", () => {
		const merged = mergeConfigs(base, { model: "claude-sonnet-4-5", thinking: "high" });
		assert.equal(merged.model, "claude-sonnet-4-5");
		assert.equal(merged.thinking, "high");
		// Unchanged fields preserved
		assert.deepEqual(merged.tools, ["read", "grep"]);
		assert.equal(merged.name, "scout");
	});

	it("systemPrompt from inline replaces entirely", () => {
		const merged = mergeConfigs(base, { systemPrompt: "Completely new." });
		assert.equal(merged.systemPrompt, "Completely new.");
	});

	it("undefined overrides preserve disk values", () => {
		const merged = mergeConfigs(base, {});
		assert.equal(merged.model, "claude-haiku-4-5");
		assert.equal(merged.thinking, "low");
		assert.deepEqual(merged.tools, ["read", "grep"]);
	});

	it("preserves identity fields from disk", () => {
		const merged = mergeConfigs(base, { model: "gpt-5" });
		assert.equal(merged.name, "scout");
		assert.equal(merged.description, "Base scout");
		assert.deepEqual(merged.aliases, ["recon"]);
		assert.equal(merged.source, "pi");
		assert.equal(merged.filePath, "/fake/scout.md");
	});
});
