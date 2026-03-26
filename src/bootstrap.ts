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

export type BootstrapResult = { available: true; error: null } | { available: false; error: BootstrapError };

let _bootstrapped = false;
let _available = false;
let _error: BootstrapError | null = null;

function getPackageDir(): string {
	const thisFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
	// src/bootstrap.ts -> package root
	return resolve(dirname(thisFile), "..");
}

let _lastError: unknown = null;

function createBootstrapError(error: unknown): BootstrapError {
	const detail = error instanceof Error ? error.message : String(error ?? "unknown error");

	return {
		summary: "Failed to load better-sqlite3.",
		detail: `Reason: ${detail}`,
		recovery: `Try running: cd ${getPackageDir()} && npm rebuild better-sqlite3`,
	};
}

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
		const rebuild = spawnSync("npm", ["rebuild", "better-sqlite3"], {
			cwd: pkgDir,
			stdio: "inherit",
			timeout: 60_000,
			shell: process.platform === "win32",
		});

		if (rebuild.error) {
			_lastError = rebuild.error;
			return false;
		}

		if (rebuild.signal) {
			_lastError = new Error(`npm rebuild better-sqlite3 was terminated by signal ${rebuild.signal}`);
			return false;
		}

		if (rebuild.status !== 0) {
			_lastError = new Error(`npm rebuild better-sqlite3 exited with code ${rebuild.status ?? "unknown"}`);
			return false;
		}

		return tryRequire();
	} catch (err) {
		_lastError = err;
		return false;
	}
}

export function bootstrapSqlite(): BootstrapResult {
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

	_error = createBootstrapError(_lastError);
	_available = false;
	return { available: false, error: _error };
}
