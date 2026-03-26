/**
 * pi-threading — Recursive subagent orchestration for pi
 *
 * Extension entry point. Detects role (root vs subagent) via environment
 * variables and registers the appropriate tools, commands, and event hooks.
 *
 * Root mode:  orchestrator tools (spawn, list, steer, stop, answer, get_result)
 *             + commands (/subagents, /dump, /clear, /threading)
 *             + visualization (status line, tree widget, message renderers)
 *             + question inbox (Ctrl+I)
 *
 * Subagent mode: subagent tools (ask_question, finish_task)
 *                + context injection (before_agent_start)
 *                + optional orchestrator tools if can_orchestrate
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrapSqlite } from "../src/bootstrap.js";

/** Environment variables set by parent orchestrator on child processes. */
interface ThreadingEnv {
	trunkId: string | undefined;
	dbPath: string | undefined;
	agentId: string | undefined;
	parentId: string | undefined;
}

function readEnv(): ThreadingEnv {
	return {
		trunkId: process.env.PI_THREADING_TRUNK_ID,
		dbPath: process.env.PI_THREADING_DB_PATH,
		agentId: process.env.PI_THREADING_AGENT_ID,
		parentId: process.env.PI_THREADING_PARENT_ID,
	};
}

function isSubagentMode(env: ThreadingEnv): boolean {
	return Boolean(env.agentId && env.dbPath && env.trunkId);
}

export default function piThreading(pi: ExtensionAPI) {
	const env = readEnv();
	const subagent = isSubagentMode(env);

	// Bootstrap native SQLite dependency
	const sqlite = bootstrapSqlite();

	pi.on("session_start", async (_event, ctx) => {
		if (!sqlite.available) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-threading: ${sqlite.error}`, "error");
			}
			return;
		}

		if (!ctx.hasUI) {
			return;
		}

		if (subagent) {
			ctx.ui.setStatus("pi-threading", ctx.ui.theme.fg("dim", `subagent ${env.agentId?.slice(0, 8)}`));
		} else {
			ctx.ui.setStatus("pi-threading", ctx.ui.theme.fg("dim", "ready"));
		}
	});

	// Don't register anything if SQLite failed to load
	if (!sqlite.available) {
		return;
	}

	if (subagent) {
		// --- Subagent mode ---
		// TODO (slice #9): register ask_question, finish_task tools
		// TODO (slice #9): register before_agent_start hook for context injection
	} else {
		// --- Root / orchestrator mode ---
		// TODO (slice #8): register orchestrator tools (spawn, list, steer, stop, answer, get_result)
		// TODO (slice #10): register question routing + idle wake-up
		// TODO (slice #11): register visualization (status line, tree widget, message renderers)
		// TODO (slice #12): register Ctrl+I shortcut + /threading command
		// TODO (slice #13): register /subagents, /dump, /clear commands + shutdown hook
	}
}
