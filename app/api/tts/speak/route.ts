/**
 * POST /api/tts/speak — turn one bounded chunk of plain text into a WAV
 * clip. Body: {text, language, voice, speed, device}. Cancel by aborting
 * the browser's own fetch; `req.signal` carries that straight to the
 * worker process so a stopped player does not keep speaking in the
 * background.
 */
import { SPEECH_LANGUAGES } from "@/src/core";
import { synthesizeSpeech } from "@/src/server";

const MAX_TEXT_CHARS = 1000;

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { text, language, voice, speed, device } = (body ?? {}) as Record<string, unknown>;

	if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS) {
		return Response.json({ error: `text must be 1 to ${MAX_TEXT_CHARS} characters` }, { status: 400 });
	}
	if (typeof language !== "string" || !SPEECH_LANGUAGES.some((l) => l.id === language)) {
		return Response.json({ error: "Unsupported language" }, { status: 400 });
	}
	if (typeof voice !== "string" || !voice || voice.length > 64) {
		return Response.json({ error: "voice must be 1 to 64 characters" }, { status: 400 });
	}
	if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
		return Response.json({ error: "speed must be between 0.5 and 2" }, { status: 400 });
	}
	if (device !== "auto" && device !== "cpu" && device !== "gpu") {
		return Response.json({ error: 'device must be "auto", "cpu", or "gpu"' }, { status: 400 });
	}

	try {
		const result = await synthesizeSpeech({ text, language, voice, speed, device }, req.signal);
		return Response.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Speech synthesis failed";
		return Response.json({ error: message }, { status: 502 });
	}
}
