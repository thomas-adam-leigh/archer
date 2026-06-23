/**
 * Voice transcription for the web client (the transcribe seam of
 * `apps/mobile/src/lib/voice.ts`).
 *
 * Archer's start-from-scratch path is voice-first: a recorded clip is POSTed to
 * the Supabase `transcribe` edge function (`verify_jwt=true`, ElevenLabs Scribe)
 * and only the TEXT comes back — the audio is NEVER persisted.
 *
 * This module owns both halves of voice input: browser microphone capture via
 * `MediaRecorder` ({@link createBrowserRecorder}) and the transcribe contract
 * ({@link transcribe}). A caller records a clip then hands its bytes here to get
 * back a transcript string — the audio is never persisted.
 */

import { getSupabasePublishableKey, getSupabaseUrl } from "#/lib/supabase.ts";

/** The Supabase edge function that turns audio into text (`verify_jwt=true`). */
export function getTranscribeUrl(): string {
	return `${getSupabaseUrl()}/functions/v1/transcribe`;
}

/** Why a voice capture failed, for callers that want to branch on the cause. */
export type VoiceErrorCode =
	| "no-recorder" // this browser can't record (no MediaRecorder / getUserMedia)
	| "permission-denied" // the user declined microphone access
	| "recording-failed" // capture failed for some other reason
	| "empty-audio" // recording produced no bytes
	| "transcribe-failed"; // the edge function returned no usable transcript

/** A voice-capture failure carrying a message safe to show in the UI. */
export class VoiceInputError extends Error {
	readonly code: VoiceErrorCode;

	constructor(message: string, code: VoiceErrorCode) {
		super(message);
		this.name = "VoiceInputError";
		this.code = code;
	}
}

/** A recorded audio clip: the raw bytes and their MIME type. */
export interface AudioClip {
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}

/**
 * POST one recorded clip to the transcribe edge function and return the TEXT.
 * Sends the user's JWT (`verify_jwt=true`) plus the publishable `apikey` the
 * Supabase gateway expects. Throws {@link VoiceInputError} on a non-2xx response
 * or a body without a usable transcript; the audio is never persisted.
 */
export async function transcribe(
	clip: AudioClip,
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	if (clip.bytes.length === 0) {
		throw new VoiceInputError("No audio to transcribe.", "empty-audio");
	}
	const res = await fetchImpl(getTranscribeUrl(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			apikey: getSupabasePublishableKey(),
			"Content-Type": clip.mimeType,
		},
		body: new Blob([clip.bytes], { type: clip.mimeType }),
	});

	const body = (await res.json().catch(() => null)) as {
		transcript?: unknown;
		error?: unknown;
	} | null;

	if (!res.ok) {
		const message =
			typeof body?.error === "string"
				? body.error
				: `Transcription failed (${res.status}).`;
		throw new VoiceInputError(message, "transcribe-failed");
	}

	const transcript =
		typeof body?.transcript === "string" ? body.transcript : "";
	if (transcript.trim() === "") {
		throw new VoiceInputError(
			"Sorry, I couldn't make out any speech. Please try again.",
			"transcribe-failed",
		);
	}
	return transcript;
}

/**
 * Records a single audio clip from the microphone. Browser recording is
 * two-phase and user-driven — the candidate taps record, speaks, then taps stop
 * — so unlike the mobile one-shot recorder this exposes explicit
 * {@link start}/{@link stop}, plus {@link cancel} to abandon a take and release
 * the mic.
 */
export interface VoiceRecorder {
	/** Request the mic and begin capturing. Rejects with a {@link VoiceInputError}. */
	start(): Promise<void>;
	/** Stop capturing and resolve the recorded clip. Rejects with a {@link VoiceInputError}. */
	stop(): Promise<AudioClip>;
	/** Abort the current take and release the mic without producing a clip. */
	cancel(): void;
}

/** The browser APIs {@link createBrowserRecorder} needs; injected in tests. */
export interface BrowserRecorderDeps {
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	MediaRecorderImpl?: typeof MediaRecorder;
}

/** Whether this environment can capture microphone audio at all. */
export function isVoiceRecordingSupported(
	nav: Navigator | undefined = globalThis.navigator,
	MediaRecorderImpl:
		| typeof MediaRecorder
		| undefined = globalThis.MediaRecorder,
): boolean {
	return (
		typeof nav?.mediaDevices?.getUserMedia === "function" &&
		Boolean(MediaRecorderImpl)
	);
}

function mapCaptureError(err: unknown): VoiceInputError {
	const name = (err as { name?: string })?.name;
	if (name === "NotAllowedError" || name === "SecurityError") {
		return new VoiceInputError(
			"Microphone access is needed to record. Please enable it and try again.",
			"permission-denied",
		);
	}
	const message =
		err instanceof Error && err.message ? err.message : "Recording failed.";
	return new VoiceInputError(message, "recording-failed");
}

/**
 * A {@link VoiceRecorder} backed by the browser's `MediaRecorder`. Captures into
 * memory chunks, assembles them into an {@link AudioClip} on stop, and always
 * stops the underlying tracks so the mic indicator clears.
 */
export function createBrowserRecorder(
	deps: BrowserRecorderDeps = {},
): VoiceRecorder {
	const getUserMedia =
		deps.getUserMedia ??
		((c: MediaStreamConstraints) =>
			globalThis.navigator.mediaDevices.getUserMedia(c));
	const MediaRecorderImpl = deps.MediaRecorderImpl ?? globalThis.MediaRecorder;

	let stream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	const chunks: Blob[] = [];

	const releaseMic = () => {
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		recorder = null;
	};

	return {
		async start() {
			if (!MediaRecorderImpl) {
				throw new VoiceInputError(
					"Voice recording is not available in this browser.",
					"no-recorder",
				);
			}
			chunks.length = 0;
			try {
				stream = await getUserMedia({ audio: true });
			} catch (err) {
				throw mapCaptureError(err);
			}
			recorder = new MediaRecorderImpl(stream);
			recorder.ondataavailable = (e: BlobEvent) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			recorder.start();
		},
		stop() {
			const rec = recorder;
			if (!rec) {
				return Promise.reject(
					new VoiceInputError("Not recording.", "recording-failed"),
				);
			}
			return new Promise<AudioClip>((resolve, reject) => {
				rec.onstop = async () => {
					const mimeType = rec.mimeType || "audio/webm";
					const blob = new Blob(chunks, { type: mimeType });
					releaseMic();
					const bytes = new Uint8Array(await blob.arrayBuffer());
					if (bytes.length === 0) {
						reject(
							new VoiceInputError("No audio was recorded.", "empty-audio"),
						);
						return;
					}
					resolve({ bytes, mimeType });
				};
				rec.onerror = () => {
					releaseMic();
					reject(new VoiceInputError("Recording failed.", "recording-failed"));
				};
				rec.stop();
			});
		},
		cancel() {
			releaseMic();
		},
	};
}
