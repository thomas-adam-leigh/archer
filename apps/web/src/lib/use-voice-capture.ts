/**
 * `useVoiceCapture` — the voice-first input surface the scripted Q&A consumes.
 *
 * Browser recording is two-phase and user-driven (tap to record, tap to stop),
 * so the web equivalent of the mobile one-shot `captureVoice()` is a React hook:
 * it owns the {@link VoiceRecorder} lifecycle, drives a small status machine, and
 * on stop transcribes the clip (audio → text, never persisted) and hands the
 * transcript to `onTranscript`. Every recording/transcription failure surfaces as
 * a single displayable `error` string, so the caller keeps one graceful fallback
 * (the text box) for "no mic / declined / nothing heard".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "#/lib/session.ts";
import {
	createBrowserRecorder,
	isVoiceRecordingSupported,
	transcribe,
	type VoiceRecorder,
} from "#/lib/voice.ts";

/** Where a capture is in its lifecycle. */
export type VoiceCaptureStatus = "idle" | "recording" | "transcribing";

/** The voice-capture controls + state a component renders against. */
export interface UseVoiceCapture {
	status: VoiceCaptureStatus;
	/** A displayable message for the last failure, or `null`. */
	error: string | null;
	/** Whether this browser can record at all (resolved after mount, SSR-safe). */
	supported: boolean;
	/** Request the mic and begin recording. */
	start: () => void;
	/** Stop recording, transcribe, and deliver the transcript via `onTranscript`. */
	stop: () => void;
	/** Abandon the current take and release the mic. */
	cancel: () => void;
}

/**
 * Capture one spoken answer at a time. `onTranscript` fires with the recognised
 * text once a take is stopped and transcribed; the caller decides what to do with
 * it (e.g. drop it into the answer box for review before submitting).
 */
export function useVoiceCapture(
	onTranscript: (text: string) => void,
): UseVoiceCapture {
	const session = useSession();
	const [status, setStatus] = useState<VoiceCaptureStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [supported, setSupported] = useState(false);
	const recorderRef = useRef<VoiceRecorder | null>(null);

	// `navigator`/`MediaRecorder` only exist client-side; match SSR (false) then
	// resolve after mount, the same shape as the session hydration effect.
	useEffect(() => {
		setSupported(isVoiceRecordingSupported());
	}, []);

	const start = useCallback(() => {
		if (status !== "idle") return;
		if (!session) {
			setError("You need to be signed in to record.");
			return;
		}
		setError(null);
		setStatus("recording");
		const recorder = createBrowserRecorder();
		recorderRef.current = recorder;
		recorder.start().catch((err: unknown) => {
			recorderRef.current = null;
			setStatus("idle");
			setError(messageFor(err));
		});
	}, [status, session]);

	const stop = useCallback(() => {
		const recorder = recorderRef.current;
		if (status !== "recording" || !recorder || !session) return;
		setStatus("transcribing");
		recorder
			.stop()
			.then((clip) => transcribe(clip, session.accessToken))
			.then((text) => {
				onTranscript(text);
				setStatus("idle");
			})
			.catch((err: unknown) => {
				setStatus("idle");
				setError(messageFor(err));
			})
			.finally(() => {
				recorderRef.current = null;
			});
	}, [status, session, onTranscript]);

	const cancel = useCallback(() => {
		recorderRef.current?.cancel();
		recorderRef.current = null;
		setStatus("idle");
	}, []);

	// Release the mic if the component unmounts mid-take.
	useEffect(() => () => recorderRef.current?.cancel(), []);

	return { status, error, supported, start, stop, cancel };
}

/** Prefer a thrown `VoiceInputError`'s message; fall back to a generic one. */
function messageFor(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	return "Something went wrong recording. Please try again.";
}
