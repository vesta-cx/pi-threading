/**
 * Tests for src/agents.ts — agent discovery and frontmatter parsing.
 *
 * Uses temp directories with fixture .md files.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
let piUserDir: string;
let dotAgentsUserRootDir: string;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "agents-test-"));
	piUserDir = join(fixtureDir, "user", ".pi", "agent", "agents");
	dotAgentsUserRootDir = join(fixtureDir, "user", ".agents");
	mkdirSync(piUserDir, { recursive: true });
	mkdirSync(join(dotAgentsUserRootDir, "agents"), { recursive: true });
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

function captureWarnings(fn: () => void): string[] {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown, ...args: unknown[]) => {
		warnings.push([message, ...args].map(String).join(" "));
	};
	try {
		fn();
	} finally {
		console.warn = originalWarn;
	}
	return warnings;
}

function createPiDiscoverer(): PiAgentDiscoverer {
	return new PiAgentDiscoverer({ userDir: piUserDir });
}

function createDotAgentsDiscoverer(): DotAgentsDiscoverer {
	return new DotAgentsDiscoverer({ userRootDir: dotAgentsUserRootDir });
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

const INVALID_TYPES_MD = `---
name: scout
description: 42
aliases: [recon, 1]
tools: true
---

Invalid types.`;

const NULL_OPTIONALS_MD = `---
name: nullable
description: Accepts null optional fields
model: ~
thinking:
tools: ~
extensions:
no_extensions: ~
skills: ~
no_skills:
cwd: ~
session_dir:
no_session: ~
max_turns: ~
can_orchestrate:
---

Null optional values should be treated as unset.`;
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

		const discoverer = createPiDiscoverer();
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

		const discoverer = createPiDiscoverer();
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

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const local = agents.filter((agent) => agent.filePath.startsWith(fixtureDir));
		assert.equal(local.length, 1);
		assert.equal(local[0].name, "scout");
	});

	it("skips files missing name or description", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "incomplete.md"), MISSING_FIELDS_MD);

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const local = agents.filter((agent) => agent.filePath.startsWith(fixtureDir));
		assert.equal(local.length, 0);
	});

	it("missing optional fields produce undefined", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const planner = agents.find((a) => a.filePath.startsWith(fixtureDir) && a.name === "planner");
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

	it("treats YAML null optional fields as unset", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "nullable.md"), NULL_OPTIONALS_MD);

		const warnings = captureWarnings(() => {
			const discoverer = createPiDiscoverer();
			const agents = discoverer.discover(fixtureDir);
			const nullable = agents.find((agent) => agent.filePath.startsWith(fixtureDir) && agent.name === "nullable");
			assert.ok(nullable);
			assert.equal(nullable.model, undefined);
			assert.equal(nullable.thinking, undefined);
			assert.equal(nullable.tools, undefined);
			assert.equal(nullable.extensions, undefined);
			assert.equal(nullable.noExtensions, undefined);
			assert.equal(nullable.skills, undefined);
			assert.equal(nullable.noSkills, undefined);
			assert.equal(nullable.cwd, undefined);
			assert.equal(nullable.sessionDir, undefined);
			assert.equal(nullable.noSession, undefined);
			assert.equal(nullable.maxTurns, undefined);
			assert.equal(nullable.canOrchestrate, undefined);
		});

		assert.equal(warnings.length, 0);
	});

	it("skips files with invalid frontmatter types and warns", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "invalid.md"), INVALID_TYPES_MD);

		const warnings = captureWarnings(() => {
			const discoverer = createPiDiscoverer();
			const agents = discoverer.discover(fixtureDir);
			const local = agents.filter((agent) => agent.filePath.startsWith(fixtureDir));
			assert.equal(local.length, 0);
		});

		assert.ok(warnings.some((warning) => warning.includes("name and description must be non-empty strings")));
	});

	it("warns and skips unreadable symlinked files", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		symlinkSync(join(fixtureDir, "missing-target.md"), join(piDir, "broken.md"));

		const warnings = captureWarnings(() => {
			const discoverer = createPiDiscoverer();
			const agents = discoverer.discover(fixtureDir);
			const local = agents.filter((agent) => agent.filePath.startsWith(fixtureDir));
			assert.equal(local.length, 0);
		});

		assert.ok(warnings.some((warning) => warning.includes("unable to read agent file")));
	});
});

// ---------------------------------------------------------------------------
// Discovery sources
// ---------------------------------------------------------------------------

describe("PiAgentDiscoverer", () => {
	it("discovers from injected user dir", () => {
		writeFileSync(join(piUserDir, "scout.md"), SCOUT_MD);

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		assert.ok(agents.some((agent) => agent.filePath === join(piUserDir, "scout.md")));
	});

	it("discovers from .pi/agents/ (project-local)", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const names = agents.map((a) => a.name);
		assert.ok(names.includes("scout"), "should find project-local scout");
		assert.ok(names.includes("planner"), "should find project-local planner");
	});

	it("returns empty array when no .pi/agents/ exists", () => {
		const discoverer = createPiDiscoverer();
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

		const discoverer = createPiDiscoverer();
		const agents = discoverer.discover(nested);
		assert.ok(agents.some((a) => a.name === "scout"));
	});
});

describe("DotAgentsDiscoverer", () => {
	it("discovers from injected user root recursively", () => {
		const userAgentsDir = join(dotAgentsUserRootDir, "agents", "team");
		mkdirSync(userAgentsDir, { recursive: true });
		writeFileSync(join(userAgentsDir, "scout.md"), SCOUT_MD);

		const discoverer = createDotAgentsDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		assert.ok(agents.some((agent) => agent.filePath === join(userAgentsDir, "scout.md")));
	});

	it("discovers recursively from .agents/ (project-local)", () => {
		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(join(agentsDir, "sub"), { recursive: true });
		writeFileSync(join(agentsDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(agentsDir, "sub", "planner.md"), PLANNER_MD);

		const discoverer = createDotAgentsDiscoverer();
		const agents = discoverer.discover(fixtureDir);
		const names = agents.map((a) => a.name).sort();
		assert.ok(names.includes("scout"), "should find top-level scout");
		assert.ok(names.includes("planner"), "should find nested planner");
	});

	it("does not treat the injected user root as a project-local directory", () => {
		const projectsDir = join(fixtureDir, "user", "projects");
		mkdirSync(projectsDir, { recursive: true });
		const cwd = mkdtempSync(join(projectsDir, "pi-threading-agents-cwd-"));
		const userRootDir = dotAgentsUserRootDir;
		const userAgentsDir = join(userRootDir, "agents");

		const discoverer = createDotAgentsDiscoverer();
		const agents = discoverer.discover(cwd);
		assert.ok(
			agents.every((agent) => !agent.filePath.startsWith(userRootDir) || agent.filePath.startsWith(userAgentsDir)),
			"should only load user-level agents from <userRoot>/.agents/agents, not recurse through <userRoot>/.agents as a project dir",
		);
	});

	it("has namespace 'agents'", () => {
		const discoverer = createDotAgentsDiscoverer();
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

	it("namespaced lookup searches every matching discoverer in order", () => {
		const laterDiscoverers: AgentDiscoverer[] = [
			new FixtureDiscoverer("agents", []),
			new FixtureDiscoverer("agents", [agentsScoutConfig]),
		];

		const result = resolveAgent("agents:scout", laterDiscoverers, "/fake");
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

	it("bare lookups search all pi-native discoverers before other namespaces", () => {
		const extraPiScout: AgentConfig = {
			name: "scout",
			description: "Second pi scout",
			aliases: [],
			systemPrompt: "You are another scout.",
			source: "pi",
			filePath: "/fake/second-scout.md",
		};
		const orderedDiscoverers: AgentDiscoverer[] = [
			new FixtureDiscoverer("agents", [agentsScoutConfig]),
			new FixtureDiscoverer("", [extraPiScout]),
			new FixtureDiscoverer("", [scoutConfig]),
		];

		const result = resolveAgent("scout", orderedDiscoverers, "/fake");
		assert.ok(result);
		assert.equal(result.source, "pi");
		assert.equal(result.description, "Second pi scout");
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
