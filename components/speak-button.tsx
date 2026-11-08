"use client";
/**
 * The read-aloud button (#tts): one per assistant message. It cleans the
 * markdown into plain speech text, sends bounded chunks to
 * /api/tts/speak, and plays the returned WAV clips back to back. One
 * message speaks at a time (speech-playback.ts); dictation or another
 * message's button stops this one first.
 */

import { useCallback, useEffect, useRef } from "react";
import { Volume2, Pause, Play, RotateCcw } from "lucide-react";
import { speechChunks, speechText, SPEECH_LANGUAGES, type SpeechPreferences } from "@/src/core";
import { isDictationActive } from "@/components/dictation-state";
import {
	reportSpeechDone,
	reportSpeechError,
	reportSpeechPlaying,
	startSpeech,
	stopSpeech,
	useSpeechPlayback,
} from "@/components/speech-playback";
import { MessageAction } from "@/components/ai-elements/message";

const CHUNK_CHAR_BUDGET = 400;

/** Reads the saved speech preferences; defaults to English/auto when the
 *  settings record has none yet. */
async function readPreferences(): Promise<SpeechPreferences> {
	try {
		const res = await fetch("/api/settings");
		if (res.ok) {
			const body = (await res.json()) as { settings?: { speech?: unknown } };
			const stored = body.settings?.speech;
			if (stored && typeof stored === "object") return stored as SpeechPreferences;
		}
	} catch { /* the default is a real preference, not a fallback lie */ }
	return { language: "en", voice: "af_heart", speed: 1, device: "auto" };
}

export function SpeakButton({ markdown, messageId }: { markdown: string; messageId: string }) {
	const { phase, error } = useSpeechPlayback(messageId);
	const abortRef = useRef<AbortController | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const queueRef = useRef<string[]>([]);
	const pausedRef = useRef(false);

	useEffect(() => {
		// Leaving the page (or this message unmounting) must not leave a
		// voice running in the background.
		return () => stopSpeech();
	}, []);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		queueRef.current = [];
		pausedRef.current = false;
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}
	}, []);

	const playNext = useCallback(async (controller: AbortController) => {
		const text = queueRef.current.shift();
		if (!text) {
			reportSpeechDone(messageId);
			return;
		}
		const prefs = await readPreferences();
		if (controller.signal.aborted) return;
		try {
			const res = await fetch("/api/tts/speak", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text,
					language: prefs.language,
					voice: prefs.voice,
					speed: prefs.speed,
					device: prefs.device,
				}),
				signal: controller.signal,
			});
			const body = (await res.json()) as { audio?: string; sampleRate?: number; error?: string };
			if (!res.ok || !body.audio) throw new Error(body.error ?? `Speech request failed (${res.status})`);
			const audio = new Audio(`data:audio/wav;base64,${body.audio}`);
			audioRef.current = audio;
			audio.onended = () => {
				if (controller.signal.aborted) return;
				void playNext(controller);
			};
			reportSpeechPlaying(messageId);
			await audio.play();
		} catch (e) {
			if (controller.signal.aborted) return;
			reportSpeechError(messageId, e instanceof Error ? e.message : "Speech failed");
		}
	}, [messageId]);

	const start = useCallback(() => {
		if (isDictationActive()) return;
		const cleaned = speechText(markdown);
		if (!cleaned.trim()) return;
		const controller = new AbortController();
		abortRef.current = controller;
		// startSpeech() stops any other message first — the one-speaker rule
		// lives there, not here.
		startSpeech(messageId, stop);
		queueRef.current = speechChunks(cleaned, CHUNK_CHAR_BUDGET);
		void playNext(controller);
	}, [markdown, messageId, playNext, stop]);

	const resume = useCallback(() => {
		pausedRef.current = false;
		audioRef.current?.play();
		reportSpeechPlaying(messageId);
	}, [messageId]);

	const toggle = useCallback(() => {
		if (phase === "playing") {
			pausedRef.current = true;
			audioRef.current?.pause();
			// Paused is shown by the button itself; the shared store keeps
			// "playing" so the icon swap is local state only.
			return;
		}
		if (phase === "loading" || phase === "error") {
			if (phase === "error") start();
			return;
		}
		if (audioRef.current && pausedRef.current) {
			resume();
			return;
		}
		start();
	}, [phase, resume, start]);

	const Icon = phase === "playing" ? Pause : phase === "loading" ? RotateCcw : phase === "error" ? RotateCcw : Volume2;
	return (
		<MessageAction
			tooltip={phase === "error" ? (error ?? "Speech failed — click to retry") : "Read aloud"}
			aria-label={phase === "error" ? "Read aloud failed, click to retry" : "Read aloud"}
			data-testid="speak-button"
			disabled={isDictationActive()}
			onClick={toggle}
		>
			<Icon size={14} className={phase === "loading" ? "animate-spin" : ""} />
		</MessageAction>
	);
}

export const SPEAK_LANGUAGE_LABELS = SPEECH_LANGUAGES;
