import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	PYTHON_VERSION,
	PYTORCH_VERSION,
	SUPPORTED_SPEECH_ENGINES,
	UV_ASSETS,
	UV_VERSION,
	createSpeechRuntimeInstaller,
	getUvAsset,
} from "../runtime/tts/setup.mjs";

const archiveBytes = Buffer.from("offline uv fixture");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");

type Platform = "linux" | "win32";
type ProcessCall = {
	command: string;
	args: string[];
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; phase: string };
};

async function makeRoot(label: string): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(path.join(tmpdir(), `learnharness-${label}-`));
}

function fixtureAsset(platform: Platform) {
	return {
		archive: platform === "win32" ? "fixture.zip" : "fixture.tar.gz",
		sha256: archiveSha256,
		member: platform === "win32" ? "fixture/uv.exe" : "fixture/uv",
		binary: platform === "win32" ? "uv.exe" : "uv",
	};
}

type ProgressEvent = { phase: string; message: string; pythonPath?: string; reused?: boolean };
// setup.mjs is plain JS; without allowJs, TS infers the installer's
// onProgress parameter from its `= () => {}` default (zero-arg). Pin the
// real multi-arg shape explicitly instead of fighting that inference.
type Installer = (root: string, engine: string, onProgress?: (event: ProgressEvent) => void, signal?: AbortSignal) => Promise<string>;

function createOfflineInstaller(platform: Platform = "linux") {
	const calls: ProcessCall[] = [];
	const downloads: Array<{ url: string; destination: string }> = [];
	const progress: ProgressEvent[] = [];
	const asset = fixtureAsset(platform);
	const installer = createSpeechRuntimeInstaller({
		platform,
		arch: "x64",
		getUvAsset: () => asset,
		download: async (url: string, destination: string, { signal }: { signal?: AbortSignal }) => {
			signal?.throwIfAborted();
			downloads.push({ url, destination });
			await writeFile(destination, archiveBytes, { flag: "wx" });
		},
		runProcess: async (command: string, args: string[], options: ProcessCall["options"]) => {
			options.signal?.throwIfAborted();
			calls.push({ command, args: [...args], options });
			if (options.phase === "extracting-uv") {
				const outputDir = args[args.indexOf("-C") + 1];
				assert.ok(outputDir);
				await writeFile(path.join(outputDir, asset.binary), "fixture uv");
			}
			if (options.phase === "creating-venv") {
				const venv = args[1];
				assert.ok(venv);
				const python = path.join(venv, platform === "win32" ? "Scripts/python.exe" : "bin/python");
				await mkdir(path.dirname(python), { recursive: true });
				await writeFile(python, "fixture python");
			}
			return { stdout: options.phase === "verifying-runtime" ? "{\"cudaBuild\":false,\"cudaAvailable\":false}" : "", stderr: "" };
		},
	}) as Installer;
	return { installer, calls, downloads, progress };
}

test("pins official uv archives and exposes only supported engine names", () => {
	assert.equal(UV_VERSION, "0.13.7");
	assert.equal(PYTHON_VERSION, "3.12");
	assert.equal(PYTORCH_VERSION, "2.8.0");
	assert.deepEqual(SUPPORTED_SPEECH_ENGINES, ["kokoro", "habibi", "habibi-cuda"]);
	assert.deepEqual(getUvAsset("linux", "x64"), UV_ASSETS["linux-x64"]);
	assert.deepEqual(getUvAsset("win32", "x64"), UV_ASSETS["win32-x64"]);
	assert.match(UV_ASSETS["linux-x64"].sha256, /^[a-f0-9]{64}$/);
	assert.match(UV_ASSETS["win32-x64"].sha256, /^[a-f0-9]{64}$/);
	assert.throws(() => getUvAsset("darwin", "arm64"), /supported targets are Windows x64 and Linux x64/);
});

for (const [engine, platform, venvName] of [
	["kokoro", "linux", "kokoro-venv"],
	["habibi", "win32", "habibi-venv"],
	["habibi-cuda", "linux", "habibi-cuda-venv"],
] as const) test(`${engine} installs offline fixture into its own ${platform} venv`, async () => {
	const rootParent = await makeRoot(`${engine}-paths`);
	const root = path.join(rootParent, "speech root;$(not-a-command)");
	const { installer, calls, downloads, progress } = createOfflineInstaller(platform);
	const pythonPath = await installer(root, engine, (event: (typeof progress)[number]) => { progress.push(event); });
	const expectedPython = path.join(root, venvName, platform === "win32" ? "Scripts/python.exe" : "bin/python");

	assert.equal(pythonPath, expectedPython);
	assert.equal(downloads.length, 1);
	assert.equal(downloads[0]?.url, `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${platform === "win32" ? "fixture.zip" : "fixture.tar.gz"}`);
	assert.ok(downloads[0]?.destination.startsWith(path.join(root, "uv") + path.sep));
	assert.deepEqual(progress.map(({ phase }) => phase), [
		"checking", "downloading-uv", "verifying-uv", "extracting-uv", "installing-python",
		"creating-venv", "installing-packages", "verifying-runtime", "ready",
	]);

	const packageCall = calls.find((call) => call.options.phase === "installing-packages");
	assert.ok(packageCall);
	assert.equal(packageCall.command, path.join(root, "uv", platform === "win32" ? "uv.exe" : "uv"));
	assert.ok(packageCall.args.includes("--exact"));
	assert.equal(packageCall.options.env.UV_PYTHON_INSTALL_DIR, path.join(root, "python"));
	assert.ok(packageCall.options.env.UV_CACHE_DIR?.startsWith(path.join(root, "uv") + path.sep));
	assert.ok(packageCall.options.env.TMPDIR?.startsWith(path.join(root, "uv") + path.sep));
	if (engine === "kokoro") {
		assert.ok(packageCall.args.includes("--require-hashes"));
		assert.ok(!packageCall.args.some((arg) => arg.startsWith("torch==")));
	} else {
		const suffix = engine === "habibi" ? "+cpu" : "+cu128";
		assert.ok(packageCall.args.includes(`torch==${PYTORCH_VERSION}${suffix}`));
		assert.ok(packageCall.args.includes(`torchaudio==${PYTORCH_VERSION}${suffix}`));
		assert.ok(packageCall.args.includes(engine === "habibi" ? "https://download.pytorch.org/whl/cpu" : "https://download.pytorch.org/whl/cu128"));
	}
});

test("successful marker makes repeated setup idempotent", async () => {
	const root = await makeRoot("idempotent");
	const { installer, calls, downloads, progress } = createOfflineInstaller();
	const first = await installer(root, "kokoro", (event: (typeof progress)[number]) => { progress.push(event); });
	const callsAfterFirst = calls.length;
	const secondProgress: typeof progress = [];
	const second = await installer(root, "kokoro", (event: (typeof progress)[number]) => { secondProgress.push(event); });

	assert.equal(second, first);
	assert.equal(calls.length, callsAfterFirst);
	assert.equal(downloads.length, 1);
	assert.deepEqual(secondProgress.map(({ phase, reused }) => ({ phase, reused })), [
		{ phase: "checking", reused: undefined },
		{ phase: "ready", reused: true },
	]);
});

test("checksum failure never extracts uv or writes ready marker", async () => {
	const root = await makeRoot("bad-checksum");
	let processCalls = 0;
	const installer = createSpeechRuntimeInstaller({
		platform: "linux",
		arch: "x64",
		getUvAsset: () => ({ ...fixtureAsset("linux"), sha256: "0".repeat(64) }),
		download: async (_url: string, destination: string) => writeFile(destination, archiveBytes, { flag: "wx" }),
		runProcess: async () => { processCalls++; return { stdout: "", stderr: "" }; },
	});

	await assert.rejects(installer(root, "kokoro"), /verifying-uv: uv archive checksum mismatch/);
	assert.equal(processCalls, 0);
	assert.ok(!(await readdir(path.join(root, "kokoro-venv"))).some((name) => name.includes("ready")));
});

test("same root rejects concurrent installs instead of racing", async () => {
	const root = await makeRoot("concurrent");
	let releaseDownload!: () => void;
	let downloadStarted!: () => void;
	const started = new Promise<void>((resolve) => { downloadStarted = resolve; });
	const release = new Promise<void>((resolve) => { releaseDownload = resolve; });
	const fixture = createOfflineInstaller();
	const installer = createSpeechRuntimeInstaller({
		platform: "linux",
		arch: "x64",
		getUvAsset: () => fixtureAsset("linux"),
		download: async (_url: string, destination: string) => {
			downloadStarted();
			await release;
			await writeFile(destination, archiveBytes, { flag: "wx" });
		},
		runProcess: async (command: string, args: string[], options: ProcessCall["options"]) => {
			return (fixture.calls.length, await (createOfflineInstaller().installer, Promise.resolve({ stdout: "", stderr: "" })));
		},
	});

	const first = installer(root, "kokoro");
	await started;
	await assert.rejects(installer(root, "habibi"), /another speech runtime install is already active/);
	releaseDownload();
	await assert.rejects(first, /uv archive did not contain expected executable/);
});

test("abort propagates and leaves runtime unready", async () => {
	const root = await makeRoot("abort");
	const controller = new AbortController();
	const asset = fixtureAsset("linux");
	const installer = createSpeechRuntimeInstaller({
		platform: "linux",
		arch: "x64",
		getUvAsset: () => asset,
		download: async (_url: string, destination: string) => writeFile(destination, archiveBytes, { flag: "wx" }),
		runProcess: async (_command: string, args: string[], options: ProcessCall["options"]) => {
			if (options.phase === "extracting-uv") {
				const outputDir = args[args.indexOf("-C") + 1];
				assert.ok(outputDir);
				await writeFile(path.join(outputDir, asset.binary), "fixture uv");
				return { stdout: "", stderr: "" };
			}
			controller.abort();
			options.signal?.throwIfAborted();
			return { stdout: "", stderr: "" };
		},
	});

	await assert.rejects(installer(root, "kokoro", () => {}, controller.signal), { name: "AbortError" });
	assert.ok(!(await readdir(path.join(root, "kokoro-venv"))).some((name) => name.includes("ready")));
});

test("unsupported engine fails before creating root", async () => {
	const parent = await makeRoot("unsupported");
	const root = path.join(parent, "must-not-exist");
	const { installer } = createOfflineInstaller();
	await assert.rejects(installer(root, "other"), /unsupported engine/);
	await assert.rejects(readdir(root), /ENOENT/);
});
