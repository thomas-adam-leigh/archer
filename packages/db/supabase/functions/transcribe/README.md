# `transcribe` edge function (ARC-53)

Real speech-to-text for Archer's voice-first input. Receives recorded audio,
calls **ElevenLabs Speech-to-Text (Scribe)**, and returns the transcript **text
only**. The **audio is never persisted** — not to Supabase Storage, not the
database, not disk. Bytes live only in memory for the duration of the ElevenLabs
call; only the text leaves the function.

## Request

`POST /functions/v1/transcribe` (requires a Supabase user JWT — `verify_jwt = true`).

- **multipart/form-data** with a `file` (or `audio`) part, or
- a **raw audio body** (the `Content-Type` is forwarded as the blob type).

## Response

```json
{ "transcript": "…", "provider": "elevenlabs", "languageCode": "en" }
```

Errors: `503` (key not configured), `400` (no audio), `502` (provider failure).

## End-to-end voice flow

```
client records → POST audio here → { transcript } → client submits the TEXT to the API:
  • /agui/run               (voice as conversational input)
  • /onboarding/voicenote   (voice as a tier-2 note; backend stores text only)
```

The backend only ever sees text. This supersedes the old `storageRef`-based
voicenote stub (`services/api/src/stt.ts`), which transcribed from an uploaded
audio reference — the new design transcribes at the edge and stores nothing.

## Secret

`ELEVENLABS_API_KEY` — provisioned in Supabase secrets (`supabase secrets set`).
Never hardcoded; read from the function's env.

## Layout & tests

- `transcribe.ts` — the Web-standard, `fetch`-injectable provider call. Unit
  tested under vitest with ElevenLabs **mocked** (`transcribe.test.ts`); CI never
  calls the live API.
- `index.ts` — the Deno runtime entry (`Deno.serve` / `Deno.env`). Not imported
  by the test suite.

Deployed on merge to `main` by `.github/workflows/release.yml`
(`supabase functions deploy transcribe`), mirroring migrations-on-merge.
