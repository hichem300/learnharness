import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UV_VERSION = "0.13.7";
export const PYTHON_VERSION = "3.12";
export const PYTORCH_VERSION = "2.8.0";
export const SUPPORTED_SPEECH_ENGINES = Object.freeze(["kokoro", "habibi", "habibi-cuda"]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const READY_FORMAT = 1;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const activeRoots = new Set();

export const UV_ASSETS = Object.freeze({
	"linux-x64": Object.freeze({
		archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
		sha256: "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83",
		member: "uv-x86_64-unknown-linux-gnu/uv",
		binary: "uv",
	}),
	"win32-x64": Object.freeze({
		archive: "uv-x86_64-pc-windows-msvc.zip",
		sha256: "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021",
		member: "uv-x86_64-pc-windows-msvc/uv.exe",
		binary: "uv.exe",
	}),
});

const ENGINE_VENVS = Object.freeze({
	kokoro: Object.freeze({ venv: "kokoro-venv" }),
	habibi: Object.freeze({ venv: "habibi-venv", torchBuild: "cpu", torchIndex: "https://download.pytorch.org/whl/cpu" }),
	"habibi-cuda": Object.freeze({ venv: "habibi-cuda-venv", torchBuild: "cu128", torchIndex: "https://download.pytorch.org/whl/cu128" }),
});
// WHY a function: when the server runs from Next's bundled output,
// import.meta.url points into .next/server — the requirements files are
// not there. The caller passes the real runtime directory instead
// (resolved from cwd, where the traced runtime/tts assets actually live).
function engineConfig(engine, runtimeDir) {
	return Object.freeze({ ...ENGINE_VENVS[engine], requirements: path.join(runtimeDir, `requirements-${engine === "habibi-cuda" ? "habibi" : engine}.txt`) });
}

export class SpeechRuntimeSetupError extends Error {
	constructor(phase, message, options) {
		super(`Speech runtime setup failed during ${phase}: ${message}`, options);
		this.name = "SpeechRuntimeSetupError";
		this.phase = phase;
	}
}

export function getUvAsset(platform = process.platform, arch = process.arch) {
	const asset = UV_ASSETS[`${platform}-${arch}`];
	if (!asset) {
		throw new SpeechRuntimeSetupError("checking", `unsupported platform ${platform}/${arch}; supported targets are Windows x64 and Linux x64`);
	}
	return asset;
}

export async function sha256File(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function downloadFile(url, destination, { signal } = {}) {
	throwIfAborted(signal);
	const response = await fetch(url, { redirect: "follow", signal });
	if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	throwIfAborted(signal);
	await writeFile(destination, bytes, { flag: "wx" });
}

export async function runProcess(command, args, { cwd, env, signal } = {}) {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			signal,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
		child.once("error", reject);
		child.once("close", (code, childSignal) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`command exited with ${code ?? childSignal ?? "unknown status"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

export function createSpeechRuntimeInstaller(overrides = {}) {
	const deps = {
		platform: process.platform,
		arch: process.arch,
		getUvAsset,
		download: downloadFile,
		runProcess,
		...overrides,
	};

	return async function ensureSpeechRuntime(root, engine, onProgress = () => {}, signal) {
		if (!SUPPORTED_SPEECH_ENGINES.includes(engine)) {
			throw new SpeechRuntimeSetupError("checking", `unsupported engine ${JSON.stringify(engine)}`);
		}
		if (typeof root !== "string" || root.length === 0) {
			throw new SpeechRuntimeSetupError("checking", "root must be a non-empty path");
		}
		if (typeof onProgress !== "function") {
			throw new SpeechRuntimeSetupError("checking", "onProgress must be a function");
		}

		throwIfAborted(signal);
		await mkdir(path.resolve(root), { recursive: true });
		const canonicalRoot = await realpath(path.resolve(root));
		if (activeRoots.has(canonicalRoot)) {
			throw new SpeechRuntimeSetupError("checking", "another speech runtime install is already active for this root");
		}

		activeRoots.add(canonicalRoot);
		try {
			return await installRuntime(canonicalRoot, engine, onProgress, signal, deps);
		} finally {
			activeRoots.delete(canonicalRoot);
		}
	};
}

async function installRuntime(root, engine, onProgress, signal, deps) {
	// WHY not in the args list: existing callers/tests pass (root, engine,
	// onProgress, signal); the override rides on the deps object.
	const runtimeDir = deps.runtimeDir ?? MODULE_DIR;
	let phase = "checking";
	const emit = (nextPhase, message, details = {}) => {
		phase = nextPhase;
		// WHY: UI progress must never turn a successful install into a partial one.
		try { onProgress(Object.freeze({ phase: nextPhase, message, ...details })); } catch { /* progress is best-effort */ }
	};

	try {
		emit("checking", `Checking ${engine} speech runtime`);
		throwIfAborted(signal);
		const asset = deps.getUvAsset(deps.platform, deps.arch);
		const config = engineConfig(engine, runtimeDir);
		const uvDir = await ensureManagedDirectory(root, "uv");
		const pythonDir = await ensureManagedDirectory(root, "python");
		const venvDir = await ensureManagedDirectory(root, config.venv);
		const cacheDir = await ensureManagedDirectory(uvDir, "cache");
		const tempDir = await ensureManagedDirectory(uvDir, "tmp");
		const uvPath = path.join(uvDir, asset.binary);
		const pythonPath = path.join(venvDir, deps.platform === "win32" ? "Scripts/python.exe" : "bin/python");
		const requirementsHash = await sha256File(config.requirements);
		const installFingerprint = createHash("sha256").update(JSON.stringify({
			format: READY_FORMAT,
			engine,
			uv: UV_VERSION,
			python: PYTHON_VERSION,
			requirementsHash,
			torchBuild: config.torchBuild ?? null,
		})).digest("hex");
		const readyPath = path.join(venvDir, `.learnharness-ready-${installFingerprint}.json`);

		if (await isFile(readyPath) && await isFile(pythonPath)) {
			emit("ready", `${engine} speech runtime is ready`, { pythonPath, reused: true });
			return pythonPath;
		}

		const commandEnv = {
			...process.env,
			UV_CACHE_DIR: cacheDir,
			UV_PYTHON_INSTALL_DIR: pythonDir,
			UV_NO_CONFIG: "1",
			PYTHONNOUSERSITE: "1",
			TMPDIR: tempDir,
			TEMP: tempDir,
			TMP: tempDir,
		};

		if (!await isFile(uvPath)) {
			const archivePath = path.join(uvDir, `${asset.archive}.${randomUUID()}.download`);
			const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.archive}`;
			emit("downloading-uv", `Downloading uv ${UV_VERSION}`, { url });
			await deps.download(url, archivePath, { signal });
			throwIfAborted(signal);

			emit("verifying-uv", "Verifying uv SHA256 checksum");
			const actualHash = await sha256File(archivePath);
			if (actualHash !== asset.sha256) {
				throw new Error(`uv archive checksum mismatch (expected ${asset.sha256}, received ${actualHash})`);
			}

			emit("extracting-uv", "Extracting uv executable");
			await deps.runProcess(deps.platform === "win32" ? "tar.exe" : "tar", [
				"-xf", archivePath,
				"-C", uvDir,
				"--strip-components=1",
				asset.member,
			], { cwd: root, env: commandEnv, signal, phase });
			if (!await isFile(uvPath)) throw new Error("uv archive did not contain expected executable");
			if (deps.platform !== "win32") await chmod(uvPath, 0o755);
		}

		emit("installing-python", `Installing managed Python ${PYTHON_VERSION}`);
		const pythonInstallArgs = [
			"python", "install", PYTHON_VERSION,
			"--install-dir", pythonDir,
			"--no-bin",
			"--managed-python",
			"--cache-dir", cacheDir,
			"--no-config",
			"--color", "never",
		];
		if (deps.platform === "win32") pythonInstallArgs.push("--no-registry");
		await deps.runProcess(uvPath, pythonInstallArgs, { cwd: root, env: commandEnv, signal, phase });

		emit("creating-venv", `Creating ${config.venv}`);
		await deps.runProcess(uvPath, [
			"venv", venvDir,
			"--python", PYTHON_VERSION,
			"--managed-python",
			"--no-python-downloads",
			"--no-project",
			"--allow-existing",
			"--cache-dir", cacheDir,
			"--no-config",
			"--color", "never",
		], { cwd: root, env: commandEnv, signal, phase });
		if (!await isFile(pythonPath)) throw new Error("uv did not create expected virtual-environment Python executable");

		emit("installing-packages", `Installing ${engine} packages`);
		const installArgs = [
			"pip", "install",
			"--python", pythonPath,
			"--requirements", config.requirements,
			"--exact",
			"--managed-python",
			"--no-python-downloads",
			"--cache-dir", cacheDir,
			"--no-config",
			"--color", "never",
		];
		if (engine === "kokoro") {
			installArgs.push("--require-hashes");
		} else {
			const suffix = config.torchBuild === "cpu" ? "+cpu" : `+${config.torchBuild}`;
			installArgs.push(
				"--index", config.torchIndex,
				"--index-strategy", "unsafe-best-match",
				`torch==${PYTORCH_VERSION}${suffix}`,
				`torchaudio==${PYTORCH_VERSION}${suffix}`,
			);
		}
		await deps.runProcess(uvPath, installArgs, { cwd: root, env: commandEnv, signal, phase });

		emit("verifying-runtime", `Verifying ${engine} imports`);
		const probe = engine === "kokoro"
			? "import kokoro_onnx, soundfile, misaki; print('ok')"
			: "import json, os, torch, habibi_tts, f5_tts, imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); assert os.path.isfile(p); print(json.dumps({'cudaBuild': torch.version.cuda is not None, 'cudaAvailable': torch.cuda.is_available(), 'ffmpeg': p}))";
		const verification = await deps.runProcess(pythonPath, ["-c", probe], { cwd: root, env: commandEnv, signal, phase });
		throwIfAborted(signal);

		const marker = {
			format: READY_FORMAT,
			engine,
			uvVersion: UV_VERSION,
			pythonVersion: PYTHON_VERSION,
			requirementsHash,
			torchBuild: config.torchBuild ?? null,
			verifiedOutput: verification.stdout.trim().slice(-2048),
		};
		const temporaryReadyPath = `${readyPath}.${randomUUID()}.tmp`;
		await writeFile(temporaryReadyPath, `${JSON.stringify(marker)}\n`, { flag: "wx" });
		await rename(temporaryReadyPath, readyPath);
		emit("ready", `${engine} speech runtime is ready`, { pythonPath, reused: false });
		return pythonPath;
	} catch (error) {
		if (isAbortError(error) || signal?.aborted) throw abortError(signal?.reason);
		if (error instanceof SpeechRuntimeSetupError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SpeechRuntimeSetupError(phase, message, { cause: error });
	}
}

async function ensureManagedDirectory(parent, child) {
	const target = path.resolve(parent, child);
	if (!isInside(parent, target)) throw new Error(`managed path escapes root: ${child}`);
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink()) throw new Error(`managed path must not be a symbolic link: ${child}`);
		if (!info.isDirectory()) throw new Error(`managed path is not a directory: ${child}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(target, { recursive: false });
	}
	const canonical = await realpath(target);
	if (!isInside(await realpath(parent), canonical)) throw new Error(`managed path resolves outside root: ${child}`);
	return canonical;
}

function isInside(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function isFile(filePath) {
	try { return (await stat(filePath)).isFile(); } catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function appendBounded(current, chunk) {
	const next = current + String(chunk);
	return next.length <= MAX_COMMAND_OUTPUT ? next : next.slice(-MAX_COMMAND_OUTPUT);
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw abortError(signal.reason);
}

function abortError(reason) {
	const error = new Error(reason instanceof Error ? reason.message : "Speech runtime setup aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}

export const ensureSpeechRuntime = createSpeechRuntimeInstaller();
