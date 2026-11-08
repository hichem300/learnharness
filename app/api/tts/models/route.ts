/**
 * DELETE /api/tts/models — remove one downloaded speech model so its disk
 * space comes back. Path containment and worker shutdown live in the
 * server seam (removeSpeechModel), the route stays a thin validation
 * shell like every other app/api route.
 */
import { removeSpeechModel } from "@/src/server";

const MODEL_IDS = new Set(["kokoro", "kokoro-zh", "habibi"]);

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
	try {
		await removeSpeechModel(model as "kokoro" | "kokoro-zh" | "habibi");
		return Response.json({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Model removal failed";
		return Response.json({ ok: false, error: message }, { status: 500 });
	}
}
