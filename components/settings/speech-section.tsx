"use client";
/**
 * Speech settings: language/voice/speed/device picked here, plus the
 * four model rows with Download/Remove/progress. No separate running
 * server to start — the first "Download" call also installs the Python
 * runtime behind it (ensureSpeechRuntime), so "ready" means "can speak".
 */

import { useEffect, useState } from "react";
import {
	SPEECH_LANGUAGES,
	DEFAULT_SPEECH,
	parseSpeechPreferences,
	type SpeechModelStatus,
	type SpeechPreferences,
	type SpeechStatus,
} from "@/src/core";
import { SettingsRow, ThinSelect } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

async function fetchSpeechPreference(): Promise<SpeechPreferences> {
	const res = await fetch("/api/settings");
	if (!res.ok) return DEFAULT_SPEECH;
	const body = (await res.json()) as { settings?: { speech?: unknown } };
	return parseSpeechPreferences(body.settings?.speech) ?? DEFAULT_SPEECH;
}

async function saveSpeechPreference(next: SpeechPreferences): Promise<void> {
	await fetch("/api/settings/speech", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(next),
	});
	notifySettingsSaved("speech");
}

export function SpeechSettingsSection() {
	const [preference, setPreference] = useState<SpeechPreferences | null>(null);
	const [status, setStatus] = useState<SpeechStatus | null>(null);

	useEffect(() => { void fetchSpeechPreference().then(setPreference); }, []);

	// Poll status only while a job is running; one request is enough once
	// every model row is settled.
	useEffect(() => {
		let stopped = false;
		const poll = async () => {
			const res = await fetch("/api/tts/status");
			if (stopped || !res.ok) return;
			const next = (await res.json()) as SpeechStatus;
			setStatus(next);
		};
		void poll();
		const id = setInterval(() => { if (status?.job) void poll(); }, 1000);
		return () => { stopped = true; clearInterval(id); };
	}, [status?.job]);

	if (!preference) return null;
	const save = (next: SpeechPreferences) => {
		setPreference(next);
		void saveSpeechPreference(next);
	};

	return (
		<div data-testid="speech-section" className="flex flex-col gap-3">
			<SettingsRow label="Language">
				{/* dir=auto: the Arabic option's own text decides its direction
				inside the closed control, without flipping the whole row. */}
				<ThinSelect
					ariaLabel="Speech language"
					testid="speech-language"
					dir="auto"
					value={preference.language}
					onChange={(value) => {
						const language = SPEECH_LANGUAGES.find((l) => l.id === value);
						if (language) save({ ...preference, language: language.id, voice: language.voice });
					}}
				>
					{SPEECH_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow label="Speed">
				<ThinSelect
					ariaLabel="Speech speed"
					testid="speech-speed"
					value={String(preference.speed)}
					onChange={(value) => save({ ...preference, speed: Number(value) })}
				>
					{[0.75, 1, 1.25, 1.5].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow label="Arabic device" hint="Only affects Habibi (Arabic).">
				<ThinSelect
					ariaLabel="Speech device for Arabic"
					testid="speech-device"
					value={preference.device}
					onChange={(value) => save({ ...preference, device: value as SpeechPreferences["device"] })}
				>
					<option value="auto">Automatic</option>
					<option value="cpu">CPU</option>
					<option value="gpu">GPU</option>
				</ThinSelect>
			</SettingsRow>
			<div className="mt-2 flex flex-col gap-2">
				{(status?.models ?? []).map((model) => (
					<ModelRow key={model.id} model={model} job={status?.job?.model === model.id ? status.job : null} />
				))}
			</div>
		</div>
	);
}

function ModelRow({ model, job }: { model: SpeechModelStatus; job: { phase: string; downloaded: number; total: number; message: string } | null }) {
	const busy = job !== null && job.phase !== "ready" && job.phase !== "error";
	const [error, setError] = useState<string | null>(null);
	const start = (device: "cpu" | "gpu") => {
		void fetch("/api/tts/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: model.id, device }),
		});
	};
	const remove = async () => {
		setError(null);
		const res = await fetch("/api/tts/models", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: model.id }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? "Model removal failed");
		}
	};
	return (
		<SettingsRow
			label={model.label}
			hint={job?.phase === "error" ? job.message : error ?? `${model.license} · ${(model.size / 1_000_000).toFixed(0)} MB`}
		>
			<div className="flex items-center gap-2">
				{model.ready ? (
					<>
						<span data-testid={`speech-model-${model.id}-ready`} className="text-xs text-muted-foreground">Ready</span>
						<button
							type="button"
							data-testid={`speech-model-${model.id}-remove`}
							aria-label={`Remove ${model.label}`}
							onClick={() => void remove()}
							className="h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground hover:border-destructive/50"
						>
							Remove
						</button>
					</>
				) : busy ? (
					<span data-testid={`speech-model-${model.id}-progress`} className="text-xs text-muted-foreground">{job?.message}</span>
				) : (
					<button
						type="button"
						data-testid={`speech-model-${model.id}-download`}
						onClick={() => start("cpu")}
						className="h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground hover:border-muted-foreground/50"
					>
						Download
					</button>
				)}
			</div>
		</SettingsRow>
	);
}
