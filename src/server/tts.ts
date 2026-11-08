/**
 * TTS coordinator (#tts): the one module app/api/tts/* routes call. It
 * ties together the trusted manifest (runtime/tts/models.json), safe
 * downloads (tts-download.ts), the managed Python runtime
 * (runtime/tts/setup.mjs), and the running worker process
 * (tts-process.ts). WHY one file: every route needs the same model
 * status and the same "is this ready to speak" answer.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, PATHS } from "../../config.ts";
import type { SpeechModelId, SpeechModelStatus, SpeechSetupJob, SpeechStatus } from "../core/index.ts";
import { speechLanguage } from "../core/index.ts";
import { downloadModel, verifyModel, type ModelFile } from "./tts-download.ts";
import { resolveRuntimeDir } from "./tts-paths.ts";
// setup.mjs is plain JS; its real exports are typed here rather than
// adding a .d.ts for one small cross-boundary call.
import { createSpeechRuntimeInstaller as createSpeechRuntimeInstallerUntyped } from "../../runtime/tts/setup.mjs";

const ensureSpeechRuntime = createSpeechRuntimeInstallerUntyped({ runtimeDir: resolveRuntimeDir() }) as (
	root: string,
	engine: string,
	onProgress: (p: Record<string, unknown>) => void,
	signal?: AbortSignal,
) => Promise<string>;
import { getTtsWorker, stopAllTtsWorkers } from "./tts-process.ts";

const RUNTIME_DIR = resolveRuntimeDir();
const MANIFEST_PATH = path.join(RUNTIME_DIR, "models.json");
export const SPEECH_DATA_DIR = path.join(PATHS.data, "tts");

interface ManifestModel { id: SpeechModelId; label: string; license: string; licenseUrl: string; referenceText?: string; files: ModelFile[] }
interface Manifest { models: ManifestModel[] }

let manifestCache: Manifest | null = null;
async function loadManifest(): Promise<Manifest> {
	if (manifestCache) return manifestCache;
	const raw = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
	manifestCache = raw;
	return raw;
}

function modelDirectory(id: SpeechModelId): string {
	return path.join(SPEECH_DATA_DIR, "models", id);
}

/** Habibi's CUDA venv is a separate setup target from its CPU venv; the
 * model files on disk are shared either way. */
function engineForModel(id: SpeechModelId, device: "cpu" | "gpu"): "kokoro" | "habibi" {
	return id === "habibi" ? "habibi" : "kokoro";
}
function setupEngine(id: SpeechModelId, device: "cpu" | "gpu"): string {
	if (id === "habibi") return device === "gpu" ? "habibi-cuda" : "habibi";
	return "kokoro";
}

// In-memory only: a job tracks one setup/download run for the life of the
// server process. A restart means "not currently running", which is true.
let activeJob: SpeechSetupJob | null = null;
const abortControllers = new Map<SpeechModelId, AbortController>();

export async function speechStatus(): Promise<SpeechStatus> {
	const manifest = await loadManifest();
	const models: SpeechModelStatus[] = await Promise.all(
		manifest.models.map(async (model) => ({
			id: model.id,
			label: model.label,
			license: model.license,
			licenseUrl: model.licenseUrl,
			size: model.files.reduce((sum, f) => sum + f.size, 0),
			ready: await verifyModel(modelDirectory(model.id), model.files),
		})),
	);
	return { models, job: activeJob };
}

export class SpeechSetupInProgressError extends Error {}

export function isSpeechSetupActive(): boolean {
	return activeJob !== null && activeJob.phase !== "ready" && activeJob.phase !== "error";
}

/** Downloads a model's files, then installs its Python runtime. One job
 * at a time: a second call while one model is mid-setup is refused rather
 * than racing two installers against the same disk. */
export async function startSpeechSetup(id: SpeechModelId, device: "cpu" | "gpu"): Promise<void> {
	if (activeJob) throw new SpeechSetupInProgressError("A speech model setup is already running");
	const manifest = await loadManifest();
	const model = manifest.models.find((m) => m.id === id);
	if (!model) throw new Error(`Unknown speech model: ${id}`);

	const controller = new AbortController();
	abortControllers.set(id, controller);
	try {
		activeJob = { model: id, phase: "download", downloaded: 0, total: model.files.reduce((s, f) => s + f.size, 0), message: "Downloading model files" };
		const directory = modelDirectory(id);
		await downloadModel(directory, model.files, (p) => {
			activeJob = { model: id, phase: "download", downloaded: p.downloaded, total: p.total, message: `Downloading ${p.file}` };
		}, controller.signal);

		activeJob = { model: id, phase: "verify", downloaded: 0, total: 0, message: "Verifying downloaded files" };
		if (!(await verifyModel(directory, model.files))) throw new Error("Downloaded files failed verification");

		activeJob = { model: id, phase: "setup", downloaded: 0, total: 0, message: "Installing speech runtime" };
		await ensureSpeechRuntime(path.join(SPEECH_DATA_DIR, "runtime"), setupEngine(id, device), (p) => {
			activeJob = { model: id, phase: "setup", downloaded: 0, total: 0, message: String(p.message ?? p.phase ?? "Installing speech runtime") };
		}, controller.signal);

		activeJob = { model: id, phase: "ready", downloaded: 0, total: 0, message: `${model.label} is ready` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		activeJob = { model: id, phase: "error", downloaded: 0, total: 0, message };
		throw error;
	} finally {
		abortControllers.delete(id);
		// Clear the terminal state after it has had a chance to be read once;
		// a stuck "ready"/"error" job would otherwise block the next setup.
		setTimeout(() => { if (activeJob?.model === id) activeJob = null; }, 30_000);
	}
}

export function cancelSpeechSetup(id: SpeechModelId): boolean {
	const controller = abortControllers.get(id);
	if (!controller) return false;
	controller.abort();
	return true;
}

/** Removes one downloaded model directory. Nothing outside
 *  <data>/tts/models/<id> can be touched; a running worker for that
 *  engine is stopped first so it never holds a deleted file open. */
export async function removeSpeechModel(id: SpeechModelId): Promise<void> {
	cancelSpeechSetup(id);
	stopAllTtsWorkers();
	const directory = modelDirectory(id);
	const modelsRoot = path.join(SPEECH_DATA_DIR, "models");
	if (path.relative(modelsRoot, directory).startsWith("..")) throw new Error("Invalid model directory");
	await rm(directory, { recursive: true, force: false });
}

export interface SpeechSynthesisRequest { text: string; language: string; voice: string; speed: number; device: "auto" | "cpu" | "gpu" }
export interface SpeechSynthesisResult { audio: string; sampleRate: number; device: string }

/** Runs a single bounded chunk of cleaned text through the right engine's
 * live worker. Throws a plain Error with a message safe to show the user:
 * the worker's own error text is already a short, sanitized string. */
export async function synthesizeSpeech(request: SpeechSynthesisRequest, signal?: AbortSignal): Promise<SpeechSynthesisResult> {
	const language = speechLanguage(request.language);
	if (!language) throw new Error(`Unsupported speech language: ${request.language}`);
	const modelId = language.model as SpeechModelId;
	const directory = modelDirectory(modelId);
	const manifest = await loadManifest();
	const model = manifest.models.find((m) => m.id === modelId);
	if (!model || !(await verifyModel(directory, model.files))) {
		throw new Error(`The ${language.label} speech model is not installed yet`);
	}

	// "auto"/"cpu" both resolve against the CPU-installed runtime; a GPU
	// request needs the separate habibi-cuda install to exist.
	const wantsGpu = request.device === "gpu";
	const runtimeRoot = path.join(SPEECH_DATA_DIR, "runtime");
	const pythonDir = path.join(runtimeRoot, wantsGpu && modelId === "habibi" ? "habibi-cuda-venv" : modelId === "habibi" ? "habibi-venv" : "kokoro-venv");
	const pythonPath = path.join(pythonDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

	const engine = engineForModel(modelId, wantsGpu ? "gpu" : "cpu");
	const worker = getTtsWorker(path.join(SPEECH_DATA_DIR, "models"), engine, pythonPath);
	const response = await worker.request({
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		text: request.text,
		language: request.language,
		voice: request.voice,
		speed: request.speed,
		device: request.device,
	}, signal);
	return { audio: String(response.audio), sampleRate: Number(response.sampleRate), device: String(response.device) };
}
