"use client";
/**
 * One speaking message at a time, across the whole app (#tts). WHY a
 * module-level store and not per-button state: starting a second clip
 * must stop the first, and dictation starting must stop whichever is
 * speaking — both need to reach every button without prop drilling.
 */

import { useSyncExternalStore } from "react";
import { setDictationActive, isDictationActive } from "@/components/dictation-state";

export type SpeechPlaybackPhase = "idle" | "loading" | "playing" | "error";

interface PlaybackState {
	messageId: string | null;
	phase: SpeechPlaybackPhase;
	error: string | null;
}

let state: PlaybackState = { messageId: null, phase: "idle", error: null };
let currentStop: (() => void) | null = null;
const listeners = new Set<() => void>();

function setState(next: PlaybackState): void {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useSpeechPlayback(messageId: string): { phase: SpeechPlaybackPhase; error: string | null; isThis: boolean } {
	const snapshot = useSyncExternalStore(subscribe, () => state, () => ({ messageId: null, phase: "idle" as const, error: null }));
	const isThis = snapshot.messageId === messageId;
	return { phase: isThis ? snapshot.phase : "idle", error: isThis ? snapshot.error : null, isThis };
}

/** The raw store state for non-React readers (tests, diagnostics). */
export function getSpeechPlaybackState(): PlaybackState & { messageId: string | null } {
	return state;
}

/** Stops whatever is currently speaking, if anything. Safe to call when
 * nothing is playing. */
export function stopSpeech(): void {
	currentStop?.();
	currentStop = null;
	setState({ messageId: null, phase: "idle", error: null });
}

/** Registers the running player for `messageId`; the caller does the
 * actual fetch/audio work and reports state back through the setters it
 * is given. Starting a new message's playback stops any other message
 * first — only one speaks at a time. */
export function startSpeech(messageId: string, stop: () => void): void {
	if (isDictationActive()) return;
	stopSpeech();
	currentStop = stop;
	setState({ messageId, phase: "loading", error: null });
}

export function reportSpeechPlaying(messageId: string): void {
	if (state.messageId !== messageId) return;
	setState({ messageId, phase: "playing", error: null });
}

export function reportSpeechError(messageId: string, message: string): void {
	if (state.messageId !== messageId) return;
	currentStop = null;
	setState({ messageId, phase: "error", error: message });
}

export function reportSpeechDone(messageId: string): void {
	if (state.messageId !== messageId) return;
	currentStop = null;
	setState({ messageId: null, phase: "idle", error: null });
}
