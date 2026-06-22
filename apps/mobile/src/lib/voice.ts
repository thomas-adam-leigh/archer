/**
 * Voice input for the Lynx client: record a clip → transcribe it via the
 * Supabase `transcribe` edge function → return the TEXT.
 *
 * Archer is voice-first. This is the shared capture path behind résumé review
 * feedback (Milestone 5), job-preference tuning (Milestone 6), and
 * conversational onboarding (Milestone 7): a caller awaits `captureVoice()` and
 * receives a transcript string to submit as the user's answer/feedback. The
 * audio bytes are POSTed to the edge function (`verify_jwt=true`, ElevenLabs
 * Scribe) and NEVER persisted — only the text comes back (ARC-53).
 *
 * Recording goes through a host-provided native module: Lynx's background thread
 * has no `MediaRecorder`, so — exactly as `./storage.ts` wraps the native
 * key-value store — we wrap a native recorder and fall back to a recorder that
 * fails with a clear, displayable error when the host hasn't registered one.
 */

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase.js';

/** The Supabase edge function that turns audio into text (`verify_jwt=true`). */
export const TRANSCRIBE_URL = `${SUPABASE_URL}/functions/v1/transcribe`;

/** Why a voice capture failed, for callers that want to branch on the cause. */
export type VoiceErrorCode =
  | 'no-recorder' // no native recorder is registered on this host
  | 'permission-denied' // the user declined microphone access
  | 'recording-failed' // the device failed to produce a recording
  | 'empty-audio' // recording produced no bytes
  | 'transcribe-failed'; // the edge function returned no usable transcript

/** A voice-capture failure carrying a message safe to show in the UI. */
export class VoiceInputError extends Error {
  readonly code: VoiceErrorCode;

  constructor(message: string, code: VoiceErrorCode) {
    super(message);
    this.name = 'VoiceInputError';
    this.code = code;
  }
}

/** A recorded audio clip: the raw bytes and their MIME type. */
export interface AudioClip {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/** Records a single audio clip from the device microphone. */
export interface VoiceRecorder {
  record(): Promise<AudioClip>;
}

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode standard base64 to bytes without relying on `atob`, which the Lynx
 * background thread does not provide. Non-alphabet characters (whitespace,
 * padding) are ignored.
 */
export function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let out = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | B64_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

/** One-shot recording result handed back by the host's native recorder. */
export type NativeRecordResult =
  | { base64: string; mimeType?: string }
  | { error: string };

/** The native audio recorder the host platform registers on `NativeModules`. */
export interface NativeAudioRecorderModule {
  recordAudio(callback: (result: NativeRecordResult) => void): void;
}

function mapNativeError(message: string): VoiceInputError {
  const lower = message.toLowerCase();
  if (lower.includes('permission') || lower.includes('denied')) {
    return new VoiceInputError(
      'Microphone access is needed to record. Please enable it in Settings.',
      'permission-denied',
    );
  }
  return new VoiceInputError(
    message || 'Recording failed.',
    'recording-failed',
  );
}

/** Wrap a host native recorder, decoding its base64 payload into an AudioClip. */
export function createNativeRecorder(
  mod: NativeAudioRecorderModule,
): VoiceRecorder {
  return {
    record() {
      return new Promise<AudioClip>((resolve, reject) => {
        mod.recordAudio((result) => {
          if ('error' in result) {
            reject(mapNativeError(result.error));
            return;
          }
          const bytes = decodeBase64(result.base64);
          if (bytes.length === 0) {
            reject(
              new VoiceInputError('No audio was recorded.', 'empty-audio'),
            );
            return;
          }
          resolve({ bytes, mimeType: result.mimeType ?? 'audio/m4a' });
        });
      });
    },
  };
}

function findNativeRecorder(): NativeAudioRecorderModule | null {
  const modules = (globalThis as { NativeModules?: Record<string, unknown> })
    .NativeModules;
  const mod = modules?.AudioRecorderModule as
    | NativeAudioRecorderModule
    | undefined;
  if (mod && typeof mod.recordAudio === 'function') return mod;
  return null;
}

/** A recorder that always fails clearly — used when no native backend exists. */
export function createUnavailableRecorder(): VoiceRecorder {
  return {
    record() {
      return Promise.reject(
        new VoiceInputError(
          'Voice recording is not available on this device.',
          'no-recorder',
        ),
      );
    },
  };
}

function resolveRecorder(): VoiceRecorder {
  const native = findNativeRecorder();
  return native ? createNativeRecorder(native) : createUnavailableRecorder();
}

/** The app-wide recorder: native when the host provides one, else a clear failure. */
export const recorder: VoiceRecorder = resolveRecorder();

/**
 * POST one recorded clip to the transcribe edge function and return the TEXT.
 * Sends the user's JWT (`verify_jwt=true`) plus the publishable `apikey` the
 * Supabase gateway expects. Throws `VoiceInputError` on a non-2xx response or a
 * body without a usable transcript; the audio is never persisted server-side.
 */
export async function transcribe(
  clip: AudioClip,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (clip.bytes.length === 0) {
    throw new VoiceInputError('No audio to transcribe.', 'empty-audio');
  }
  const res = await fetchImpl(TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': clip.mimeType,
    },
    body: new Blob([clip.bytes], { type: clip.mimeType }),
  });

  const body = (await res.json().catch(() => null)) as {
    transcript?: unknown;
    error?: unknown;
  } | null;

  if (!res.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : `Transcription failed (${res.status}).`;
    throw new VoiceInputError(message, 'transcribe-failed');
  }

  const transcript =
    typeof body?.transcript === 'string' ? body.transcript : '';
  if (transcript.trim() === '') {
    throw new VoiceInputError(
      "Sorry, I couldn't make out any speech. Please try again.",
      'transcribe-failed',
    );
  }
  return transcript;
}

/** Options for {@link captureVoice}; defaults use the app-wide recorder + global `fetch`. */
export interface CaptureVoiceOptions {
  /** The signed-in user's access token (`session.accessToken`). */
  accessToken: string;
  /** Override the recorder (tests); defaults to the app-wide native recorder. */
  recorder?: VoiceRecorder;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Record one clip and return its transcript — the single call UI code uses for
 * voice input. Both recording and transcription failures surface as
 * `VoiceInputError` (with a `code` and a displayable message), so callers can
 * show one graceful error path for "no mic / no permission / nothing heard".
 */
export async function captureVoice(opts: CaptureVoiceOptions): Promise<string> {
  const rec = opts.recorder ?? recorder;
  const clip = await rec.record();
  return transcribe(clip, opts.accessToken, opts.fetchImpl);
}
