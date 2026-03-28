/**
 * Native dependency bootstrap for better-sqlite3.
 *
 * Attempts to load better-sqlite3. If the prebuilt binary doesn't match
 * the platform, triggers `npm rebuild` in the package directory and retries.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface BootstrapError {
	summary: string;
	detail: string;
	recovery: string;
}

/**
 * Result of attempting to load better-sqlite3.
 * Check `available` before using the database — if `false`, `error` describes
 * the failure and a suggested recovery command.
 */
export type BootstrapResult = { available: true; error: null } | { available: false; error: BootstrapError };

type TryResult = { ok: true } | { ok: false; error: unknown };

let _cached: BootstrapResult | null = null;

function getPackageDir(): string {
	const thisFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
	return resolve(dirname(thisFile), "..");
}

function formatError(error: unknown): BootstrapError {
	const detail = error instanceof Error ? error.message : String(error ?? "unknown error");
	return {
		summary: "Failed to load better-sqlite3.",
		detail: `Reason: ${detail}`,
		recovery: `Try running: cd ${getPackageDir()} && npm rebuild better-sqlite3`,
	};
}

function tryRequire(): TryResult {
	try {
		require("better-sqlite3");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}

function tryRebuild(): TryResult {
	try {
		const pkgDir = getPackageDir();
		const rebuild = spawnSync("npm", ["rebuild", "better-sqlite3"], {
			cwd: pkgDir,
			stdio: "inherit",
			timeout: 60_000,
			shell: process.platform === "win32",
		});

		if (rebuild.error) return { ok: false, error: rebuild.error };
		if (rebuild.signal) return { ok: false, error: new Error(`npm rebuild terminated by signal ${rebuild.signal}`) };
		if (rebuild.status !== 0)
			return { ok: false, error: new Error(`npm rebuild exited with code ${rebuild.status ?? "unknown"}`) };

		return tryRequire();
	} catch (err) {
		return { ok: false, error: err };
	}
}

/**
 * Load better-sqlite3, rebuilding the native addon if necessary.
 *
 * Results are cached — subsequent calls return the same outcome without
 * re-attempting the load or rebuild. Safe to call from multiple entry
 * points in the same process.
 */
export function bootstrapSqlite(): BootstrapResult {
	if (_cached) return _cached;

	const load = tryRequire();
	if (load.ok) {
		_cached = { available: true, error: null };
		return _cached;
	}

	const rebuild = tryRebuild();
	if (rebuild.ok) {
		_cached = { available: true, error: null };
		return _cached;
	}

	_cached = { available: false, error: formatError(rebuild.error) };
	return _cached;
}
