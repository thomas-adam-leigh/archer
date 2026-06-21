// ElevenLabs Speech-to-Text (Scribe) core — factored out of the Deno entry
// (index.ts) so it is unit-testable under vitest with `fetch` MOCKED (CI never
// calls the live ElevenLabs API). It uses only Web-standard APIs (fetch,
// FormData, Blob), so the same module runs unchanged on Deno (the edge runtime)
// and on Node (the tests).
//
// The audio bytes exist only as this function's argument for the duration of the
// HTTP call to ElevenLabs — they are NEVER written to storage, the database, or
// disk. The only thing that leaves is the transcript TEXT (+ provenance).

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** ElevenLabs Scribe model. Swappable via `modelId`, but the product default. */
export const DEFAULT_STT_MODEL = "scribe_v1";

export interface TranscribeOptions {
  /** The ElevenLabs API key (read from a Supabase secret by the caller). */
  apiKey: string;
  /** ElevenLabs STT model id (default `scribe_v1`). */
  modelId?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface TranscribeResult {
  /** The transcribed text — the only thing the backend ever ingests. */
  transcript: string;
  /** Provenance: the provider that produced the transcript. */
  provider: "elevenlabs";
  /** Detected language code, when the provider returns one. */
  languageCode?: string;
}

/** A failure transcribing the audio (missing key, provider error, empty body). */
export class TranscriptionError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
  }
}

/**
 * Transcribe one audio blob via ElevenLabs Speech-to-Text (Scribe). Returns the
 * transcript TEXT only; the audio is never persisted. Throws TranscriptionError
 * on a missing key, empty audio, a non-2xx response, or a textless body.
 */
export async function transcribeAudio(
  audio: Blob,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  if (!opts.apiKey) throw new TranscriptionError("ELEVENLABS_API_KEY is not configured");
  if (!audio || audio.size === 0) throw new TranscriptionError("empty audio", 400);

  const doFetch = opts.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("file", audio, "audio");
  form.set("model_id", opts.modelId ?? DEFAULT_STT_MODEL);

  const res = await doFetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TranscriptionError(
      `ElevenLabs STT failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      res.status,
    );
  }

  const body = (await res.json().catch(() => null)) as {
    text?: unknown;
    language_code?: unknown;
  } | null;
  const transcript = typeof body?.text === "string" ? body.text : null;
  if (transcript === null) {
    throw new TranscriptionError("ElevenLabs STT returned no transcript text", res.status);
  }
  const languageCode = typeof body?.language_code === "string" ? body.language_code : undefined;
  return { transcript, provider: "elevenlabs", languageCode };
}
