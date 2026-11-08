import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SpeechSettingsSection } from "../components/settings/speech-section.tsx";
import { SPEECH_LANGUAGES, type SpeechModelId, type SpeechStatus } from "../src/core/index.ts";

// Offline DOM for React (same harness as chatgpt-connection-ui.test.tsx)
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;

afterEach(async () => {
	// Unmount inside act so the status poll interval is cleaned up before fetch is restored
	await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	host = undefined;
	globalThis.fetch = originalFetch;
});

const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

// Flush React's async effect chain: settings fetch -> state set -> status fetch -> state set
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

async function mount(status: SpeechStatus, settings: unknown = {}) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	let statusCalls = 0;
	// Mock fetch: only the two endpoints the section reads; anything else fails the test (no network, no real downloads).
	// After the first status response we hang, because the component refetches whenever the job object changes identity
	// and an instant response would loop forever in the test process.
	globalThis.fetch = async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		assert.equal(typeof input === "string", true, `unexpected fetch target: ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { speech: settings } });
		if (url === "/api/tts/status") return ++statusCalls > 1 ? new Promise<Response>(() => {}) : Response.json(status);
		assert.fail(`unexpected fetch: ${url}`);
	};
	await act(async () => root!.render(<SpeechSettingsSection />));
	await flush();
}

// Match the SpeechModelStatus shape: id must be a known model id
const model = (id: SpeechModelId, label: string, license: string, size: number, ready: boolean) => ({ id, label, license, licenseUrl: `https://example.invalid/${id}`, size, ready });

const notReady: SpeechStatus = {
	models: [
		model("kokoro", "Kokoro (English)", "Apache-2.0", 330_000_000, false),
		model("kokoro-zh", "Kokoro (Chinese)", "Apache-2.0", 520_000_000, false),
		model("habibi", "Habibi (Arabic)", "CC-BY-NC-4.0", 1_500_000_000, false),
	],
	job: null,
};

test("renders language, speed and Arabic device selects with the five language labels", async () => {
	await mount(notReady);
	const language = byTest("speech-language") as HTMLSelectElement;
	assert.equal(language.getAttribute("aria-label"), "Speech language");
	// Labels must match SPEECH_LANGUAGES exactly, in order
	assert.deepEqual([...language.querySelectorAll("option")].map((o) => o.textContent), SPEECH_LANGUAGES.map((l) => l.label));
	assert.equal(language.value, "en");
	const speed = byTest("speech-speed");	assert.deepEqual([...speed.querySelectorAll("option")].map((o) => o.textContent), ["0.75×", "1×", "1.25×", "1.5×"]);
	const device = byTest("speech-device") as HTMLSelectElement;
	assert.deepEqual([...device.querySelectorAll("option")].map((o) => o.textContent), ["Automatic", "CPU", "GPU"]);
});

test("shows three model rows with license hint and Download button when not ready", async () => {
	await mount(notReady);
	for (const [id, license, size] of [["kokoro", "Apache-2.0", 330], ["kokoro-zh", "Apache-2.0", 520], ["habibi", "CC-BY-NC-4.0", 1500]] as const) {
		assert.equal(byTest(`speech-model-${id}-download`).textContent, "Download");
		// The row has no testid, so reach the hint via the button's row container
		const row = byTest(`speech-model-${id}-download`)!.parentElement!.parentElement!;
		assert.match(row.textContent!, new RegExp(`${license} · ${size} MB`));
	}
	// Not ready means no Ready/Remove/progress controls yet
	for (const id of ["kokoro", "kokoro-zh", "habibi"]) {
		assert(!byTest(`speech-model-${id}-ready`));
		assert(!byTest(`speech-model-${id}-remove`));
		assert(!byTest(`speech-model-${id}-progress`));
	}
});

test("shows Ready plus Remove when the model is ready", async () => {
	const ready: SpeechStatus = { models: notReady.models.map((m) => ({ ...m, ready: true })), job: null };
	await mount(ready);
	for (const id of ["kokoro", "kokoro-zh", "habibi"]) {
		assert.equal(byTest(`speech-model-${id}-ready`).textContent, "Ready");
		assert.equal(byTest(`speech-model-${id}-remove`).textContent, "Remove");
		assert(!byTest(`speech-model-${id}-download`));
	}
});

test("shows progress message while a job is running", async () => {
	const running: SpeechStatus = {
		...notReady,
		job: { model: "kokoro", phase: "download", downloaded: 30, total: 330, message: "Downloading 10%" },
	};
	await mount(running);
	assert.equal(byTest("speech-model-kokoro-progress").textContent, "Downloading 10%");
	// Running row swaps Download for progress; idle rows keep theirs
	assert(!byTest("speech-model-kokoro-download"));
	assert(byTest("speech-model-kokoro-zh-download"));
	assert(byTest("speech-model-habibi-download"));
});
