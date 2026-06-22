import { describe, expect, test, vi } from 'vitest';

import {
  type AudioClip,
  captureVoice,
  createNativeRecorder,
  createUnavailableRecorder,
  decodeBase64,
  type NativeAudioRecorderModule,
  TRANSCRIBE_URL,
  transcribe,
  VoiceInputError,
  type VoiceRecorder,
} from './voice.js';

vi.mock('./supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const clip: AudioClip = {
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/m4a',
};

describe('decodeBase64', () => {
  test('decodes base64 to the original bytes', () => {
    // "hi" → [104, 105]
    expect(Array.from(decodeBase64('aGk='))).toEqual([104, 105]);
  });

  test('ignores whitespace and padding', () => {
    expect(Array.from(decodeBase64('aG k=\n'))).toEqual([104, 105]);
  });

  test('empty input yields no bytes', () => {
    expect(decodeBase64('').length).toBe(0);
  });
});

describe('transcribe', () => {
  test('returns the transcript and sends auth + apikey + bytes', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ transcript: 'hello world' }),
    );

    const text = await transcribe(
      clip,
      'jwt-123',
      fetchImpl as unknown as typeof fetch,
    );

    expect(text).toBe('hello world');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(TRANSCRIBE_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-123');
    expect(headers.apikey).toBeTruthy();
    expect(headers['Content-Type']).toBe('audio/m4a');
    const body = init.body as Blob;
    expect(body).toBeInstanceOf(Blob);
    expect(body.type).toBe('audio/m4a');
    expect(body.size).toBe(clip.bytes.length);
  });

  test('maps a non-2xx response to the server error message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'STT not configured' }, 503),
    );

    await expect(
      transcribe(clip, 'jwt', fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({
      code: 'transcribe-failed',
      message: 'STT not configured',
    });
  });

  test('an empty transcript is a graceful failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ transcript: '   ' }));

    await expect(
      transcribe(clip, 'jwt', fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'transcribe-failed' });
  });

  test('rejects empty audio without calling the network', async () => {
    const fetchImpl = vi.fn();

    await expect(
      transcribe(
        { bytes: new Uint8Array(), mimeType: 'audio/m4a' },
        'jwt',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'empty-audio' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createNativeRecorder', () => {
  function fakeModule(
    result: Parameters<
      Parameters<NativeAudioRecorderModule['recordAudio']>[0]
    >[0],
  ): NativeAudioRecorderModule {
    return { recordAudio: vi.fn((cb) => cb(result)) };
  }

  test('decodes the native base64 payload into an AudioClip', async () => {
    const rec = createNativeRecorder(
      fakeModule({ base64: 'aGk=', mimeType: 'audio/wav' }),
    );
    const out = await rec.record();
    expect(Array.from(out.bytes)).toEqual([104, 105]);
    expect(out.mimeType).toBe('audio/wav');
  });

  test('defaults the mime type when the host omits it', async () => {
    const rec = createNativeRecorder(fakeModule({ base64: 'aGk=' }));
    expect((await rec.record()).mimeType).toBe('audio/m4a');
  });

  test('a permission error maps to permission-denied', async () => {
    const rec = createNativeRecorder(
      fakeModule({ error: 'microphone permission denied' }),
    );
    await expect(rec.record()).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  test('a generic error maps to recording-failed', async () => {
    const rec = createNativeRecorder(fakeModule({ error: 'recorder busy' }));
    await expect(rec.record()).rejects.toMatchObject({
      code: 'recording-failed',
      message: 'recorder busy',
    });
  });

  test('empty audio surfaces as empty-audio', async () => {
    const rec = createNativeRecorder(fakeModule({ base64: '' }));
    await expect(rec.record()).rejects.toMatchObject({ code: 'empty-audio' });
  });
});

describe('createUnavailableRecorder', () => {
  test('rejects with no-recorder when no native backend exists', async () => {
    await expect(createUnavailableRecorder().record()).rejects.toMatchObject({
      code: 'no-recorder',
    });
  });
});

describe('captureVoice', () => {
  test('records then transcribes, returning the text', async () => {
    const recorder: VoiceRecorder = { record: vi.fn(async () => clip) };
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ transcript: 'spoken feedback' }),
    );

    const text = await captureVoice({
      accessToken: 'jwt',
      recorder,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(text).toBe('spoken feedback');
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  test('a recording failure propagates without transcribing', async () => {
    const recorder: VoiceRecorder = {
      record: vi.fn(async () => {
        throw new VoiceInputError(
          'Voice recording is not available on this device.',
          'no-recorder',
        );
      }),
    };
    const fetchImpl = vi.fn();

    await expect(
      captureVoice({
        accessToken: 'jwt',
        recorder,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'no-recorder' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
