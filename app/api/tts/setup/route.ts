/**
 * POST /api/tts/setup — start downloading and installing one speech
 * model. DELETE — cancel the model's own in-flight setup.
 *
 * Body: {model: "kokoro"|"kokoro-zh"|"habibi", device?: "cpu"|"gpu"}.
 * Setup runs in the background; the caller polls GET /api/tts/status
 * for progress instead of waiting on this request.
 */
import { cancelSpeechSetup, isSpeechSetupActive, startSpeechSetup } from "@/src/server";

const MODEL_IDS = new Set(["kokoro", "kokoro-zh", "habibi"]);

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { model, device } = (body ?? {}) as { model?: string; device?: string };
	if (typeof model !== "string" || !MODEL_IDS.has(model)) {
		return Response.json({ error: 'model must be "kokoro", "kokoro-zh", or "habibi"' }, { status: 400 });
	}
	if (device !== undefined && device !== "cpu" && device !== "gpu") {
		return Response.json({ error: 'device must be "cpu" or "gpu"' }, { status: 400 });
	}

	if (isSpeechSetupActive()) {
		return Response.json({ error: "A speech model setup is already running" }, { status: 409 });
	}

	// Setup runs for minutes; this request returns as soon as the job has
	// started, not when it finishes. The caller polls GET /api/tts/status
	// for progress and for any failure that happens during the run.
	startSpeechSetup(model as "kokoro" | "kokoro-zh" | "habibi", device === "gpu" ? "gpu" : "cpu").catch(() => {
		/* surfaced through speechStatus().job, not this response */
	});
	return Response.json({ started: true });
}

export async function DELETE(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { model } = (body ?? {}) as { model?: string };
	if (typeof model !== "string" || !MODEL_IDS.has(model)) {
		return Response.json({ error: 'model must be "kokoro", "kokoro-zh", or "habibi"' }, { status: 400 });
	}
	const cancelled = cancelSpeechSetup(model as "kokoro" | "kokoro-zh" | "habibi");
	return Response.json({ cancelled });
}
