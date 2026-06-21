// Supabase Edge Function: transcribe (ARC-53) — real speech-to-text.
//
// Archer's voice-first input. The client records audio and POSTs the bytes here;
// this function calls ElevenLabs Speech-to-Text (Scribe) and returns the
// transcript TEXT only. The audio is NEVER persisted — not to Supabase Storage,
// not to the database, not to disk. Bytes live only in memory for the duration
// of the ElevenLabs call; only the text leaves this function.
//
// End-to-end voice flow:
//   client records → POST audio here → { transcript } → client submits the TEXT
//   to the API: `/agui/run` for conversation, or `/onboarding/voicenote` for a
//   tier-2 note. The backend therefore only ever sees text (ARC-53 DoD).
//
// Auth: verify_jwt = true (config.toml) — only an authenticated Supabase user
// may transcribe, so the ElevenLabs key cannot be abused anonymously.
//
// Secret: ELEVENLABS_API_KEY (provisioned in Supabase secrets).
//
// This module uses Deno globals (Deno.serve / Deno.env) and is the runtime entry
// ONLY — it is deliberately not imported by the vitest suite. The testable call
// logic lives in ./transcribe.ts (Web-standard, fetch-injectable).

import { TranscriptionError, transcribeAudio } from "./transcribe.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
  if (!apiKey) return json({ error: "STT not configured" }, 503);

  // Accept either a multipart upload (field `file` or `audio`) or a raw audio
  // request body. Bytes are held in memory only; nothing is written anywhere.
  let audio: Blob | null = null;
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("file") ?? form.get("audio");
      if (f instanceof File) audio = f;
    } else {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 0) {
        audio = new Blob([buf], { type: contentType || "application/octet-stream" });
      }
    }
  } catch {
    return json({ error: "could not read audio" }, 400);
  }
  if (!audio || audio.size === 0) return json({ error: "no audio provided" }, 400);

  try {
    const { transcript, provider, languageCode } = await transcribeAudio(audio, { apiKey });
    // Text only — the audio blob is now out of scope and was never persisted.
    return json({ transcript, provider, languageCode });
  } catch (err) {
    const message = err instanceof TranscriptionError ? err.message : "transcription failed";
    return json({ error: message }, 502);
  }
});
