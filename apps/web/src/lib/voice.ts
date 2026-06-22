/**
 * Voice transcription for the web client (the transcribe seam of
 * `apps/mobile/src/lib/voice.ts`).
 *
 * Archer's start-from-scratch path is voice-first: a recorded clip is POSTed to
 * the Supabase `transcribe` edge function (`verify_jwt=true`, ElevenLabs Scribe)
 * and only the TEXT comes back — the audio is NEVER persisted.
 *
 * This module owns just the transcribe contract. Browser microphone capture
 * (`MediaRecorder`) is built on top of it in ARC-119; here a caller hands us the
 * recorded {@link AudioClip} bytes and receives a transcript string.
 */

import { getSupabasePublishableKey, getSupabaseUrl } from "#/lib/supabase.ts";

/** The Supabase edge function that turns audio into text (`verify_jwt=true`). */
export function getTranscribeUrl(): string {
	return `${getSupabaseUrl()}/functions/v1/transcribe`;
}

/** Why a voice capture failed, for callers that want to branch on the cause. */
export type VoiceErrorCode =
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
