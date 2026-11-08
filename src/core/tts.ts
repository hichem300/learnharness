export const SPEECH_LANGUAGES = [
	{ id: "en", label: "English", voice: "af_heart", model: "kokoro", sample: "Welcome. Let us learn something new." },
	{ id: "fr", label: "Français", voice: "ff_siwis", model: "kokoro", sample: "Bonjour. Apprenons quelque chose de nouveau." },
	{ id: "it", label: "Italiano", voice: "im_nicola", model: "kokoro", sample: "Ciao. Impariamo qualcosa di nuovo." },
	{ id: "zh", label: "中文", voice: "zf_001", model: "kokoro-zh", sample: "你好。让我们学习新知识。" },
	{ id: "ar", label: "العربية", voice: "ALG", model: "habibi", sample: "مرحبا. هيا نتعلم شيئا جديدا." },
] as const;

export type SpeechLanguage = typeof SPEECH_LANGUAGES[number]["id"];
export type SpeechDevice = "auto" | "cpu" | "gpu";
export type SpeechModelId = "kokoro" | "kokoro-zh" | "habibi";
export interface SpeechPreferences { language: SpeechLanguage; voice: string; speed: number; device: SpeechDevice }
export const DEFAULT_SPEECH: SpeechPreferences = { language: "en", voice: "af_heart", speed: 1, device: "auto" };

export function speechLanguage(value: unknown) {
	return SPEECH_LANGUAGES.find(language => language.id === value);
}

export function parseSpeechPreferences(value: unknown): SpeechPreferences | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const language = speechLanguage(raw.language);
	if (!language || typeof raw.voice !== "string" || !/^[a-zA-Z0-9_]{1,40}$/.test(raw.voice)
		|| typeof raw.speed !== "number" || !Number.isFinite(raw.speed) || raw.speed < 0.5 || raw.speed > 2
		|| !["auto", "cpu", "gpu"].includes(raw.device as string)) return null;
	return { language: language.id, voice: raw.voice, speed: raw.speed, device: raw.device as SpeechDevice };
}

export interface SpeechModelStatus {
	id: SpeechModelId;
	label: string;
	license: string;
	licenseUrl: string;
	size: number;
	ready: boolean;
}
export interface SpeechSetupJob {
	model: SpeechModelId;
	phase: "setup" | "download" | "verify" | "ready" | "error";
	downloaded: number;
	total: number;
	message: string;
}
export interface SpeechStatus { models: SpeechModelStatus[]; job: SpeechSetupJob | null }
