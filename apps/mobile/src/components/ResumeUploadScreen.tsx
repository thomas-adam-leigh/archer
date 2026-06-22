import { useCallback, useState } from '@lynx-js/react';

import type { Session } from '../lib/auth.js';
import {
  type IngestStarted,
  ResumeUploadError,
  uploadResumeAndStartIngest,
} from '../lib/resume.js';
import { fetchPrimaryThreadId } from '../lib/threads.js';

/**
 * The résumé path (ARC-74): choose a PDF/DOCX, upload it to the private `resumes`
 * bucket, and start the streamed ingest run. On success it hands the run's
 * `threadId`/`runId` to the processing screen (ARC-75) via `onIngestStarted`.
 *
 * A cancelled picker is a no-op (the user simply didn't choose a file); every
 * other failure shows one friendly message with a retry, since the underlying
 * `ResumeUploadError` already carries displayable copy.
 */
export function ResumeUploadScreen(props: {
  session: Session;
  onIngestStarted: (started: IngestStarted) => void;
  onBack: () => void;
}) {
  const { session, onIngestStarted, onBack } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(() => {
    if (busy) return;
    setError(null);
    setBusy(true);
    uploadResumeAndStartIngest(session, {
      resolveThreadId: (s) => fetchPrimaryThreadId(s),
    })
      .then(onIngestStarted)
      .catch((err: unknown) => {
        // A cancelled pick isn't an error — just let the user try again.
        if (err instanceof ResumeUploadError && err.code === 'cancelled')
          return;
        setError(
          err instanceof ResumeUploadError
            ? err.message
            : 'Something went wrong. Please try again.',
        );
      })
      .finally(() => setBusy(false));
  }, [busy, session, onIngestStarted]);

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">Upload your résumé</text>
        <text className="Auth__subtitle">
          Choose a PDF or Word (.docx) file. Archer will read it and build your
          profile — your file stays private to you.
        </text>

        {error ? <text className="Auth__error">{error}</text> : null}

        <view
          className={busy ? 'Button Button--busy' : 'Button'}
          bindtap={choose}
        >
          <text className="Button__label">
            {busy ? 'Uploading…' : 'Choose file'}
          </text>
        </view>

        <view className="Auth__switch" bindtap={busy ? undefined : onBack}>
          <text className="Auth__switchText">Back</text>
        </view>
      </view>
    </view>
  );
}
