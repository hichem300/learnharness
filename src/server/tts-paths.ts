/**
 * Shared path resolution for the local speech runtime (#tts). One small
 * seam so both the worker spawner and the setup installer agree on where
 * runtime/tts actually lives on disk.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Finds runtime/tts on disk. WHY cwd-first: when the app runs from the
 *  Next standalone bundle, bundled import.meta.url points into .next/server
 *  where the traced runtime/tts assets are NOT copied relative to the code;
 *  they ARE at <standalone>/runtime/tts (outputFileTracingIncludes), which
 *  is the server process's cwd (server.js chdirs into its own dir). Dev
 *  runs from the repo root — the same walk works. */
export function resolveRuntimeDir(): string {
	let current = process.cwd();
	for (let hop = 0; hop < 8; hop++) {
		if (existsSync(path.join(current, "runtime", "tts", "models.json"))) {
			return path.join(current, "runtime", "tts");
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Dev direct-import fallback (tsx/tests import these modules without a
	// server cwd): resolve relative to this source file.
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../runtime/tts");
}
