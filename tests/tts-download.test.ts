/**
 * TTS model downloads (#tts): src/server/tts-download.test.ts. Offline only:
 * a local node:http server plays the origin, and the download seam's
 * injectable fetch maps the allowed https front onto it. Covers resume
 * (valid, mismatched, 200-reset), checksum/overlong/short failures,
 * abort, path traversal, symlinks, verify, and the disk-space seam.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	downloadModel,
	verifyModel,
	type ModelFile,
	type TtsDownloadDeps,
} from "../src/server/tts-download.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tts-download-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ─── fixtures ───────────────────────────────────────────────────────────────

const BYTES = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");
const HALF = BYTES.subarray(0, 150_000);

const FRONT = "https://huggingface.co/org/repo/resolve/main/voice.bin";
const CDN = "https://cdn.example.org/voice.bin";

function modelFile(url = FRONT, size = BYTES.length, sha = SHA): ModelFile {
	return { path: "voice.bin", url, size, sha256: sha };
}

/** Seam: rewrite the https fronts onto the local http port. */
function seam(port: number, count?: { n: number }): TtsDownloadDeps {
	return {
		fetch: ((input: unknown, init?: unknown) => {
			if (count) count.n++;
			const u = String(input)
				.replace("https://huggingface.co", `http://127.0.0.1:${port}`)
				.replace("https://cdn.example.org", `http://127.0.0.1:${port}`);
			return fetch(u, init as RequestInit);
		}) as typeof fetch,
	};
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ port: number; close: () => void }> {
	const server = http.createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return { port, close: () => new Promise((r) => server.close(r)) };
}

/** Well-behaved origin: honors Range with a matching 206 when asked. */
const serveFull: Handler = (req, res) => {
	const m = /^bytes=(\d+)-$/.exec(String(req.headers.range));
	if (m) {
		const start = Number(m![1]);
		const slice = BYTES.subarray(start);
		res.writeHead(206, {
			"content-range": `bytes ${start}-${BYTES.length - 1}/${BYTES.length}`,
			"content-length": slice.length,
		});
		res.end(slice);
		return;
	}
	res.writeHead(200, { "content-length": BYTES.length });
	res.end(BYTES);
};

async function dir(): Promise<string> {
	return fs.mkdtempSync(path.join(root, "case-"));
}

const quarantines = (d: string) => fs.readdirSync(d).filter((f) => f.includes(".quarantine"));

// ─── downloadModel ──────────────────────────────────────────────────────────

describe("downloadModel", () => {
	it("downloads a file, reports increasing progress, and verifies", async () => {
		const d = await dir();
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": BYTES.length });
			res.write(BYTES.subarray(0, 100_000));
			setTimeout(() => {
				res.write(BYTES.subarray(100_000, 200_000));
				setTimeout(() => res.end(BYTES.subarray(200_000)), 5);
			}, 5);
		});
		const progress: { downloaded: number; total: number }[] = [];
		await downloadModel(d, [modelFile()], (p) => progress.push(p), undefined, seam(server.port));
		await server.close();
		assert.equal(fs.readFileSync(path.join(d, "voice.bin")).toString("hex"), BYTES.toString("hex"));
		assert.equal(fs.readdirSync(d).join(","), "voice.bin");
		const ups = progress.every((p, i) => i === 0 || p.downloaded > progress[i - 1]!.downloaded);
		assert.ok(ups, "progress must increase");
		assert.deepEqual(progress[progress.length - 1], {
			downloaded: BYTES.length,
			total: BYTES.length,
			file: "voice.bin",
		});
		assert.equal(await verifyModel(d, [modelFile()]), true);
	});

	it("resumes a matching partial with a 206 and finishes the file", async () => {
		const d = await dir();
		fs.writeFileSync(path.join(d, "voice.bin.part"), HALF);
		let sawRange: string | undefined;
		const server = await startServer((req, res) => {
			sawRange = req.headers.range;
			serveFull(req, res);
		});
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port));
		await server.close();
		assert.equal(sawRange, "bytes=150000-");
		assert.equal(fs.readFileSync(path.join(d, "voice.bin")).toString("hex"), BYTES.toString("hex"));
		assert.deepEqual(fs.readdirSync(d), ["voice.bin"]);
	});

	it("resets the partial when Content-Range does not match the offset", async () => {
		const d = await dir();
		fs.writeFileSync(path.join(d, "voice.bin.part"), HALF);
		// Lying origin: 206 that claims to start where we did not ask, then
		// plays straight when we retry without a Range.
		const server = await startServer((req, res) => {
			if (req.headers.range) {
				res.writeHead(206, {
					"content-range": `bytes 5-${BYTES.length - 1}/${BYTES.length}`,
					"content-length": BYTES.length - 5,
				});
				res.end(BYTES.subarray(5));
				return;
			}
			res.writeHead(200, { "content-length": BYTES.length });
			res.end(BYTES);
		});
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port));
		await server.close();
		assert.equal(fs.readFileSync(path.join(d, "voice.bin")).toString("hex"), BYTES.toString("hex"));
		assert.deepEqual(fs.readdirSync(d), ["voice.bin"]);
	});

	it("resets the partial when the server ignores Range and returns 200", async () => {
		const d = await dir();
		fs.writeFileSync(path.join(d, "voice.bin.part"), HALF);
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": BYTES.length });
			res.end(BYTES);
		});
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port));
		await server.close();
		assert.equal(fs.readFileSync(path.join(d, "voice.bin")).toString("hex"), BYTES.toString("hex"));
		assert.deepEqual(fs.readdirSync(d), ["voice.bin"]);
	});

	it("quarantines the partial on checksum mismatch", async () => {
		const d = await dir();
		const bad = Buffer.from(BYTES);
		bad[0] = bad[0]! ^ 0xff;
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": bad.length });
			res.end(bad);
		});
		await assert.rejects(
			() => downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port)),
			/Checksum mismatch/,
		);
		await server.close();
		assert.ok(!fs.existsSync(path.join(d, "voice.bin")));
		assert.equal(quarantines(d).length, 1);
	});

	it("quarantines on overlong data", async () => {
		const d = await dir();
		const extra = Buffer.concat([BYTES, Buffer.alloc(10, 7)]);
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": extra.length });
			res.end(extra);
		});
		await assert.rejects(
			() => downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port)),
			/more than/,
		);
		await server.close();
		assert.ok(!fs.existsSync(path.join(d, "voice.bin")));
		assert.equal(quarantines(d).length, 1);
	});

	it("quarantines on short data", async () => {
		const d = await dir();
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": HALF.length });
			res.end(HALF);
		});
		await assert.rejects(
			() => downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port)),
			/ended early/,
		);
		await server.close();
		assert.ok(!fs.existsSync(path.join(d, "voice.bin")));
		assert.equal(quarantines(d).length, 1);
	});

	it("keeps the partial when aborted mid-download", async () => {
		const d = await dir();
		const server = await startServer((req, res) => {
			res.writeHead(200, { "content-length": BYTES.length });
			res.write(BYTES.subarray(0, 100_000));
			// Never ends: the abort has to come from the signal.
		});
		const controller = new AbortController();
		await assert.rejects(
			() =>
				downloadModel(
					d,
					[modelFile()],
					(p) => {
						if (p.downloaded >= 100_000) controller.abort();
					},
					controller.signal,
					seam(server.port),
				),
			/aborted/,
		);
		await server.close();
		const part = path.join(d, "voice.bin.part");
		assert.ok(fs.existsSync(part), "abort must preserve the partial");
		assert.ok(fs.statSync(part).size >= 100_000);
		assert.equal(quarantines(d).length, 0);
	});

	it("rejects traversal and absolute paths without writing outside", async () => {
		const d = await dir();
		const noFetch: TtsDownloadDeps = {
			fetch: (() => {
				throw new Error("should not fetch");
			}) as typeof fetch,
		};
		await assert.rejects(() => downloadModel(d, [{ ...modelFile(), path: "../escape.bin" }], () => {}, undefined, noFetch), /Unsafe/);
		await assert.rejects(() => downloadModel(d, [{ ...modelFile(), path: "/etc/evil.bin" }], () => {}, undefined, noFetch), /Unsafe/);
		assert.deepEqual(fs.readdirSync(d), []);
		assert.ok(!fs.existsSync(path.join(root, "escape.bin")));
	});

	it("refuses to follow a symlink planted in the models directory", async () => {
		const d = await dir();
		fs.symlinkSync(os.tmpdir(), path.join(d, "link"));
		const noFetch: TtsDownloadDeps = {
			fetch: (() => {
				throw new Error("should not fetch");
			}) as typeof fetch,
		};
		await assert.rejects(
			() => downloadModel(d, [{ ...modelFile(), path: "link/voice.bin" }], () => {}, undefined, noFetch),
			/symlink/,
		);
		assert.ok(!fs.existsSync(path.join(os.tmpdir(), "voice.bin")));
	});

	it("rejects non-HTTPS, local, and non-allowed-source URLs", async () => {
		const d = await dir();
		let calls = 0;
		const counting: TtsDownloadDeps = {
			fetch: (() => {
				calls++;
				throw new Error("should not fetch");
			}) as typeof fetch,
		};
		for (const url of [
			"http://huggingface.co/org/repo/resolve/main/voice.bin",
			"https://localhost/org/repo/resolve/main/voice.bin",
			"https://evil.example.org/voice.bin",
			"file:///etc/passwd",
		]) {
			await assert.rejects(() => downloadModel(d, [modelFile(url)], () => {}, undefined, counting), /HTTPS|allowed|Local/);
		}
		assert.equal(calls, 0);
	});

	it("follows redirects to a legitimate CDN and still verifies", async () => {
		const d = await dir();
		const server = await startServer((req, res) => {
			if (req.url === "/voice.bin") {
				res.writeHead(200, { "content-length": BYTES.length });
				res.end(BYTES);
				return;
			}
			res.writeHead(302, { location: `${CDN}` });
			res.end();
		});
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port));
		await server.close();
		assert.equal(await verifyModel(d, [modelFile()]), true);
	});

	it("rejects a redirect back to plain HTTP", async () => {
		const d = await dir();
		const server = await startServer((req, res) => {
			res.writeHead(302, { location: `http://${req.headers.host}/voice.bin` });
			res.end();
		});
		await assert.rejects(
			() => downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port)),
			/HTTPS/,
		);
		await server.close();
	});

	it("reuses a good final file without redownloading", async () => {
		const d = await dir();
		fs.writeFileSync(path.join(d, "voice.bin"), BYTES);
		const count = { n: 0 };
		const server = await startServer(serveFull);
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port, count));
		await server.close();
		assert.equal(count.n, 0, "a verified final must not hit the network");
		assert.deepEqual(fs.readdirSync(d), ["voice.bin"]);
	});

	it("quarantines a corrupt final and redownloads", async () => {
		const d = await dir();
		const corrupt = Buffer.from(BYTES);
		corrupt[1000] = (corrupt[1000]! + 1) % 251;
		fs.writeFileSync(path.join(d, "voice.bin"), corrupt);
		const server = await startServer(serveFull);
		await downloadModel(d, [modelFile()], () => {}, undefined, seam(server.port));
		await server.close();
		assert.equal(fs.readFileSync(path.join(d, "voice.bin")).toString("hex"), BYTES.toString("hex"));
		assert.equal(quarantines(d).length, 1);
	});

	it("rejects via the statfs seam when disk space is insufficient", async () => {
		const d = await dir();
		const count = { n: 0 };
		const deps: TtsDownloadDeps = {
			...seam(0, count),
			statfs: async () => ({ available: 1024 }),
		};
		await assert.rejects(
			() => downloadModel(d, [modelFile()], () => {}, undefined, deps),
			/Insufficient disk/,
		);
		assert.equal(count.n, 0, "must not start a download without space");
	});
});

// ─── verifyModel ────────────────────────────────────────────────────────────

describe("verifyModel", () => {
	it("returns true for complete files and false for missing ones", async () => {
		const d = await dir();
		assert.equal(await verifyModel(d, [modelFile()]), false);
		fs.writeFileSync(path.join(d, "voice.bin"), BYTES);
		assert.equal(await verifyModel(d, [modelFile()]), true);
	});

	it("returns false for corrupt files", async () => {
		const d = await dir();
		fs.writeFileSync(path.join(d, "voice.bin"), BYTES.subarray(0, BYTES.length - 1));
		assert.equal(await verifyModel(d, [modelFile()]), false);
		fs.writeFileSync(path.join(d, "voice.bin"), BYTES.subarray(0, 100));
		assert.equal(await verifyModel(d, [modelFile()]), false);
		fs.writeFileSync(path.join(d, "voice.bin"), Buffer.alloc(BYTES.length, 0));
		assert.equal(await verifyModel(d, [modelFile()]), false);
	});
});
