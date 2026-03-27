/**
 * Agent definition discovery and frontmatter parsing.
 *
 * Pure logic — no runtime, no process management. Discovers agent markdown
 * files from multiple directory sources, parses YAML frontmatter into typed
 * configs, and resolves names/aliases with namespace awareness.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
	name: string;
	description: string;
	aliases: string[];
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	skills?: string[];
	noSkills?: boolean;
	cwd?: string;
	sessionDir?: string;
	noSession?: boolean;
	maxTurns?: number;
	canOrchestrate?: boolean;
	systemPrompt: string;
	source: string;
	filePath: string;
}

/**
 * Pluggable agent discovery interface.
 * Ship two built-in discoverers; the interface is public API for future extensions.
 */
export interface AgentDiscoverer {
	/** Namespace prefix: "" for pi-native, "agents" for .agents/, etc. */
	namespace: string;
	/** Scan directories and return all valid agent configs found. */
	discover(cwd: string): AgentConfig[];
}

export interface InlineConfigOverrides {
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	skills?: string[];
	noSkills?: boolean;
	cwd?: string;
	sessionDir?: string;
	noSession?: boolean;
	maxTurns?: number;
	canOrchestrate?: boolean;
	systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface RawFrontmatter {
	name?: string;
	description?: string;
	aliases?: string[] | string;
	model?: string;
	thinking?: string;
	tools?: string[] | string;
	extensions?: string[] | string;
	no_extensions?: boolean;
	skills?: string[] | string;
	no_skills?: boolean;
	cwd?: string;
	session_dir?: string;
	no_session?: boolean;
	max_turns?: number;
	can_orchestrate?: boolean;
}

function parseCommaSeparated(value: string | string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseAliases(value: string[] | string | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseAgentFile(filePath: string, source: string): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`pi-threading: unable to read agent file ${filePath}: ${message}`);
		return null;
	}

	let frontmatter: RawFrontmatter;
	let body: string;
	try {
		const parsed = parseFrontmatter<RawFrontmatter>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch {
		console.warn(`pi-threading: skipping malformed agent file: ${filePath}`);
		return null;
	}

	if (!frontmatter.name || !frontmatter.description) {
		console.warn(`pi-threading: skipping agent file missing name/description: ${filePath}`);
		return null;
	}

	const tools = parseCommaSeparated(frontmatter.tools);
	const extensions = parseCommaSeparated(frontmatter.extensions);
	const skills = parseCommaSeparated(frontmatter.skills);

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		aliases: parseAliases(frontmatter.aliases),
		model: frontmatter.model || undefined,
		thinking: frontmatter.thinking || undefined,
		tools: tools && tools.length > 0 ? tools : undefined,
		extensions: extensions && extensions.length > 0 ? extensions : undefined,
		noExtensions: frontmatter.no_extensions ?? undefined,
		skills: skills && skills.length > 0 ? skills : undefined,
		noSkills: frontmatter.no_skills ?? undefined,
		cwd: frontmatter.cwd || undefined,
		sessionDir: frontmatter.session_dir || undefined,
		noSession: frontmatter.no_session ?? undefined,
		maxTurns: frontmatter.max_turns ?? undefined,
		canOrchestrate: frontmatter.can_orchestrate ?? undefined,
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

function loadAgentsFromDir(dir: string, source: string): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const config = parseAgentFile(path.join(dir, entry.name), source);
		if (config) agents.push(config);
	}
	return agents;
}

function loadAgentsRecursive(dir: string, source: string): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	const agents: AgentConfig[] = [];
	const walk = (current: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
				const config = parseAgentFile(full, source);
				if (config) agents.push(config);
			}
		}
	};
	walk(dir);
	return agents;
}

// ---------------------------------------------------------------------------
// Discoverers
// ---------------------------------------------------------------------------

function findNearestDir(cwd: string, ...segments: string[]): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ...segments);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not found, keep walking up
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Discovers agents from pi-native directories:
 * - User-level: `~/.pi/agent/agents/*.md` (flat)
 * - Project-local: `.pi/agents/*.md` (flat, nearest ancestor)
 */
export class PiAgentDiscoverer implements AgentDiscoverer {
	namespace = "";

	discover(cwd: string): AgentConfig[] {
		const userDir = path.join(getAgentDir(), "agents");
		const projectDir = findNearestDir(cwd, ".pi", "agents");

		// User agents first, project agents override by name
		const agents = new Map<string, AgentConfig>();
		for (const a of loadAgentsFromDir(userDir, "pi")) agents.set(a.name, a);
		if (projectDir) {
			for (const a of loadAgentsFromDir(projectDir, "pi")) agents.set(a.name, a);
		}
		return Array.from(agents.values());
	}
}

/**
 * Discovers agents from .agents/ directories:
 * - User-level: `~/.agents/agents/**\/*.md` (recursive)
 * - Project-local: `.agents/**\/*.md` (recursive, nearest ancestor)
 *
 * Namespaced as `agents:`.
 */
export class DotAgentsDiscoverer implements AgentDiscoverer {
	namespace = "agents";

	discover(cwd: string): AgentConfig[] {
		const userRootDir = path.join(os.homedir(), ".agents");
		const userDir = path.join(userRootDir, "agents");
		const nearestDir = findNearestDir(cwd, ".agents");
		const projectDir = nearestDir === userRootDir ? null : nearestDir;

		const agents = new Map<string, AgentConfig>();
		for (const a of loadAgentsRecursive(userDir, "agents")) agents.set(a.name, a);
		if (projectDir) {
			for (const a of loadAgentsRecursive(projectDir, "agents")) agents.set(a.name, a);
		}
		return Array.from(agents.values());
	}
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an agent by name or `namespace:name`.
 *
 * Resolution order:
 * 1. If namespaced (`agents:scout`), search only that discoverer by name then alias.
 * 2. If bare (`scout`), search pi-native first, then other discoverers, by name then alias.
 *
 * Returns null if no agent matches.
 */
export function resolveAgent(nameOrRef: string, discoverers: AgentDiscoverer[], cwd: string): AgentConfig | null {
	const colonIdx = nameOrRef.indexOf(":");
	const hasNamespace = colonIdx > 0;
	const namespace = hasNamespace ? nameOrRef.slice(0, colonIdx) : "";
	const name = hasNamespace ? nameOrRef.slice(colonIdx + 1) : nameOrRef;

	if (hasNamespace) {
		const discoverer = discoverers.find((d) => d.namespace === namespace);
		if (!discoverer) return null;
		return findByNameOrAlias(name, discoverer.discover(cwd));
	}

	// Bare name: search pi-native (namespace "") first, then preserve original order for the rest.
	const piDiscoverer = discoverers.find((discoverer) => discoverer.namespace === "");
	const ordered = piDiscoverer
		? [piDiscoverer, ...discoverers.filter((discoverer) => discoverer !== piDiscoverer)]
		: discoverers;

	for (const discoverer of ordered) {
		const match = findByNameOrAlias(name, discoverer.discover(cwd));
		if (match) return match;
	}

	return null;
}

function findByNameOrAlias(name: string, agents: AgentConfig[]): AgentConfig | null {
	// Exact name match first
	const byName = agents.find((a) => a.name === name);
	if (byName) return byName;

	// Then alias match
	const byAlias = agents.find((a) => a.aliases.includes(name));
	if (byAlias) return byAlias;

	return null;
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/**
 * Merge a disk-loaded config with inline overrides.
 * Inline values replace disk values; `undefined` inline values are skipped.
 * `systemPrompt` from inline replaces entirely (not appended).
 */
export function mergeConfigs(disk: AgentConfig, overrides: InlineConfigOverrides): AgentConfig {
	return {
		...disk,
		model: overrides.model ?? disk.model,
		thinking: overrides.thinking ?? disk.thinking,
		tools: overrides.tools ?? disk.tools,
		extensions: overrides.extensions ?? disk.extensions,
		noExtensions: overrides.noExtensions ?? disk.noExtensions,
		skills: overrides.skills ?? disk.skills,
		noSkills: overrides.noSkills ?? disk.noSkills,
		cwd: overrides.cwd ?? disk.cwd,
		sessionDir: overrides.sessionDir ?? disk.sessionDir,
		noSession: overrides.noSession ?? disk.noSession,
		maxTurns: overrides.maxTurns ?? disk.maxTurns,
		canOrchestrate: overrides.canOrchestrate ?? disk.canOrchestrate,
		systemPrompt: overrides.systemPrompt ?? disk.systemPrompt,
	};
}

// ---------------------------------------------------------------------------
// Default discoverers
// ---------------------------------------------------------------------------

/** Create the standard set of discoverers (pi-native + .agents/). */
export function createDefaultDiscoverers(): AgentDiscoverer[] {
	return [new PiAgentDiscoverer(), new DotAgentsDiscoverer()];
}
