import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STT_MODEL,
  ELEVENLABS_STT_URL,
  TranscriptionError,
  transcribeAudio,
} from "./transcribe.ts";

// Unit tests for the ElevenLabs Speech-to-Text core (ARC-53). The provider is
// MOCKED via an injected fetch — CI never calls the live ElevenLabs API. They
// assert: the transcript TEXT (+ provenance) is returned, the audio is sent as
// the request body (and so the only thing produced is text), and failures surface
// as a TranscriptionError rather than a silent empty string.

const audioBlob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/m4a" });

describe("transcribeAudio", () => {
  it("returns the transcript text + provenance from a successful response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "I led the billing migration.", language_code: "en" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await transcribeAudio(audioBlob(), { apiKey: "key", fetchImpl });

    expect(res).toEqual({
      transcript: "I led the billing migration.",
      provider: "elevenlabs",
      languageCode: "en",
    });
    // Calls ElevenLabs STT with the api key + model, sending the audio as form-data.
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ELEVENLABS_STT_URL);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe(DEFAULT_STT_MODEL);
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("throws without calling the provider when the api key is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(transcribeAudio(audioBlob(), { apiKey: "", fetchImpl })).rejects.toBeInstanceOf(
      TranscriptionError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws without calling the provider on empty audio", async () => {
    const fetchImpl = vi.fn();
    await expect(
      transcribeAudio(new Blob([]), { apiKey: "key", fetchImpl }),
    ).rejects.toBeInstanceOf(TranscriptionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a TranscriptionError carrying the status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(transcribeAudio(audioBlob(), { apiKey: "key", fetchImpl })).rejects.toMatchObject({
      name: "TranscriptionError",
      status: 401,
    });
  });

  it("throws when the provider returns no transcript text", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ language_code: "en" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(transcribeAudio(audioBlob(), { apiKey: "key", fetchImpl })).rejects.toBeInstanceOf(
      TranscriptionError,
    );
  });
});
