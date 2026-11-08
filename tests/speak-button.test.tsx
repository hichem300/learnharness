/**
 * Offline UI tests for the read-aloud button (#tts): linkedom DOM, a fake
 * Audio element, and a fake fetch. No model, no network, no audio device.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { SpeakButton } from "../components/speak-button.tsx";
import {
	getSpeechPlaybackState,
	reportSpeechDone,
	reportSpeechError,
	startSpeech,
	stopSpeech,
	useSpeechPlayback,
} from "../components/speech-playback.ts";
import type { SpeechPreferences } from "../src/core/index.ts";

class FakeAudio {
	static all: FakeAudio[] = [];
	onended: (() => void) | null = null;
	playing = false;
	constructor(public src: string) { FakeAudio.all.push(this); }
	async play() { this.playing = true; }
	pause() { this.playing = false; }
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

interface SpeakCall { text: string; language: string; voice: string; speed: number; device: string }

async function fixture(prefs: SpeechPreferences, speakResponse: { status: number; body: object }) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		speakCalls: [] as SpeakCall[],
		clicked: 0,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React,
		window: dom.window,
		document: dom.document,
		IS_REACT_ACT_ENVIRONMENT: true,
		Audio: FakeAudio,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") {
				return Response.json({ settings: { version: 1, speech: prefs } });
			}
			assert.equal(url, "/api/tts/speak");
			state.speakCalls.push(JSON.parse(init?.body as string) as SpeakCall);
			return Response.json(speakResponse.body, { status: speakResponse.status });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latestPhase: string | null = null;
	function Harness({ id, markdown }: { id: string; markdown: string }) {
		const playback = useSpeechPlayback(id);
		latestPhase = playback.phase;
		return <SpeakButton messageId={id} markdown={markdown} />;
	}
	const root = createRoot(document.getElementById("root")!);
	const mount = async (id: string, markdown: string) => {
		await act(async () => { root.render(<Harness id={id} markdown={markdown} />); });
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		mount,
		get phase() { return latestPhase; },
		button: () => dom.document.querySelector("[data-testid='speak-button']") as HTMLButtonElement,
	};
}

afterEach(async () => {
	stopSpeech();
	await dispose?.();
	restore?.();
	dispose = undefined;
	restore = undefined;
	FakeAudio.all = [];
});

test("clicking speak cleans markdown and plays the synthesized clip", async () => {
	const f = await fixture(
		{ language: "fr", voice: "ff_siwis", speed: 1, device: "auto" },
		{ status: 200, body: { audio: "dGVzdA==", sampleRate: 24000, device: "cpu" } },
	);
	await f.mount("m1", "## Title\n\nBonjour **le** monde. [Un lien](https://example.com).");
	await act(async () => { f.button().click(); });
	assert.equal(f.state.speakCalls.length, 1);
	const call = f.state.speakCalls[0]!;
	// Markdown must be gone: no #, no **, no link URL — the label survives.
	assert.equal(call.text, "Title Bonjour le monde. Un lien.");
	assert.equal(call.language, "fr");
	assert.equal(call.voice, "ff_siwis");
	assert.equal(f.phase, "playing");
	assert.ok(FakeAudio.all[0]?.playing);
});

test("a speak failure shows an error and offers retry", async () => {
	const f = await fixture(
		{ language: "en", voice: "af_heart", speed: 1, device: "auto" },
		{ status: 502, body: { error: "The English speech model is not installed yet" } },
	);
	await f.mount("m1", "Hello there.");
	await act(async () => { f.button().click(); });
	assert.equal(f.phase, "error");
	const retryBody = JSON.parse(JSON.stringify({ status: 200, body: { audio: "dGVzdA==", sampleRate: 24000, device: "cpu" } }));
	// Swap the fixture's failure for a success and retry via the same button.
	// (fetch is a shared global; rebuild it for the retry.)
	const previousFetch = globals.fetch;
	globals.fetch = async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: { version: 1 } });
		assert.equal(url, "/api/tts/speak");
		return Response.json(retryBody.body, { status: 200 });
	};
	try {
		await act(async () => { f.button().click(); });
		assert.equal(f.phase, "playing");
	} finally {
		globals.fetch = previousFetch;
	}
});

test("starting a second message stops the first", () => {
	startSpeech("a", () => {});
	assert.equal(getSpeechPlaybackState().messageId, "a");
	startSpeech("b", () => {});
	assert.equal(getSpeechPlaybackState().messageId, "b");
});

test("done and error reports only affect their own message", () => {
	startSpeech("a", () => {});
	reportSpeechError("other", "nope");
	assert.equal(getSpeechPlaybackState().messageId, "a");
	assert.equal(getSpeechPlaybackState().error, null);
	reportSpeechDone("a");
	assert.equal(getSpeechPlaybackState().messageId, null);
});
