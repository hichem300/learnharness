/**
 * Real end-to-end TTS check on this host (#tts): installs the managed
 * Python runtime, downloads the Kokoro model with hash verification,
 * then synthesizes one English sentence through the real worker process.
 * Not a unit test — it hits the network and takes minutes.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const setupUrl = pathToFileURL(path.join(root, "runtime/tts/setup.mjs")).href;
const { createSpeechRuntimeInstaller } = await import(setupUrl);
const tts = await import("../src/server/tts-download.ts");
const speak = await import("../src/server/tts.ts");

const modelId = process.argv[2] ?? "kokoro";
const text = process.argv[3] ?? "Welcome to LearnHarness.";
const language = process.argv[4] ?? "en";

const onProgress = (p) => console.log(`[setup] ${p.phase}: ${p.message}`);
const pythonPath = await createSpeechRuntimeInstaller({})(path.join(root, "data/tts/runtime"), modelId === "habibi" ? "habibi" : "kokoro", onProgress);
console.log(`[setup] python: ${pythonPath}`);

const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "runtime/tts/models.json"), "utf8"));
const model = manifest.models.find((m) => m.id === modelId);
const directory = path.join(root, "data/tts/models", modelId);
let total = 0;
await tts.downloadModel(directory, model.files, (p) => {
	const pct = Math.round((p.downloaded / p.total) * 100);
	if (pct !== total) { total = pct; console.log(`[download] ${p.file}: ${pct}%`); }
});
console.log("[download] complete and verified");

// The voice comes from the same default table the app uses, so a missing
// language branch here can never send a wrong-engine voice again.
const { SPEECH_LANGUAGES } = await import("../src/core/index.ts");
const defaultVoice = SPEECH_LANGUAGES.find((l) => l.id === language)?.voice;
if (!defaultVoice) throw new Error(`no default voice for language ${language}`);
const result = await speak.synthesizeSpeech({ text, language, voice: defaultVoice, speed: 1, device: "auto" });
const bytes = Math.round((result.audio.length * 3) / 4);
console.log(`[speak] ${bytes} bytes WAV at ${result.sampleRate} Hz on ${result.device}`);
await (await import("node:fs/promises")).writeFile(path.join(root, `data/tts/out-${language}.wav`), Buffer.from(result.audio, "base64"));
console.log(`[speak] wrote data/tts/out-${language}.wav`);
