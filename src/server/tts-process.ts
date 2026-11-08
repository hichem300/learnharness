/**
 * TTS worker process (#tts): one child Python process per engine
 * (kokoro / habibi), talking JSON lines over stdin/stdout. WHY a real
 * process and not a library import: the speech engines are Python, and
 * loading a multi-hundred-MB model takes seconds — one worker is started
 * lazily and stays warm, instead of spawning per request.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveRuntimeDir } from "./tts-paths.ts";

const WORKER_SCRIPT = path.join(resolveRuntimeDir(), "worker.py");
/** Keep in step with worker.py's own MAX_LINE_BYTES; a client bug should
 * fail fast here instead of corrupting the line-delimited stream. */
const MAX_LINE_BYTES = 16 * 1024;
/** No speech request should hang a browser tab forever; a stuck worker is
 * killed and the caller gets a clear error instead of a silent stall. */
const REQUEST_TIMEOUT_MS = 120_000;
/** A warm model worth keeping loaded, but not indefinitely once the chat
 * using it moves on; this frees RAM the next time nothing is speaking. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

export type TtsEngine = "kokoro" | "habibi";

interface PendingRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class TtsWorkerProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private pending = new Map<string, PendingRequest>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private nextId = 0;
	private starting: Promise<void> | null = null;

	constructor(private readonly root: string, private readonly engine: TtsEngine, private readonly pythonPath: string) {}

	private ensureStarted(): Promise<void> {
		if (this.child) return Promise.resolve();
		if (this.starting) return this.starting;
		this.starting = new Promise((resolve, reject) => {
			const child = spawn(this.pythonPath, [WORKER_SCRIPT, "--root", this.root, "--engine", this.engine], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			let settled = false;
			child.once("error", (error) => {
				if (!settled) { settled = true; reject(error); }
				this.fail(error);
			});
			child.once("spawn", () => {
				settled = true;
				this.child = child;
				this.starting = null;
				resolve();
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => this.onData(chunk));
			// Library/runtime logs land on stderr by design; surfacing them as
			// console noise here would leak lesson text into process logs.
			child.stderr.resume();
			child.once("close", () => {
				this.fail(new Error("Speech worker process exited unexpectedly"));
			});
		});
		return this.starting;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { return; }
		if (!parsed || typeof parsed !== "object") return;
		const body = parsed as Record<string, unknown>;
		const id = typeof body.id === "string" ? body.id : String(body.id ?? "");
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		clearTimeout(request.timer);
		if (typeof body.error === "string") request.reject(new Error(body.error));
		else request.resolve(body);
	}

	private fail(error: Error): void {
		for (const [, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		this.child = null;
		this.starting = null;
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
	}

	private armIdleShutdown(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
	}

	async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const line = JSON.stringify(body);
		// WHY check before send: a caller bug should fail clearly, not corrupt
		// the newline-delimited protocol with an embedded newline-free overlong line.
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Speech request is too large");
		if (signal?.aborted) throw new Error("Speech request was cancelled");

		await this.ensureStarted();
		const child = this.child;
		if (!child) throw new Error("Speech worker is not running");
		const id = String(body.id ?? `req-${this.nextId++}`);

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const onAbort = () => { cleanup(); reject(new Error("Speech request was cancelled")); };
			const cleanup = () => {
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => { cleanup(); reject(new Error("Speech worker timed out")); }, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (value) => { cleanup(); this.armIdleShutdown(); resolve(value); },
				reject: (error) => { cleanup(); reject(error); },
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdin.write(`${JSON.stringify({ ...body, id })}\n`, (error) => {
				if (error) { cleanup(); clearTimeout(timer); reject(error); }
			});
		});
	}

	stop(): void {
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
		this.child?.kill();
		this.fail(new Error("Speech worker was stopped"));
	}
}

// One worker per engine for the whole server process. WHY a module-level
// map and not per-request: loading a model is slow, and only one Node
// process serves this app (Next dev HMR aside, each module instance here
// is already the live set of running children for its own process).
const workers = new Map<string, TtsWorkerProcess>();

export function getTtsWorker(root: string, engine: TtsEngine, pythonPath: string): TtsWorkerProcess {
	const key = `${engine}:${pythonPath}`;
	let worker = workers.get(key);
	if (!worker) {
		worker = new TtsWorkerProcess(root, engine, pythonPath);
		workers.set(key, worker);
	}
	return worker;
}

export function stopAllTtsWorkers(): void {
	for (const [, worker] of workers) worker.stop();
	workers.clear();
}
