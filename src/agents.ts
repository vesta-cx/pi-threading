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

/** Fully parsed agent definition loaded from a markdown file's YAML frontmatter. */
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

/** Fields that can be overridden at spawn time without modifying the on-disk agent definition. */
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
	name?: unknown;
	description?: unknown;
	aliases?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	extensions?: unknown;
	no_extensions?: unknown;
	skills?: unknown;
	no_skills?: unknown;
	cwd?: unknown;
	session_dir?: unknown;
	no_session?: unknown;
	max_turns?: unknown;
	can_orchestrate?: unknown;
}

const INVALID_FRONTMATTER = Symbol("invalid-frontmatter");

type InvalidFrontmatter = typeof INVALID_FRONTMATTER;

type ParsedOptional<T> = T | undefined | InvalidFrontmatter;

function warnInvalidAgentFile(filePath: string, message: string): void {
	console.warn(`pi-threading: skipping agent file ${filePath}: ${message}`);
}

function isUnset(value: unknown): value is undefined | null {
	return value === undefined || value === null;
}

function describeValueType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

function parseOptionalString(value: unknown, filePath: string, fieldName: string): ParsedOptional<string> {
	if (isUnset(value)) return undefined;
	if (typeof value !== "string") {
		warnInvalidAgentFile(filePath, `${fieldName} must be a string, got ${describeValueType(value)}`);
		return INVALID_FRONTMATTER;
	}
	return value;
}

function parseOptionalBoolean(value: unknown, filePath: string, fieldName: string): ParsedOptional<boolean> {
	if (isUnset(value)) return undefined;
	if (typeof value !== "boolean") {
		warnInvalidAgentFile(filePath, `${fieldName} must be a boolean, got ${describeValueType(value)}`);
		return INVALID_FRONTMATTER;
	}
	return value;
}

function parseOptionalNumber(value: unknown, filePath: string, fieldName: string): ParsedOptional<number> {
	if (isUnset(value)) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		warnInvalidAgentFile(filePath, `${fieldName} must be a finite number, got ${describeValueType(value)}`);
		return INVALID_FRONTMATTER;
	}
	return value;
}

function parseOptionalStringList(value: unknown, filePath: string, fieldName: string): ParsedOptional<string[]> {
	if (isUnset(value)) return undefined;
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value)) {
		if (!value.every((entry) => typeof entry === "string")) {
			warnInvalidAgentFile(filePath, `${fieldName} must contain only strings`);
			return INVALID_FRONTMATTER;
		}
		return value.map((entry) => entry.trim()).filter(Boolean);
	}

	warnInvalidAgentFile(filePath, `${fieldName} must be a string or string[], got ${describeValueType(value)}`);
	return INVALID_FRONTMATTER;
}

function parseAliases(value: unknown, filePath: string): string[] | InvalidFrontmatter {
	const aliases = parseOptionalStringList(value, filePath, "aliases");
	if (aliases === INVALID_FRONTMATTER) return INVALID_FRONTMATTER;
	return aliases ?? [];
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

	if (
		typeof frontmatter.name !== "string" ||
		frontmatter.name.trim().length === 0 ||
		typeof frontmatter.description !== "string" ||
		frontmatter.description.trim().length === 0
	) {
		warnInvalidAgentFile(filePath, "name and description must be non-empty strings");
		return null;
	}

	const name = frontmatter.name;
	const description = frontmatter.description;
	const aliases = parseAliases(frontmatter.aliases, filePath);
	const model = parseOptionalString(frontmatter.model, filePath, "model");
	const thinking = parseOptionalString(frontmatter.thinking, filePath, "thinking");
	const tools = parseOptionalStringList(frontmatter.tools, filePath, "tools");
	const extensions = parseOptionalStringList(frontmatter.extensions, filePath, "extensions");
	const noExtensions = parseOptionalBoolean(frontmatter.no_extensions, filePath, "no_extensions");
	const skills = parseOptionalStringList(frontmatter.skills, filePath, "skills");
	const noSkills = parseOptionalBoolean(frontmatter.no_skills, filePath, "no_skills");
	const cwd = parseOptionalString(frontmatter.cwd, filePath, "cwd");
	const sessionDir = parseOptionalString(frontmatter.session_dir, filePath, "session_dir");
	const noSession = parseOptionalBoolean(frontmatter.no_session, filePath, "no_session");
	const maxTurns = parseOptionalNumber(frontmatter.max_turns, filePath, "max_turns");
	const canOrchestrate = parseOptionalBoolean(frontmatter.can_orchestrate, filePath, "can_orchestrate");

	function valid<T>(value: ParsedOptional<T>): value is T | undefined {
		return value !== INVALID_FRONTMATTER;
	}

	if (
		!valid(aliases) ||
		!valid(model) ||
		!valid(thinking) ||
		!valid(tools) ||
		!valid(extensions) ||
		!valid(noExtensions) ||
		!valid(skills) ||
		!valid(noSkills) ||
		!valid(cwd) ||
		!valid(sessionDir) ||
		!valid(noSession) ||
		!valid(maxTurns) ||
		!valid(canOrchestrate)
	) {
		return null;
	}

	return {
		name,
		description,
		aliases,
		model,
		thinking,
		tools: tools && tools.length > 0 ? tools : undefined,
		extensions: extensions && extensions.length > 0 ? extensions : undefined,
		noExtensions,
		skills: skills && skills.length > 0 ? skills : undefined,
		noSkills,
		cwd,
		sessionDir,
		noSession,
		maxTurns,
		canOrchestrate,
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

function scanDir(dir: string, source: string, recursive: boolean): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	const agents: AgentConfig[] = [];
	const visit = (current: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			// Directory symlinks return false for isDirectory(), intentionally not followed (prevents cycles)
			if (recursive && entry.isDirectory()) {
				visit(full);
			} else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
				const config = parseAgentFile(full, source);
				if (config) agents.push(config);
			}
		}
	};
	visit(dir);
	return agents;
}

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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Options for overriding default discovery paths (primarily for testing). */
export interface DiscoverOptions {
	piUserDir?: string;
	dotAgentsUserRootDir?: string;
}

/**
 * Discover all agent definitions from the four standard directories.
 *
 * Scans in order (later entries override earlier by name):
 * 1. `~/.pi/agent/agents/*.md` — pi user-level (flat)
 * 2. Nearest `.pi/agents/*.md` — pi project-local (flat)
 * 3. `~/.agents/agents/**\/*.md` — .agents user-level (recursive)
 * 4. Nearest `.agents/**\/*.md` — .agents project-local (recursive)
 *
 * Each agent carries a `source` field (`"pi"` or `"agents"`) indicating
 * where it was loaded from.
 */
export function discoverAgents(cwd: string, options?: DiscoverOptions): AgentConfig[] {
	const piUserDir = options?.piUserDir ?? path.join(getAgentDir(), "agents");
	const dotAgentsRoot = options?.dotAgentsUserRootDir ?? path.join(os.homedir(), ".agents");
	const dotAgentsUserDir = path.join(dotAgentsRoot, "agents");

	// Key by source:name so agents from different sources don't overwrite each other.
	// Within the same source, project-local overrides user-level (scanned second).
	const agents = new Map<string, AgentConfig>();

	// 1. pi user-level (flat)
	for (const a of scanDir(piUserDir, "pi", false)) agents.set(`pi:${a.name}`, a);

	// 2. pi project-local (flat) — overrides pi user-level
	const piProjectDir = findNearestDir(cwd, ".pi", "agents");
	if (piProjectDir) {
		for (const a of scanDir(piProjectDir, "pi", false)) agents.set(`pi:${a.name}`, a);
	}

	// 3. .agents user-level (recursive)
	for (const a of scanDir(dotAgentsUserDir, "agents", true)) agents.set(`agents:${a.name}`, a);

	// 4. .agents project-local (recursive) — overrides .agents user-level, excluding user root
	const dotAgentsProjectDir = findNearestDir(cwd, ".agents");
	if (dotAgentsProjectDir && dotAgentsProjectDir !== dotAgentsRoot) {
		for (const a of scanDir(dotAgentsProjectDir, "agents", true)) agents.set(`agents:${a.name}`, a);
	}

	return Array.from(agents.values());
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an agent by name, alias, or `namespace:name` reference.
 *
 * - Bare names (`scout`) search pi-source agents first, then .agents-source.
 * - Namespaced names (`agents:scout`) search only that source.
 * - Alias resolution is checked after name miss, scoped per source.
 *
 * @returns The first matching `AgentConfig`, or `null` if no agent matches.
 */
export function resolveAgent(nameOrRef: string, cwd: string, options?: DiscoverOptions): AgentConfig | null {
	const colonIdx = nameOrRef.indexOf(":");
	const hasNamespace = colonIdx > 0;
	const namespace = hasNamespace ? nameOrRef.slice(0, colonIdx) : "";
	const name = hasNamespace ? nameOrRef.slice(colonIdx + 1) : nameOrRef;

	const all = discoverAgents(cwd, options);

	if (hasNamespace) {
		const scoped = all.filter((a) => a.source === namespace);
		return findByNameOrAlias(name, scoped);
	}

	// Bare name: search pi-source first, then others
	const piAgents = all.filter((a) => a.source === "pi");
	const otherAgents = all.filter((a) => a.source !== "pi");

	return findByNameOrAlias(name, piAgents) ?? findByNameOrAlias(name, otherAgents);
}

function findByNameOrAlias(name: string, agents: AgentConfig[]): AgentConfig | null {
	const byName = agents.find((a) => a.name === name);
	if (byName) return byName;

	const byAlias = agents.find((a) => a.aliases.includes(name));
	return byAlias ?? null;
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/**
 * Merge inline spawn-time overrides onto a disk-loaded agent config.
 *
 * `undefined` override values are skipped (disk value preserved).
 * `systemPrompt` from overrides replaces the disk value entirely — it is
 * not appended. Identity fields (`name`, `description`, `aliases`, `source`,
 * `filePath`) always come from the disk config.
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
