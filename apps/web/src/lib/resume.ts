/**
 * The résumé path of onboarding: validate a chosen PDF/DOCX → upload it to the
 * private `resumes` Storage bucket → start the ingest run (ported from
 * `apps/mobile/src/lib/resume.ts`, web-idiomatic).
 *
 * The flow:
 *  1. The dropzone UI (ARC-101) hands us a browser `File`; `fileToPicked` reads
 *     its bytes. (The native file picker shim the mobile client used has no web
 *     equivalent — the browser file input is the picker.)
 *  2. We validate type + size CLIENT-SIDE before any upload (the bucket enforces
 *     the same limits server-side; this gives the user an instant, friendly no).
 *  3. We upload to `resumes/{uid}/{filename}` via the Storage REST endpoint with
 *     the user's JWT — owner-folder RLS authorizes the write.
 *  4. We hand the object path to `POST /onboarding/resume` as `storageRef`, which
 *     starts the streamed 3-phase ingest run and returns its `threadId`/`runId`.
 *
 * File bytes go to Storage, never through the API. The network seams are
 * injectable so the suite runs fully offline.
 */

import { apiPost } from "#/lib/api.ts";
import type { Session } from "#/lib/auth.ts";
import { getSupabasePublishableKey, getSupabaseUrl } from "#/lib/supabase.ts";

/** The private bucket résumés live in. */
export const RESUMES_BUCKET = "resumes";
/** Byte cap — matches the bucket's `file_size_limit` (10 MiB). */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The MIME types the bucket accepts, keyed by file extension. */
const ALLOWED_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Why a résumé upload failed, for callers that want to branch on the cause. */
export type ResumeErrorCode =
	| "unsupported-type" // not a PDF or DOCX
	| "too-large" // over MAX_RESUME_BYTES
	| "empty-file" // the chosen file had no bytes
	| "upload-failed" // the Storage upload returned a non-2xx
	| "ingest-failed"; // POST /onboarding/resume failed to start the run

/** A résumé-upload failure carrying a message safe to show in the UI. */
export class ResumeUploadError extends Error {
	readonly code: ResumeErrorCode;

	constructor(message: string, code: ResumeErrorCode) {
		super(message);
		this.name = "ResumeUploadError";
		this.code = code;
	}
}

/** A file chosen from the device: its raw bytes, original name, and MIME type. */
export interface PickedFile {
	bytes: Uint8Array<ArrayBuffer>;
	filename: string;
	mimeType: string;
}

/** Read a browser `File` (from the dropzone) into a {@link PickedFile}. */
export async function fileToPicked(file: File): Promise<PickedFile> {
	const buffer = await file.arrayBuffer();
	return {
		bytes: new Uint8Array(buffer),
		filename: file.name,
		mimeType: file.type || "application/octet-stream",
	};
}

/** The file extension (lowercased, no dot) for a filename, or `''` if none. */
function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Validate a picked file against the bucket's contract (PDF/DOCX, ≤10 MiB) and
 * return the canonical MIME type to upload with — derived from the extension so a
 * file reported as `application/octet-stream` still satisfies the bucket's
 * `allowed_mime_types`. Throws {@link ResumeUploadError} when the file is rejected.
 */
export function validateResume(file: PickedFile): string {
	if (file.bytes.length === 0) {
		throw new ResumeUploadError("That file looks empty.", "empty-file");
	}
	if (file.bytes.length > MAX_RESUME_BYTES) {
		throw new ResumeUploadError(
			"That file is too large — résumés must be 10 MB or smaller.",
			"too-large",
		);
	}
	const contentType = ALLOWED_TYPES[extensionOf(file.filename)];
	if (!contentType) {
		throw new ResumeUploadError(
			"Please choose a PDF or Word (.docx) file.",
			"unsupported-type",
		);
	}
	return contentType;
}

/** Sanitize a filename to a safe Storage object name, preserving the extension. */
function safeObjectName(filename: string): string {
	const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "");
	return cleaned === "" ? "resume" : cleaned;
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
	const url = `${getSupabaseUrl()}/storage/v1/object/${storageRef}`;
	const res = await fetchImpl(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.accessToken}`,
			apikey: getSupabasePublishableKey(),
			"Content-Type": contentType,
			"x-upsert": "true",
		},
		body: new Blob([file.bytes], { type: contentType }),
	});
	if (!res.ok) {
		throw new ResumeUploadError(
			`Couldn't upload your résumé (${res.status}). Please try again.`,
			"upload-failed",
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
			"/onboarding/resume",
			args.session.accessToken,
			{
				threadId: args.threadId,
				storageRef: args.storageRef,
				filename: args.filename,
				kind: "resume",
			},
		);
		return { threadId: resp.threadId, runId: resp.runId };
	} catch {
		throw new ResumeUploadError(
			"Couldn't start processing your résumé. Please try again.",
			"ingest-failed",
		);
	}
}

/** Injectable seams for {@link uploadResumeAndStartIngest}. */
export interface ResumeFlowDeps {
	resolveThreadId(session: Session): Promise<string>;
	upload?: typeof uploadResume;
	startIngest?: typeof startResumeIngest;
}

/**
 * The whole résumé path from a chosen browser `File` as one call the screen
 * awaits: read → validate → upload → start ingest, returning the run's
 * `threadId`/`runId`. Every failure surfaces as a {@link ResumeUploadError} with
 * a `code` and a displayable message, so the screen shows one graceful error path.
 */
export async function uploadResumeAndStartIngest(
	session: Session,
	file: File,
	deps: ResumeFlowDeps,
): Promise<IngestStarted> {
	const upload = deps.upload ?? uploadResume;
	const startIngest = deps.startIngest ?? startResumeIngest;

	const picked = await fileToPicked(file);
	const contentType = validateResume(picked);
	const threadId = await deps.resolveThreadId(session);
	const storageRef = await upload(picked, contentType, session);
	return startIngest({
		session,
		threadId,
		storageRef,
		filename: picked.filename,
	});
}
