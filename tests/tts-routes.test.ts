/**
 * Offline tests for the /api/tts route handlers (#tts): the route files
 * export plain functions, so they are called directly with Request
 * objects — no HTTP listener, no model download, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as getStatus } from "../app/api/tts/status/route.ts";
import { POST as postSetup, DELETE as cancelSetup } from "../app/api/tts/setup/route.ts";
import { POST as postSpeak } from "../app/api/tts/speak/route.ts";
import { DELETE as deleteModel } from "../app/api/tts/models/route.ts";

const jsonRequest = (body: unknown) => new Request("http://localhost/api/tts/test", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const deleteRequest = (body: unknown) => new Request("http://localhost/api/tts/test", {
	method: "DELETE",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

test("status reports the three manifest models with sizes and licenses", async () => {
	const res = await getStatus();
	assert.equal(res.status, 200);
	const body = (await res.json()) as { models: Array<{ id: string; size: number; license: string; ready: boolean }>; job: null };
	assert.deepEqual(body.models.map((m) => m.id).sort(), ["habibi", "kokoro", "kokoro-zh"]);
	for (const model of body.models) {
		assert.ok(model.size > 0, `${model.id} size must come from the manifest`);
		assert.ok(model.license.length > 0);
		assert.equal(model.ready, false, "fresh data dir has no models");
	}
});

test("setup rejects an unknown model and a bad device", async () => {
	const badModel = await postSetup(jsonRequest({ model: "nope" }));
	assert.equal(badModel.status, 400);
	const badDevice = await postSetup(jsonRequest({ model: "kokoro", device: "quantum" }));
	assert.equal(badDevice.status, 400);
	const cancelBad = await cancelSetup(deleteRequest({ model: "nope" }));
	assert.equal(cancelBad.status, 400);
});

test("speak rejects bad text, language, voice, speed, and device", async () => {
	const base = { text: "hello", language: "en", voice: "af_heart", speed: 1, device: "auto" };
	assert.equal((await postSpeak(jsonRequest({ ...base, text: "" }))).status, 400);
	assert.equal((await postSpeak(jsonRequest({ ...base, text: "x".repeat(1001) }))).status, 400);
	assert.equal((await postSpeak(jsonRequest({ ...base, language: "de" }))).status, 400);
	assert.equal((await postSpeak(jsonRequest({ ...base, voice: "" }))).status, 400);
	assert.equal((await postSpeak(jsonRequest({ ...base, speed: 9 }))).status, 400);
	assert.equal((await postSpeak(jsonRequest({ ...base, device: "quantum" }))).status, 400);
	// An uninstalled-but-valid request must fail clearly, not 500 blindly:
	// the kokoro model dir does not exist in a fresh data dir.
	const uninstalled = await postSpeak(jsonRequest(base));
	assert.equal(uninstalled.status, 502);
	const body = (await uninstalled.json()) as { error: string };
	assert.match(body.error, /not installed/);
});

test("models removal rejects an unknown model", async () => {
	const res = await deleteModel(deleteRequest({ model: "nope" }));
	assert.equal(res.status, 400);
});
