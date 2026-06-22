/**
 * The résumé path of onboarding: pick a PDF/DOCX → upload it to the private
 * `resumes` Storage bucket → start the ingest run (ARC-74).
 *
 * The flow:
 *  1. The host's native file picker returns the chosen file's bytes + name.
 *  2. We validate type + size CLIENT-SIDE before any upload (the bucket enforces
 *     the same limits server-side; this gives the user an instant, friendly no).
 *  3. We upload to `resumes/{uid}/{filename}` via the Storage REST endpoint with
 *     the user's JWT — owner-folder RLS authorizes the write (ARC-62).
 *  4. We hand the object path to `POST /onboarding/resume` as `storageRef`, which
 *     starts the streamed 3-phase ingest run and returns its `threadId`/`runId`
 *     for the processing screen to subscribe to (ARC-75).
 *
 * File bytes go to Storage, never through the API. Following `voice.ts`, recording
 * here is a host-provided native module wrapped in a Promise API, with a clear
 * displayable failure when the host hasn't registered one; both the picker and the
 * network seams are injectable so the suite runs fully offline.
 */

import { apiPost } from './api.js';
import type { Session } from './auth.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase.js';
import { decodeBase64 } from './voice.js';

/** The private bucket résumés live in (provisioned in ARC-62). */
export const RESUMES_BUCKET = 'resumes';
/** Byte cap — matches the bucket's `file_size_limit` (10 MiB). */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The MIME types the bucket accepts, keyed by file extension. */
const ALLOWED_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Why a résumé upload failed, for callers that want to branch on the cause. */
export type ResumeErrorCode =
  | 'no-picker' // no native file picker is registered on this host
  | 'cancelled' // the user dismissed the picker without choosing a file
  | 'pick-failed' // the picker itself failed
  | 'unsupported-type' // not a PDF or DOCX
  | 'too-large' // over MAX_RESUME_BYTES
  | 'empty-file' // the chosen file had no bytes
  | 'upload-failed' // the Storage upload returned a non-2xx
  | 'ingest-failed'; // POST /onboarding/resume failed to start the run

/** A résumé-upload failure carrying a message safe to show in the UI. */
export class ResumeUploadError extends Error {
  readonly code: ResumeErrorCode;

  constructor(message: string, code: ResumeErrorCode) {
    super(message);
    this.name = 'ResumeUploadError';
    this.code = code;
  }
}

/** A file chosen from the device: its raw bytes, original name, and MIME type. */
export interface PickedFile {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
}

/** Picks a single document (PDF/DOCX) from the device. */
export interface FilePicker {
  pick(): Promise<PickedFile>;
}

/** One-shot pick result handed back by the host's native picker. */
export type NativePickResult =
  | { base64: string; filename: string; mimeType?: string }
  | { cancelled: true }
  | { error: string };

/** The native file picker the host platform registers on `NativeModules`. */
export interface NativeFilePickerModule {
  pickFile(callback: (result: NativePickResult) => void): void;
}

/** Wrap a host native picker, decoding its base64 payload into a PickedFile. */
export function createNativePicker(mod: NativeFilePickerModule): FilePicker {
  return {
    pick() {
      return new Promise<PickedFile>((resolve, reject) => {
        mod.pickFile((result) => {
          if ('cancelled' in result) {
            reject(new ResumeUploadError('No file chosen.', 'cancelled'));
            return;
          }
          if ('error' in result) {
            reject(
              new ResumeUploadError(
                result.error || "Couldn't open the file picker.",
                'pick-failed',
              ),
            );
            return;
          }
          const bytes = decodeBase64(result.base64);
          resolve({
            bytes,
            filename: result.filename,
            mimeType: result.mimeType ?? 'application/octet-stream',
          });
        });
      });
    },
  };
}

function findNativePicker(): NativeFilePickerModule | null {
  const modules = (globalThis as { NativeModules?: Record<string, unknown> })
    .NativeModules;
  const mod = modules?.FilePickerModule as NativeFilePickerModule | undefined;
  if (mod && typeof mod.pickFile === 'function') return mod;
  return null;
}

/** A picker that always fails clearly — used when no native backend exists. */
export function createUnavailablePicker(): FilePicker {
  return {
    pick() {
      return Promise.reject(
        new ResumeUploadError(
          'Choosing a file is not available on this device.',
          'no-picker',
        ),
      );
    },
  };
}

function resolvePicker(): FilePicker {
  const native = findNativePicker();
  return native ? createNativePicker(native) : createUnavailablePicker();
}

/** The app-wide file picker: native when the host provides one, else a clear failure. */
export const picker: FilePicker = resolvePicker();

/** The file extension (lowercased, no dot) for a filename, or `''` if none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Validate a picked file against the bucket's contract (PDF/DOCX, ≤10 MiB) and
 * return the canonical MIME type to upload with — derived from the extension so a
 * picker that reports `application/octet-stream` still satisfies the bucket's
 * `allowed_mime_types`. Throws {@link ResumeUploadError} when the file is rejected.
 */
export function validateResume(file: PickedFile): string {
  if (file.bytes.length === 0) {
    throw new ResumeUploadError('That file looks empty.', 'empty-file');
  }
  if (file.bytes.length > MAX_RESUME_BYTES) {
    throw new ResumeUploadError(
      'That file is too large — résumés must be 10 MB or smaller.',
      'too-large',
    );
  }
  const contentType = ALLOWED_TYPES[extensionOf(file.filename)];
  if (!contentType) {
    throw new ResumeUploadError(
      'Please choose a PDF or Word (.docx) file.',
      'unsupported-type',
    );
  }
  return contentType;
}

/** Sanitize a filename to a safe Storage object name, preserving the extension. */
function safeObjectName(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '');
  return cleaned === '' ? 'resume' : cleaned;
}

/**
 * Upload a validated file to `resumes/{uid}/{filename}` and return the object path
 * (`storageRef`) for the ingest call. Uses the Storage REST endpoint with the
 * user's JWT; `x-upsert` lets a user re-upload over a previous attempt. Throws
 * {@link ResumeUploadError} on a non-2xx response.
 */
export async function uploadResume(
  file: PickedFile,
  contentType: string,
  session: Session,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const objectPath = `${session.user.id}/${safeObjectName(file.filename)}`;
  const storageRef = `${RESUMES_BUCKET}/${objectPath}`;
  const url = `${SUPABASE_URL}/storage/v1/object/${storageRef}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: new Blob([file.bytes], { type: contentType }),
  });
  if (!res.ok) {
    throw new ResumeUploadError(
      `Couldn't upload your résumé (${res.status}). Please try again.`,
      'upload-failed',
    );
  }
  return storageRef;
}

/** The `POST /onboarding/resume` response the processing screen needs. */
export interface IngestStarted {
  threadId: string;
  runId: string;
}

/** Start the streamed ingest run for an uploaded file. */
export async function startResumeIngest(
  args: {
    session: Session;
    threadId: string;
    storageRef: string;
    filename: string;
  },
  post = apiPost,
): Promise<IngestStarted> {
  try {
    const resp = await post<{ threadId: string; runId: string }>(
      '/onboarding/resume',
      args.session.accessToken,
      {
        threadId: args.threadId,
        storageRef: args.storageRef,
        filename: args.filename,
        kind: 'resume',
      },
    );
    return { threadId: resp.threadId, runId: resp.runId };
  } catch {
    throw new ResumeUploadError(
      "Couldn't start processing your résumé. Please try again.",
      'ingest-failed',
    );
  }
}

/** Injectable seams for {@link uploadResumeAndStartIngest} (defaults bind the app-wide impls). */
export interface ResumeFlowDeps {
  picker?: FilePicker;
  resolveThreadId(session: Session): Promise<string>;
  upload?: typeof uploadResume;
  startIngest?: typeof startResumeIngest;
}

/**
 * The whole résumé path as one call the screen awaits: pick → validate → upload →
 * start ingest, returning the run's `threadId`/`runId`. Every failure surfaces as a
 * `ResumeUploadError` with a `code` and a displayable message, so the screen shows
 * one graceful error path (cancel is just `code: 'cancelled'`).
 */
export async function uploadResumeAndStartIngest(
  session: Session,
  deps: ResumeFlowDeps,
): Promise<IngestStarted> {
  const pick = deps.picker ?? picker;
  const upload = deps.upload ?? uploadResume;
  const startIngest = deps.startIngest ?? startResumeIngest;

  const file = await pick.pick();
  const contentType = validateResume(file);
  const threadId = await deps.resolveThreadId(session);
  const storageRef = await upload(file, contentType, session);
  return startIngest({
    session,
    threadId,
    storageRef,
    filename: file.filename,
  });
}
