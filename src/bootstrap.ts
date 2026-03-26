/**
 * Native dependency bootstrap for better-sqlite3.
 *
 * Attempts to load better-sqlite3. If the prebuilt binary doesn't match
 * the platform, triggers `npm rebuild` in the package directory and retries.
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let _bootstrapped = false;
let _available = false;
let _error: string | null = null;

function getPackageDir(): string {
	const thisFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
	// src/bootstrap.ts -> package root
	return resolve(dirname(thisFile), "..");
}

let _lastError: unknown = null;

function tryRequire(): boolean {
	try {
		require("better-sqlite3");
		return true;
	} catch (err) {
		_lastError = err;
		return false;
	}
}

function tryRebuild(): boolean {
	const pkgDir = getPackageDir();
	try {
		execSync("npm rebuild better-sqlite3", {
			cwd: pkgDir,
			stdio: "pipe",
			timeout: 60_000,
		});
		return tryRequire();
	} catch (err) {
		_lastError = err;
		return false;
	}
}

export function bootstrapSqlite(): { available: boolean; error: string | null } {
	if (_bootstrapped) {
		return { available: _available, error: _error };
	}
	_bootstrapped = true;

	if (tryRequire()) {
		_available = true;
		return { available: true, error: null };
	}

	// Prebuilt binary didn't match — attempt rebuild
	if (tryRebuild()) {
		_available = true;
		return { available: true, error: null };
	}

	const detail = _lastError instanceof Error ? _lastError.message : String(_lastError ?? "unknown error");
	_error = [
		"pi-threading: Failed to load better-sqlite3.",
		`Reason: ${detail}`,
		`Try running: cd ${getPackageDir()} && npm rebuild better-sqlite3`,
	].join("\n");
	_available = false;
	return { available: false, error: _error };
}

export function isSqliteAvailable(): boolean {
	return _available;
}
