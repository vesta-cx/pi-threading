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
import { type AgentConfig, type DiscoverOptions, discoverAgents, mergeConfigs, resolveAgent } from "../src/agents.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureDir: string;
let piUserDir: string;
let dotAgentsUserRootDir: string;
let opts: DiscoverOptions;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "agents-test-"));
	piUserDir = join(fixtureDir, "user", ".pi", "agent", "agents");
	dotAgentsUserRootDir = join(fixtureDir, "user", ".agents");
	opts = { piUserDir, dotAgentsUserRootDir };
	mkdirSync(piUserDir, { recursive: true });
	mkdirSync(join(dotAgentsUserRootDir, "agents"), { recursive: true });
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true });
});

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
// Frontmatter parsing (tested through discoverAgents)
// ---------------------------------------------------------------------------

describe("frontmatter parsing", () => {
	it("parses all frontmatter keys correctly", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const agents = discoverAgents(fixtureDir, opts);
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

		const agents = discoverAgents(fixtureDir, opts);
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

		const agents = discoverAgents(fixtureDir, opts);
		const local = agents.filter((a) => a.filePath.startsWith(fixtureDir));
		assert.equal(local.length, 1);
		assert.equal(local[0].name, "scout");
	});

	it("skips files missing name or description", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "incomplete.md"), MISSING_FIELDS_MD);

		const agents = discoverAgents(fixtureDir, opts);
		const local = agents.filter((a) => a.filePath.startsWith(fixtureDir));
		assert.equal(local.length, 0);
	});

	it("missing optional fields produce undefined", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const agents = discoverAgents(fixtureDir, opts);
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
			const agents = discoverAgents(fixtureDir, opts);
			const nullable = agents.find((a) => a.filePath.startsWith(fixtureDir) && a.name === "nullable");
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
			const agents = discoverAgents(fixtureDir, opts);
			const local = agents.filter((a) => a.filePath.startsWith(fixtureDir));
			assert.equal(local.length, 0);
		});

		assert.ok(warnings.some((w) => w.includes("name and description must be non-empty strings")));
	});

	it("warns and skips unreadable symlinked files", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		symlinkSync(join(fixtureDir, "missing-target.md"), join(piDir, "broken.md"));

		const warnings = captureWarnings(() => {
			const agents = discoverAgents(fixtureDir, opts);
			const local = agents.filter((a) => a.filePath.startsWith(fixtureDir));
			assert.equal(local.length, 0);
		});

		assert.ok(warnings.some((w) => w.includes("unable to read agent file")));
	});
});

// ---------------------------------------------------------------------------
// Discovery sources
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
	it("discovers from injected pi user dir", () => {
		writeFileSync(join(piUserDir, "scout.md"), SCOUT_MD);

		const agents = discoverAgents(fixtureDir, opts);
		assert.ok(agents.some((a) => a.filePath === join(piUserDir, "scout.md")));
	});

	it("discovers from .pi/agents/ (project-local)", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(piDir, "planner.md"), PLANNER_MD);

		const agents = discoverAgents(fixtureDir, opts);
		const names = agents.map((a) => a.name);
		assert.ok(names.includes("scout"));
		assert.ok(names.includes("planner"));
	});

	it("returns empty array when no agent dirs exist", () => {
		const agents = discoverAgents(fixtureDir, opts);
		assert.equal(agents.length, 0);
	});

	it("walks up to find nearest .pi/agents/", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const nested = join(fixtureDir, "src", "deep", "nested");
		mkdirSync(nested, { recursive: true });

		const agents = discoverAgents(nested, opts);
		assert.ok(agents.some((a) => a.name === "scout"));
	});

	it("discovers recursively from .agents/ (project-local)", () => {
		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(join(agentsDir, "sub"), { recursive: true });
		writeFileSync(join(agentsDir, "scout.md"), SCOUT_MD);
		writeFileSync(join(agentsDir, "sub", "planner.md"), PLANNER_MD);

		const agents = discoverAgents(fixtureDir, opts);
		const names = agents.map((a) => a.name);
		assert.ok(names.includes("scout"));
		assert.ok(names.includes("planner"));
	});

	it("discovers from injected .agents user root recursively", () => {
		const userAgentsDir = join(dotAgentsUserRootDir, "agents", "team");
		mkdirSync(userAgentsDir, { recursive: true });
		writeFileSync(join(userAgentsDir, "scout.md"), SCOUT_MD);

		const agents = discoverAgents(fixtureDir, opts);
		assert.ok(agents.some((a) => a.filePath === join(userAgentsDir, "scout.md")));
	});

	it("does not treat the user .agents root as a project-local directory", () => {
		const projectsDir = join(fixtureDir, "user", "projects");
		mkdirSync(projectsDir, { recursive: true });
		const cwd = mkdtempSync(join(projectsDir, "test-cwd-"));
		const userRootDir = dotAgentsUserRootDir;
		const userAgentsDir = join(userRootDir, "agents");

		const agents = discoverAgents(cwd, opts);
		assert.ok(
			agents.every((a) => !a.filePath.startsWith(userRootDir) || a.filePath.startsWith(userAgentsDir)),
			"should only load from <userRoot>/agents, not recurse through <userRoot> as a project dir",
		);
	});

	it("project-local agents override user-level agents with the same name", () => {
		writeFileSync(join(piUserDir, "scout.md"), SCOUT_MD);
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		const overrideScout = SCOUT_MD.replace("Fast recon agent", "Project-local scout");
		writeFileSync(join(piDir, "scout.md"), overrideScout);

		const agents = discoverAgents(fixtureDir, opts);
		const scout = agents.find((a) => a.name === "scout");
		assert.ok(scout);
		assert.equal(scout.description, "Project-local scout");
	});
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveAgent", () => {
	it("bare name resolves pi-source first", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(agentsDir, { recursive: true });
		const altScout = SCOUT_MD.replace("Fast recon agent", ".agents scout");
		writeFileSync(join(agentsDir, "scout.md"), altScout);

		const result = resolveAgent("scout", fixtureDir, opts);
		assert.ok(result);
		assert.equal(result.source, "pi");
		assert.equal(result.description, "Fast recon agent");
	});

	it("namespaced name resolves to correct source", () => {
		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "scout.md"), SCOUT_MD);

		const result = resolveAgent("agents:scout", fixtureDir, opts);
		assert.ok(result);
		assert.equal(result.source, "agents");
	});

	it("alias resolution works for bare names", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		const result = resolveAgent("recon", fixtureDir, opts);
		assert.ok(result);
		assert.equal(result.name, "scout");
	});

	it("alias resolution works within namespace", () => {
		const agentsDir = join(fixtureDir, ".agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "scout.md"), SCOUT_MD);

		const result = resolveAgent("agents:recon", fixtureDir, opts);
		assert.ok(result);
		assert.equal(result.name, "scout");
	});

	it("namespaced alias does not cross sources", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		// "recon" is a pi-source alias — should not resolve via agents: prefix
		const result = resolveAgent("agents:recon", fixtureDir, opts);
		assert.equal(result, null);
	});

	it("returns null for unknown name", () => {
		assert.equal(resolveAgent("nonexistent", fixtureDir, opts), null);
	});

	it("returns null for unknown namespace", () => {
		const piDir = join(fixtureDir, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "scout.md"), SCOUT_MD);

		assert.equal(resolveAgent("custom:scout", fixtureDir, opts), null);
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
