import { describe, expect, test, vi } from "vitest";
import { type AudioClip, transcribe, VoiceInputError } from "#/lib/voice.ts";

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
