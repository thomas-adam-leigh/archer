import { describe, expect, test, vi } from "vitest";
import {
	type AudioClip,
	createBrowserRecorder,
	isVoiceRecordingSupported,
	transcribe,
	VoiceInputError,
} from "#/lib/voice.ts";

const clip: AudioClip = {
	bytes: new Uint8Array([1, 2, 3]),
	mimeType: "audio/webm",
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

describe("transcribe", () => {
	test("posts the clip to the edge function and returns the transcript", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ transcript: "hello there" }));

		const text = await transcribe(clip, "access-1", fetchImpl);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://supabase.test/functions/v1/transcribe");
		expect(init.headers.Authorization).toBe("Bearer access-1");
		expect(text).toBe("hello there");
	});

	test("rejects an empty clip before any request", async () => {
		const fetchImpl = vi.fn();

		await expect(
			transcribe({ bytes: new Uint8Array(), mimeType: "audio/webm" }, "t"),
		).rejects.toBeInstanceOf(VoiceInputError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("throws when the response carries no usable transcript", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ transcript: "   " }));

		await expect(transcribe(clip, "access-1", fetchImpl)).rejects.toMatchObject(
			{
				code: "transcribe-failed",
			},
		);
	});
});

/** A fake `MediaStream` whose track records whether it was stopped. */
function fakeStream() {
	const track = { stop: vi.fn() };
	const stream = { getTracks: () => [track] } as unknown as MediaStream;
	return { stream, track };
}

/**
 * A minimal `MediaRecorder` stand-in: tests drive `emit()` to feed audio chunks
 * before calling the recorder's `stop()`, which fires the `stop` event.
 */
class FakeMediaRecorder {
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	state = "inactive";
	readonly mimeType = "audio/webm";
	constructor(public stream: MediaStream) {}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.onstop?.();
	}
	emit(bytes: number[]) {
		this.ondataavailable?.({
			data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }),
		});
	}
}

/** A constructable `MediaRecorder` stand-in that records each instance it builds. */
function fakeRecorderClass() {
	const instances: FakeMediaRecorder[] = [];
	class Impl extends FakeMediaRecorder {
		constructor(stream: MediaStream) {
			super(stream);
			instances.push(this);
		}
	}
	return { Impl: Impl as unknown as typeof MediaRecorder, instances };
}

describe("createBrowserRecorder", () => {
	test("records a clip and releases the microphone on stop", async () => {
		const { stream, track } = fakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);
		const { Impl, instances } = fakeRecorderClass();

		const rec = createBrowserRecorder({
			getUserMedia,
			MediaRecorderImpl: Impl,
		});
		await rec.start();
		instances[0].emit([1, 2, 3, 4]);
		const clip = await rec.stop();

		expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
		expect(clip.mimeType).toBe("audio/webm");
		expect(clip.bytes.length).toBe(4);
		expect(track.stop).toHaveBeenCalled();
	});

	test("maps a declined permission to a permission-denied error", async () => {
		const getUserMedia = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("denied"), { name: "NotAllowedError" }),
			);

		const rec = createBrowserRecorder({
			getUserMedia,
			MediaRecorderImpl: vi.fn() as unknown as typeof MediaRecorder,
		});

		await expect(rec.start()).rejects.toMatchObject({
			code: "permission-denied",
		});
	});

	test("maps any other capture failure to recording-failed", async () => {
		const getUserMedia = vi.fn().mockRejectedValue(new Error("no device"));
		const rec = createBrowserRecorder({
			getUserMedia,
			MediaRecorderImpl: vi.fn() as unknown as typeof MediaRecorder,
		});

		await expect(rec.start()).rejects.toMatchObject({
			code: "recording-failed",
		});
	});

	test("rejects with empty-audio when no bytes were captured", async () => {
		const { stream } = fakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);
		const { Impl } = fakeRecorderClass();

		const rec = createBrowserRecorder({
			getUserMedia,
			MediaRecorderImpl: Impl,
		});
		await rec.start();
		const stopped = rec.stop(); // no emit() → no chunks

		await expect(stopped).rejects.toMatchObject({ code: "empty-audio" });
	});

	test("cancel releases the microphone without producing a clip", async () => {
		const { stream, track } = fakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);
		const { Impl } = fakeRecorderClass();

		const rec = createBrowserRecorder({
			getUserMedia,
			MediaRecorderImpl: Impl,
		});
		await rec.start();
		rec.cancel();

		expect(track.stop).toHaveBeenCalled();
	});
});

describe("isVoiceRecordingSupported", () => {
	test("true when getUserMedia and MediaRecorder are present", () => {
		const nav = {
			mediaDevices: { getUserMedia: () => Promise.resolve() },
		} as unknown as Navigator;
		expect(
			isVoiceRecordingSupported(
				nav,
				class {} as unknown as typeof MediaRecorder,
			),
		).toBe(true);
	});

	test("false when the browser lacks recording APIs", () => {
		expect(isVoiceRecordingSupported(undefined, undefined)).toBe(false);
		expect(
			isVoiceRecordingSupported(
				{} as Navigator,
				class {} as unknown as typeof MediaRecorder,
			),
		).toBe(false);
	});
});
