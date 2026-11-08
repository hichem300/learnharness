/**
 * GET /api/tts/status — which speech models are ready to speak, and
 * whether a download/setup job is running right now. The settings
 * screen polls this while a model installs.
 */
import { speechStatus } from "@/src/server";

export async function GET() {
	return Response.json(await speechStatus());
}
