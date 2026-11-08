/**
 * TTS model downloads (#tts): src/server/tts-download.ts. The manifest is
 * trusted (it ships with the app), but the filesystem and network are not:
 * every path is checked against traversal and symlinks, every URL must be
 * HTTPS from an allowed source, and nothing becomes the final file until
 * its SHA256 matches. WHY simple English: arbitrary bytes land on disk here.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export interface ModelFile {
	path: string;
	url: string;
	size: number;
	sha256: string;
}

export interface DownloadProgress {
	downloaded: number;
	total: number;
	file: string;
}

/** Production uses the Node builtins; tests inject a local fake HTTP seam. */
export interface TtsDownloadDeps {
	fetch?: typeof globalThis.fetch;
	statfs?: (directory: string) => Promise<{ available: number }>;
}

/** WHY idle and not total: model files are gigabytes, a slow stream is fine,
 *  a stalled one is not. */
const IDLE_TIMEOUT_MS = 60_000;
/** Free space to keep beyond the file itself, for the .part copy and churn. */
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function defaultStatfs(directory: string): Promise<{ available: number }> {
	const s = await fs.statfs(directory);
	return { available: Number(s.bavail) * Number(s.bsize) };
}

export async function downloadModel(
	directory: string,
	files: ModelFile[],
	onProgress: (p: DownloadProgress) => void,
	signal?: AbortSignal,
	deps: TtsDownloadDeps = {},
): Promise<void> {
	const d = { fetch: deps.fetch ?? globalThis.fetch, statfs: deps.statfs ?? defaultStatfs };
	for (const file of files) {
		await downloadOne(directory, file, onProgress, signal, d);
	}
}

/** Hashes every file and checks size + digest. False, not a throw, when a
 *  file is missing or corrupt: a false answer is data, a throw is noise. */
export async function verifyModel(
	directory: string,
	files: ModelFile[],
	_deps: TtsDownloadDeps = {},
): Promise<boolean> {
	for (const file of files) {
		try {
			validateRelPath(file.path);
			const target = path.join(directory, file.path);
			const st = await fs.lstat(target);
			if (st.isSymbolicLink() || st.size !== file.size) return false;
			if ((await sha256File(target)) !== file.sha256) return false;
		} catch {
			return false;
		}
	}
	return true;
}

// ─── per-file download ──────────────────────────────────────────────────────

async function downloadOne(
	directory: string,
	file: ModelFile,
	onProgress: (p: DownloadProgress) => void,
	signal: AbortSignal | undefined,
	d: { fetch: typeof globalThis.fetch; statfs: (p: string) => Promise<{ available: number }> },
): Promise<void> {
	validateRelPath(file.path);
	if (!Number.isSafeInteger(file.size) || file.size < 0) {
		throw new Error(`Bad size for ${file.path}: ${file.size}`);
	}
	const target = path.join(directory, file.path);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await assertNoSymlinks(directory, file.path);

	// A final file is only reused if it already verifies. A bad one is
	// renamed aside, never deleted: the bytes are not ours to destroy.
	const existing = await fs.lstat(target).catch(() => null);
	if (existing) {
		if (existing.isSymbolicLink()) throw new Error(`Refusing symlink final: ${target}`);
		if (existing.size === file.size && (await sha256File(target)) === file.sha256) {
			onProgress({ downloaded: file.size, total: file.size, file: file.path });
			return;
		}
		await quarantine(target);
	}

	const part = `${target}.part`;
	let offset = 0;
	const partial = await fs.lstat(part).catch(() => null);
	if (partial) {
		if (partial.isSymbolicLink()) await quarantine(part);
		else offset = partial.size;
		if (offset > file.size) {
			// Oversized partial cannot be a prefix of the file. Quarantine.
			await quarantine(part);
			offset = 0;
		}
	}

	const { available } = await d.statfs(directory);
	if (available < file.size - offset + DISK_MARGIN_BYTES) {
		throw new Error(`Insufficient disk space for ${file.path}`);
	}

	// One reset is allowed: if a 206 does not match what we have, ask again
	// from zero. WHY only one: a second mismatch means the server is broken.
	for (let attempt = 0; attempt < 2; attempt++) {
		const req = await openRequest(file.url, offset, signal, d.fetch);
		try {
			if (req.res.status === 206) {
				const range = parseContentRange(req.res.headers.get("content-range"));
				if (!range || range.start !== offset || range.total !== file.size) {
					await req.res.body?.cancel().catch(() => {});
					offset = 0;
					continue;
				}
			}
			if (req.res.status === 200 && offset > 0) {
				// Server ignored Range. WHY reset: the .part would duplicate bytes.
				offset = 0;
			}
			if (req.res.status !== 200 && req.res.status !== 206) {
				await req.res.body?.cancel().catch(() => {});
				throw new Error(`Unexpected status ${req.res.status} for ${file.url}`);
			}
			await streamBody(req, part, target, offset, file, onProgress, signal);
			return;
		} finally {
			req.finish();
		}
	}
	throw new Error(`Server never sent a usable range for ${file.url}`);
}

async function streamBody(
	req: OpenRequest,
	part: string,
	target: string,
	offset: number,
	file: ModelFile,
	onProgress: (p: DownloadProgress) => void,
	signal: AbortSignal | undefined,
): Promise<void> {
	const hash = crypto.createHash("sha256");
	// On resume the hash must cover the whole file, so seed it with the
	// bytes we already have on disk.
	if (offset > 0) await hashFileInto(part, hash);
	const fh = await fs.open(part, offset > 0 ? "r+" : "w");
	let written = offset;
	try {
		const reader = req.res.body!.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (signal?.aborted) throw new Error("Download aborted");
			if (written + value.byteLength > file.size) {
				throw new Error(`Server sent more than ${file.size} bytes for ${file.path}`);
			}
			hash.update(value);
			await fh.write(value, 0, value.byteLength, written);
			written += value.byteLength;
			req.kick();
			onProgress({ downloaded: written, total: file.size, file: file.path });
		}
	} catch (e) {
		await fh.close().catch(() => {});
		// Abort (user or idle timeout) keeps the partial so it can resume.
		// Every other failure means the partial may be garbage: quarantine.
		if (!signal?.aborted && !req.isIdleAbort()) await quarantine(part);
		throw e;
	}
	await fh.close();
	if (signal?.aborted || req.isIdleAbort()) throw new Error("Download aborted");
	if (written !== file.size) {
		await quarantine(part);
		throw new Error(`Server ended early: got ${written} of ${file.size} bytes for ${file.path}`);
	}
	if (hash.digest("hex") !== file.sha256) {
		await quarantine(part);
		throw new Error(`Checksum mismatch for ${file.path}`);
	}
	// Atomic: the final name only ever holds a verified file.
	await fs.rename(part, target);
}

// ─── HTTP with bounded idle time and a validated redirect chain ─────────────

interface OpenRequest {
	res: Response;
	kick: () => void;
	finish: () => void;
	isIdleAbort: () => boolean;
}

async function openRequest(
	url: string,
	rangeOffset: number,
	signal: AbortSignal | undefined,
	depsFetch: typeof globalThis.fetch,
): Promise<OpenRequest> {
	const controller = new AbortController();
	const forward = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", forward, { once: true });
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	const kick = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
	};
	const finish = () => {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", forward);
	};
	const isIdleAbort = () => controller.signal.aborted && !signal?.aborted;
	kick();

	const headers: Record<string, string> = {};
	if (rangeOffset > 0) headers.range = `bytes=${rangeOffset}-`;

	let current = new URL(url);
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			assertAllowedUrl(current, hop === 0);
			const res = await depsFetch(current.href, {
				redirect: "manual",
				signal: controller.signal,
				headers,
			});
			if (!REDIRECT_STATUS.has(res.status)) {
				return { res, kick, finish, isIdleAbort };
			}
			const location = res.headers.get("location");
			await res.body?.cancel().catch(() => {});
			if (!location) throw new Error(`Redirect without a Location header: ${current.href}`);
			current = new URL(location, current);
		}
		throw new Error(`Too many redirects for ${url}`);
	} catch (e) {
		finish();
		throw e;
	}
}

/** First hop must be an allowed source; redirects may hand off to a CDN but
 *  must never leave HTTPS or point at a local address. */
function assertAllowedUrl(u: URL, initial: boolean): void {
	if (u.protocol !== "https:") {
		throw new Error(`Only HTTPS URLs are allowed: ${u.href}`);
	}
	if (isLocalHost(u.hostname)) {
		throw new Error(`Local URLs are not allowed: ${u.href}`);
	}
	if (initial) {
		const h = u.hostname;
		const allowed =
			h === "github.com" ||
			h.endsWith(".github.com") ||
			h === "raw.githubusercontent.com" ||
			h === "huggingface.co" ||
			h.endsWith(".huggingface.co");
		if (!allowed) throw new Error(`URL is not from an allowed source: ${u.href}`);
	}
}

function isLocalHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return (
		h === "localhost" ||
		h.endsWith(".localhost") ||
		h === "::1" ||
		h === "[::1]" ||
		h === "0.0.0.0" ||
		h.startsWith("127.")
	);
}

function parseContentRange(value: string | null): { start: number; total: number } | null {
	const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value ?? "");
	if (!m) return null;
	const start = Number(m[1]);
	const total = m[3] === "*" ? NaN : Number(m[3]);
	return { start, total };
}

// ─── path safety ────────────────────────────────────────────────────────────

/** Rejects anything that could escape the directory: absolute, "..", "." or
 *  empty segments, and backslashes (Windows separators in a stored path). */
function validateRelPath(p: string): void {
	if (!p || p.length > 512 || /^[A-Za-z]:/.test(p) || p.includes("\\")) {
		throw new Error(`Unsafe model path: ${p}`);
	}
	const segs = p.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) {
		throw new Error(`Unsafe model path: ${p}`);
	}
}

/** Walks every component we are about to write through and refuses symlinks.
 *  WHY: a symlink planted in the models dir could redirect writes anywhere. */
async function assertNoSymlinks(directory: string, rel: string): Promise<void> {
	let cur = directory;
	const segs = rel.split("/");
	for (const seg of segs.slice(0, -1)) {
		cur = path.join(cur, seg);
		const st = await fs.lstat(cur).catch(() => null);
		if (st?.isSymbolicLink()) throw new Error(`Refusing to follow symlink: ${cur}`);
	}
	const last = await fs.lstat(path.join(directory, rel)).catch(() => null);
	if (last?.isSymbolicLink()) throw new Error(`Refusing symlink final: ${path.join(directory, rel)}`);
}

// ─── small helpers ──────────────────────────────────────────────────────────

function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		fsSync.createReadStream(file)
			.on("data", (chunk: string | Buffer) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

async function hashFileInto(file: string, hash: crypto.Hash): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		fsSync.createReadStream(file)
			.on("data", (chunk: string | Buffer) => hash.update(chunk))
			.on("end", () => resolve())
			.on("error", reject);
	});
}

/** Renames the bad file aside instead of deleting it. WHY: quarantine beats
 *  rm — the bytes stay recoverable and nothing unrelated is touched. */
async function quarantine(file: string): Promise<void> {
	for (let i = 0; i < 10; i++) {
		const q = `${file}.quarantine${i ? `-${i}` : ""}`;
		const taken = await fs.lstat(q).catch(() => null);
		if (taken) continue;
		if (await fs.rename(file, q).then(() => true, () => false)) return;
	}
	// Best effort only: leaving the bad file is safe, the caller still throws.
}
