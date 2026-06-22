import { describe, expect, test, vi } from 'vitest';

// Stub the API config so importing the module (→ api.js → config.js) and the
// Supabase config don't require the client env. Network seams are injected below.
vi.mock('./config.js', () => ({ ARCHER_API_URL: 'https://api.test' }));
vi.mock('./supabase.js', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}));

import type { Session } from './auth.js';
import {
  createNativePicker,
  createUnavailablePicker,
  type FilePicker,
  type NativeFilePickerModule,
  type PickedFile,
  RESUMES_BUCKET,
  ResumeUploadError,
  startResumeIngest,
  uploadResume,
  uploadResumeAndStartIngest,
  validateResume,
} from './resume.js';

const session: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'user-1', email: 'a@b.com' },
};

const pdf: PickedFile = {
  bytes: new Uint8Array([1, 2, 3]),
  filename: 'cv.pdf',
  mimeType: 'application/pdf',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('validateResume', () => {
  test('accepts a PDF and returns its canonical MIME', () => {
    expect(validateResume(pdf)).toBe('application/pdf');
  });

  test('accepts a DOCX even when the picker reports octet-stream', () => {
    expect(
      validateResume({
        ...pdf,
        filename: 'resume.DOCX',
        mimeType: 'application/octet-stream',
      }),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  test('rejects an unsupported type', () => {
    expect(() => validateResume({ ...pdf, filename: 'photo.png' })).toThrow(
      ResumeUploadError,
    );
  });

  test('rejects an empty file', () => {
    expect(() => validateResume({ ...pdf, bytes: new Uint8Array([]) })).toThrow(
      ResumeUploadError,
    );
  });

  test('rejects a file over 10 MiB', () => {
    const big = { ...pdf, bytes: new Uint8Array(10 * 1024 * 1024 + 1) };
    try {
      validateResume(big);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResumeUploadError);
      expect((err as ResumeUploadError).code).toBe('too-large');
    }
  });
});

describe('createNativePicker', () => {
  test('decodes the base64 payload into a PickedFile', async () => {
    const mod: NativeFilePickerModule = {
      // "hi" → aGk=
      pickFile: (cb) =>
        cb({ base64: 'aGk=', filename: 'cv.pdf', mimeType: 'application/pdf' }),
    };
    const file = await createNativePicker(mod).pick();
    expect(Array.from(file.bytes)).toEqual([104, 105]);
    expect(file.filename).toBe('cv.pdf');
  });

  test('maps a cancellation to a cancelled error', async () => {
    const mod: NativeFilePickerModule = {
      pickFile: (cb) => cb({ cancelled: true }),
    };
    await expect(createNativePicker(mod).pick()).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  test('maps a picker error to a pick-failed error', async () => {
    const mod: NativeFilePickerModule = {
      pickFile: (cb) => cb({ error: 'boom' }),
    };
    await expect(createNativePicker(mod).pick()).rejects.toMatchObject({
      code: 'pick-failed',
    });
  });
});

describe('createUnavailablePicker', () => {
  test('always fails with no-picker', async () => {
    await expect(createUnavailablePicker().pick()).rejects.toMatchObject({
      code: 'no-picker',
    });
  });
});

describe('uploadResume', () => {
  test('PUTs to the owner-scoped object path and returns the storageRef', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ Key: 'resumes/user-1/cv.pdf' }),
    );

    const ref = await uploadResume(
      pdf,
      'application/pdf',
      session,
      fetchImpl as unknown as typeof fetch,
    );

    expect(ref).toBe(`${RESUMES_BUCKET}/user-1/cv.pdf`);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://example.supabase.co/storage/v1/object/resumes/user-1/cv.pdf',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers.apikey).toBe('sb_publishable_test');
    expect(headers['Content-Type']).toBe('application/pdf');
  });

  test('sanitizes an unsafe filename into the object path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const ref = await uploadResume(
      { ...pdf, filename: 'my résumé (final).pdf' },
      'application/pdf',
      session,
      fetchImpl as unknown as typeof fetch,
    );
    // Non [A-Za-z0-9._-] chars → '_'; the .pdf extension is preserved.
    expect(ref).toBe('resumes/user-1/my_r_sum___final_.pdf');
    expect(ref).toMatch(/^resumes\/user-1\/[A-Za-z0-9._-]+$/);
  });

  test('throws upload-failed on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no' }, 400));
    await expect(
      uploadResume(
        pdf,
        'application/pdf',
        session,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'upload-failed' });
  });
});

describe('startResumeIngest', () => {
  test('posts the ingest request and returns threadId/runId', async () => {
    const post = vi.fn().mockResolvedValue({ threadId: 't-1', runId: 'r-1' });

    const result = await startResumeIngest(
      {
        session,
        threadId: 't-1',
        storageRef: 'resumes/user-1/cv.pdf',
        filename: 'cv.pdf',
      },
      post,
    );

    expect(result).toEqual({ threadId: 't-1', runId: 'r-1' });
    expect(post).toHaveBeenCalledWith('/onboarding/resume', 'access-1', {
      threadId: 't-1',
      storageRef: 'resumes/user-1/cv.pdf',
      filename: 'cv.pdf',
      kind: 'resume',
    });
  });

  test('wraps a failure as ingest-failed', async () => {
    const post = vi.fn().mockRejectedValue(new Error('500'));
    await expect(
      startResumeIngest(
        { session, threadId: 't-1', storageRef: 'r', filename: 'cv.pdf' },
        post,
      ),
    ).rejects.toMatchObject({ code: 'ingest-failed' });
  });
});

describe('uploadResumeAndStartIngest', () => {
  test('runs pick → validate → upload → ingest in order', async () => {
    const calls: string[] = [];
    const pick: FilePicker = {
      pick: async () => {
        calls.push('pick');
        return pdf;
      },
    };
    const upload = vi.fn(async () => {
      calls.push('upload');
      return 'resumes/user-1/cv.pdf';
    });
    const startIngest = vi.fn(async () => {
      calls.push('ingest');
      return { threadId: 't-1', runId: 'r-1' };
    });
    const resolveThreadId = vi.fn(async () => {
      calls.push('thread');
      return 't-1';
    });

    const result = await uploadResumeAndStartIngest(session, {
      picker: pick,
      resolveThreadId,
      upload: upload as unknown as typeof uploadResume,
      startIngest: startIngest as unknown as typeof startResumeIngest,
    });

    expect(result).toEqual({ threadId: 't-1', runId: 'r-1' });
    expect(calls).toEqual(['pick', 'thread', 'upload', 'ingest']);
    expect(upload).toHaveBeenCalledWith(pdf, 'application/pdf', session);
    expect(startIngest).toHaveBeenCalledWith({
      session,
      threadId: 't-1',
      storageRef: 'resumes/user-1/cv.pdf',
      filename: 'cv.pdf',
    });
  });

  test('a validation failure stops before any upload', async () => {
    const upload = vi.fn();
    const startIngest = vi.fn();
    await expect(
      uploadResumeAndStartIngest(session, {
        picker: { pick: async () => ({ ...pdf, filename: 'x.txt' }) },
        resolveThreadId: async () => 't-1',
        upload: upload as unknown as typeof uploadResume,
        startIngest: startIngest as unknown as typeof startResumeIngest,
      }),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(upload).not.toHaveBeenCalled();
    expect(startIngest).not.toHaveBeenCalled();
  });
});
