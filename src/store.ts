/**
 * Persistent tree-state store backed by better-sqlite3.
 *
 * Pure data layer — no runtime, no process management, no UI.
 * All operations are synchronous (better-sqlite3 is sync by design).
 */

import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrunkStatus = "active" | "completed" | "abandoned";

export type AgentStatus = "spawned" | "running" | "exited" | "crashed" | "killed";

const VALID_AGENT_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
	spawned: ["running"],
	running: ["exited", "crashed", "killed"],
	exited: [],
	crashed: [],
	killed: [],
};

export interface Trunk {
	id: string;
	parentTrunkId: string | null;
	createdAt: number;
	status: TrunkStatus;
	rootSessionPath: string | null;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface Agent {
	id: string;
	trunkId: string;
	parentAgentId: string | null;
	name: string;
	displayName: string | null;
	task: string | null;
	status: AgentStatus;
	sessionPath: string | null;
	config: Record<string, unknown> | null;
	usage: AgentUsage | null;
	spawnedAt: number;
	exitedAt: number | null;
}

export interface CreateTrunkParams {
	id?: string;
	parentTrunkId?: string | null;
	rootSessionPath?: string | null;
}

export interface CreateAgentParams {
	id?: string;
	trunkId: string;
	parentAgentId?: string | null;
	name: string;
	displayName?: string | null;
	task?: string | null;
	sessionPath?: string | null;
	config?: Record<string, unknown> | null;
}

export interface Store {
	createTrunk(params: CreateTrunkParams): Trunk;
	getTrunk(id: string): Trunk | null;
	updateTrunkStatus(id: string, status: TrunkStatus): void;

	createAgent(params: CreateAgentParams): Agent;
	getAgent(id: string): Agent | null;
	updateAgentStatus(id: string, status: AgentStatus): void;
	updateAgentUsage(id: string, usage: AgentUsage): void;

	getChildren(agentId: string): Agent[];
	getSubtree(agentId: string): Agent[];
	getAncestors(agentId: string): Agent[];

	getTreeCost(trunkId: string): number;
	clearTrunk(trunkId: string): void;

	close(): void;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATIONS: { version: number; sql: string }[] = [
	{
		version: 1,
		sql: `
			CREATE TABLE IF NOT EXISTS trunks (
				id TEXT PRIMARY KEY,
				parent_trunk_id TEXT,
				created_at INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				root_session_path TEXT
			);

			CREATE TABLE IF NOT EXISTS agents (
				id TEXT PRIMARY KEY,
				trunk_id TEXT NOT NULL REFERENCES trunks(id),
				parent_agent_id TEXT,
				name TEXT NOT NULL,
				display_name TEXT,
				task TEXT,
				status TEXT NOT NULL DEFAULT 'spawned',
				session_path TEXT,
				config_json TEXT,
				usage_json TEXT,
				spawned_at INTEGER NOT NULL,
				exited_at INTEGER,
				FOREIGN KEY (parent_agent_id) REFERENCES agents(id)
			);

			CREATE INDEX IF NOT EXISTS idx_agents_trunk ON agents(trunk_id);
			CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
			CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
		`,
	},
];

function runMigrations(db: any): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		);
	`);

	const applied = new Set<number>(
		db
			.prepare("SELECT version FROM schema_version")
			.all()
			.map((row: any) => row.version),
	);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;
		db.exec(migration.sql);
		db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
	}
}

// ---------------------------------------------------------------------------
// Row ↔ domain mappers
// ---------------------------------------------------------------------------

function rowToTrunk(row: any): Trunk {
	return {
		id: row.id,
		parentTrunkId: row.parent_trunk_id ?? null,
		createdAt: row.created_at,
		status: row.status as TrunkStatus,
		rootSessionPath: row.root_session_path ?? null,
	};
}

function rowToAgent(row: any): Agent {
	return {
		id: row.id,
		trunkId: row.trunk_id,
		parentAgentId: row.parent_agent_id ?? null,
		name: row.name,
		displayName: row.display_name ?? null,
		task: row.task ?? null,
		status: row.status as AgentStatus,
		sessionPath: row.session_path ?? null,
		config: row.config_json ? JSON.parse(row.config_json) : null,
		usage: row.usage_json ? JSON.parse(row.usage_json) : null,
		spawnedAt: row.spawned_at,
		exitedAt: row.exited_at ?? null,
	};
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

class StoreImpl implements Store {
	private db: any;

	constructor(db: any) {
		this.db = db;
	}

	// -- Trunks --------------------------------------------------------------

	createTrunk(params: CreateTrunkParams): Trunk {
		const id = params.id ?? crypto.randomUUID();
		const now = Date.now();

		this.db
			.prepare("INSERT INTO trunks (id, parent_trunk_id, created_at, status, root_session_path) VALUES (?, ?, ?, ?, ?)")
			.run(id, params.parentTrunkId ?? null, now, "active", params.rootSessionPath ?? null);

		// Safe: we just inserted this row; if it's missing, the DB is broken.
		const trunk = this.getTrunk(id);
		if (!trunk) throw new Error(`Failed to read back trunk ${id} after insert`);
		return trunk;
	}

	getTrunk(id: string): Trunk | null {
		const row = this.db.prepare("SELECT * FROM trunks WHERE id = ?").get(id);
		return row ? rowToTrunk(row) : null;
	}

	updateTrunkStatus(id: string, status: TrunkStatus): void {
		const trunk = this.getTrunk(id);
		if (!trunk) throw new Error(`Trunk not found: ${id}`);

		this.db.prepare("UPDATE trunks SET status = ? WHERE id = ?").run(status, id);
	}

	// -- Agents --------------------------------------------------------------

	createAgent(params: CreateAgentParams): Agent {
		const id = params.id ?? crypto.randomUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO agents (id, trunk_id, parent_agent_id, name, display_name, task, status, session_path, config_json, usage_json, spawned_at, exited_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				params.trunkId,
				params.parentAgentId ?? null,
				params.name,
				params.displayName ?? null,
				params.task ?? null,
				"spawned",
				params.sessionPath ?? null,
				params.config ? JSON.stringify(params.config) : null,
				null,
				now,
				null,
			);

		// Safe: we just inserted this row; if it's missing, the DB is broken.
		const agent = this.getAgent(id);
		if (!agent) throw new Error(`Failed to read back agent ${id} after insert`);
		return agent;
	}

	getAgent(id: string): Agent | null {
		const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
		return row ? rowToAgent(row) : null;
	}

	updateAgentStatus(id: string, status: AgentStatus): void {
		const agent = this.getAgent(id);
		if (!agent) throw new Error(`Agent not found: ${id}`);

		const allowed = VALID_AGENT_TRANSITIONS[agent.status];
		if (!allowed.includes(status)) {
			throw new Error(
				`Invalid status transition: ${agent.status} → ${status} (allowed: ${allowed.join(", ") || "none"})`,
			);
		}

		const updates: string[] = ["status = ?"];
		const values: unknown[] = [status];

		if (status === "exited" || status === "crashed" || status === "killed") {
			updates.push("exited_at = ?");
			values.push(Date.now());
		}

		values.push(id);
		this.db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...values);
	}

	updateAgentUsage(id: string, usage: AgentUsage): void {
		const agent = this.getAgent(id);
		if (!agent) throw new Error(`Agent not found: ${id}`);

		this.db.prepare("UPDATE agents SET usage_json = ? WHERE id = ?").run(JSON.stringify(usage), id);
	}

	// -- Tree traversal ------------------------------------------------------

	getChildren(agentId: string): Agent[] {
		const rows = this.db.prepare("SELECT * FROM agents WHERE parent_agent_id = ? ORDER BY spawned_at").all(agentId);
		return rows.map(rowToAgent);
	}

	getSubtree(agentId: string): Agent[] {
		const rows = this.db
			.prepare(
				`WITH RECURSIVE subtree(id) AS (
					SELECT id FROM agents WHERE parent_agent_id = ?
					UNION ALL
					SELECT a.id FROM agents a JOIN subtree s ON a.parent_agent_id = s.id
				)
				SELECT agents.* FROM agents JOIN subtree ON agents.id = subtree.id
				ORDER BY agents.spawned_at`,
			)
			.all(agentId);
		return rows.map(rowToAgent);
	}

	getAncestors(agentId: string): Agent[] {
		// Returns ancestors ordered root-first (earliest spawned_at first).
		// The CTE walks upward from child to root via parent_agent_id.
		const rows = this.db
			.prepare(
				`WITH RECURSIVE ancestors(id, depth) AS (
					SELECT parent_agent_id, 1 FROM agents WHERE id = ?
					UNION ALL
					SELECT a.parent_agent_id, ancestors.depth + 1
					FROM agents a JOIN ancestors ON a.id = ancestors.id
					WHERE a.parent_agent_id IS NOT NULL
				)
				SELECT agents.* FROM agents JOIN ancestors ON agents.id = ancestors.id
				ORDER BY ancestors.depth DESC`,
			)
			.all(agentId);
		return rows.map(rowToAgent);
	}

	// -- Aggregation ---------------------------------------------------------

	getTreeCost(trunkId: string): number {
		const row = this.db
			.prepare(
				`SELECT COALESCE(SUM(json_extract(usage_json, '$.cost')), 0) AS total_cost
				FROM agents
				WHERE trunk_id = ? AND usage_json IS NOT NULL`,
			)
			.get(trunkId);
		return row.total_cost;
	}

	// -- Cleanup -------------------------------------------------------------

	clearTrunk(trunkId: string): void {
		this.db.transaction(() => {
			this.db.prepare("DELETE FROM agents WHERE trunk_id = ?").run(trunkId);
			this.db.prepare("DELETE FROM trunks WHERE id = ?").run(trunkId);
		})();
	}

	// -- Lifecycle -----------------------------------------------------------

	close(): void {
		this.db.close();
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open or create a store at the given path.
 * Pass `:memory:` for an ephemeral in-memory database (useful for tests).
 */
export function createStore(dbPath: string): Store {
	const db = new Database(dbPath);

	// Enable WAL for concurrent reads from subagent processes
	db.pragma("journal_mode = WAL");
	// Enforce foreign keys
	db.pragma("foreign_keys = ON");
	// Wait up to 5s for locks instead of failing immediately with SQLITE_BUSY
	db.pragma("busy_timeout = 5000");

	runMigrations(db);

	return new StoreImpl(db);
}
