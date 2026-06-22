import { useCallback, useEffect, useRef, useState } from '@lynx-js/react';

import {
  createThreadSession,
  type ThreadSession,
  type ThreadSessionOptions,
  type ThreadView,
} from '../lib/agui/index.js';
import type { Session } from '../lib/auth.js';
import { finalizeGuidedOnboarding as finalizeGuidedOnboardingDefault } from '../lib/conversation.js';
import { fetchPrimaryThreadId } from '../lib/threads.js';
import {
  captureVoice as captureVoiceDefault,
  VoiceInputError,
} from '../lib/voice.js';
import { StageScreen } from './StageScreen.js';

/** The seams every layer of the screen shares — defaulted to the live impls,
 *  overridable so the whole flow runs offline under test. */
interface ChatDeps {
  createSession?: (opts: ThreadSessionOptions) => ThreadSession;
  finalize?: typeof finalizeGuidedOnboardingDefault;
  captureVoice?: typeof captureVoiceDefault;
}

/**
 * The conversational "start from scratch" onboarding screen (ARC-80).
 *
 * The chat surface for the candidate with no résumé: Archer asks about their work,
 * education, skills and goals over the AG-UI run loop; the candidate answers by
 * text or voice. Each turn drives the shared {@link ThreadSession} (`POST /agui/run`),
 * whose folded view is the live transcript. When the candidate is ready they tap
 * "Build my profile", which finalizes the conversation into a PROPOSED profile
 * version (`POST /onboarding/guided`) and hands off to the SAME profile review
 * screen the résumé path lands on (Milestone 5) — converging the two paths.
 *
 * This outer component resolves the user's primary thread, then renders the chat
 * against a stable thread id. Every network + voice seam is injectable.
 */
export function ConversationalOnboardingScreen(props: {
  session: Session;
  /** Advance to the shared review once the draft is proposed. */
  onComplete: () => void;
  /** Return to the intro's path choice. */
  onBack?: () => void;
  /** Resolve the thread to chat on; defaults to the user's primary thread. */
  resolveThreadId?: (session: Session) => Promise<string>;
  deps?: ChatDeps;
}) {
  const { session, onComplete, onBack } = props;
  const resolveThreadId = props.resolveThreadId ?? fetchPrimaryThreadId;

  const [threadId, setThreadId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setThreadId(null);
    resolveThreadId(session)
      .then(setThreadId)
      .catch(() => setFailed(true));
  }, [session, resolveThreadId]);

  useEffect(load, [load]);

  if (failed) {
    return (
      <StageScreen
        title="Couldn't start the chat"
        subtitle="We couldn't open your conversation with Archer. Please try again."
        primaryLabel="Try again"
        onPrimary={load}
        secondaryLabel="Back"
        onSecondary={onBack}
      />
    );
  }

  if (!threadId) {
    return (
      <StageScreen
        title="Getting Archer ready…"
        subtitle="Opening your conversation."
      />
    );
  }

  return (
    <Chat
      session={session}
      threadId={threadId}
      onComplete={onComplete}
      onBack={onBack}
      deps={props.deps}
    />
  );
}

/** One rendered turn in the transcript. */
function Bubble(props: { from: string; content: string }) {
  const mine = props.from === 'user';
  return (
    <view className={`Chat__bubble Chat__bubble--${mine ? 'user' : 'archer'}`}>
      <text className="Chat__bubbleText">{props.content}</text>
    </view>
  );
}

/**
 * The live chat, bound to a resolved thread. Seeds from history, streams live over
 * Realtime, and drives each turn through the thread session. While a turn is in
 * flight the just-sent message shows immediately (an optimistic bubble) and Archer
 * shows a "thinking" row, both reconciled by the folded view when the run returns.
 */
function Chat(props: {
  session: Session;
  threadId: string;
  onComplete: () => void;
  onBack?: () => void;
  deps?: ChatDeps;
}) {
  const { session, threadId, onComplete, onBack } = props;
  const finalize = props.deps?.finalize ?? finalizeGuidedOnboardingDefault;
  const captureVoice = props.deps?.captureVoice ?? captureVoiceDefault;

  const tsRef = useRef<ThreadSession | null>(null);
  const opened = useRef(false);
  const [view, setView] = useState<ThreadView | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const factory = props.deps?.createSession ?? createThreadSession;
    const ts = factory({
      threadId,
      accessToken: session.accessToken,
      onChange: setView,
    });
    tsRef.current = ts;
    ts.subscribe();

    // Archer opens the conversation: once history is seeded and the transcript is
    // empty, kick a greeting run (no user turn) so the brain asks the first
    // question. A failed seed is non-fatal — we still open the chat.
    const open = () => {
      if (opened.current) return;
      opened.current = true;
      setSending(true);
      ts.run({ messages: [] })
        .catch(() => setError("Couldn't reach Archer. Please try again."))
        .finally(() => setSending(false));
    };
    ts.loadHistory()
      .then((v) => {
        setView(v);
        if (v.messages.length === 0) open();
      })
      .catch(open);

    return () => ts.close();
  }, [threadId, session.accessToken, props.deps?.createSession]);

  // Send one turn: append the new user message to the full transcript (the brain
  // reads the history for context) and drive the run. The optimistic `pending`
  // bubble clears once the folded view carries the real message.
  const send = useCallback(
    (text: string) => {
      const value = text.trim();
      const ts = tsRef.current;
      if (!value || sending || !ts) return;
      const history = ts
        .view()
        .messages.map((m) => ({ role: m.role, content: m.content }));
      setSending(true);
      setError(null);
      setPending(value);
      setDraft('');
      ts.run({ messages: [...history, { role: 'user', content: value }] })
        .then(() => setPending(null))
        .catch(() => setError("Couldn't reach Archer. Please try again."))
        .finally(() => setSending(false));
    },
    [sending],
  );

  // Capture spoken input and send it as a turn (transcribed client-side, so spoken
  // and typed answers reach Archer identically).
  const sendVoice = useCallback(() => {
    if (sending) return;
    setSending(true);
    setError(null);
    captureVoice({ accessToken: session.accessToken })
      .then((transcript) => {
        setSending(false);
        send(transcript);
      })
      .catch((err) => {
        setError(
          err instanceof VoiceInputError
            ? err.message
            : "Couldn't capture your voice. Please try again.",
        );
        setSending(false);
      });
  }, [sending, captureVoice, session.accessToken, send]);

  // Finalize the conversation into a proposed draft and converge on review.
  const onFinalize = useCallback(() => {
    const ts = tsRef.current;
    if (sending || finalizing || !ts) return;
    if (!ts.view().messages.some((m) => m.role === 'user')) return;
    setFinalizing(true);
    setError(null);
    finalize(session, threadId)
      .then(() => onComplete())
      .catch(() => {
        setError(
          "Couldn't build your profile yet. Tell Archer a little more, then try again.",
        );
        setFinalizing(false);
      });
  }, [sending, finalizing, finalize, session, threadId, onComplete]);

  if (finalizing) {
    return (
      <StageScreen
        title="Building your profile"
        subtitle="Archer is turning your conversation into a profile draft."
      />
    );
  }

  const messages = (view?.messages ?? []).filter(
    (m) => m.content.trim() !== '',
  );
  const canFinalize = messages.some((m) => m.role === 'user') && !sending;

  // Fixed-height chat: a pinned header, a flexing scroll area for the transcript,
  // and a composer pinned to the bottom — so the input + actions are ALWAYS on
  // screen no matter how long the conversation grows (they used to get pushed off
  // the bottom of a single page-level scroll-view).
  return (
    <view className="Chat">
      <view className="Chat__header">
        <text className="Resume__name">Tell Archer about you</text>
        <text className="Resume__contact">
          Chat about your work, skills and goals — type or use your voice. When
          you're ready, Archer builds your profile.
        </text>
      </view>

      <scroll-view className="Chat__thread" scroll-orientation="vertical">
        {messages.map((m) => (
          <Bubble key={m.id} from={m.role} content={m.content} />
        ))}
        {pending ? <Bubble from="user" content={pending} /> : null}
        {sending ? (
          <view className="Chat__bubble Chat__bubble--archer">
            <text className="Chat__bubbleText">Archer is thinking…</text>
          </view>
        ) : null}
      </scroll-view>

      <view className="Chat__composer">
        {error ? <text className="Auth__error">{error}</text> : null}
        <input
          className="Field"
          placeholder="Tell Archer about your experience…"
          bindinput={(e) => setDraft(e.detail.value)}
        />
        <view
          className={sending ? 'Button Button--busy' : 'Button'}
          bindtap={() => send(draft)}
        >
          <text className="Button__label">Send</text>
        </view>
        <view
          className={
            sending
              ? 'Button Button--secondary Button--busy'
              : 'Button Button--secondary'
          }
          bindtap={sendVoice}
        >
          <text className="Button__label">🎤 Answer by voice</text>
        </view>
        <view
          className={canFinalize ? 'Button' : 'Button Button--busy'}
          bindtap={onFinalize}
        >
          <text className="Button__label">I'm done — build my profile</text>
        </view>
        {onBack ? (
          <view className="Button Button--secondary" bindtap={onBack}>
            <text className="Button__label">Back</text>
          </view>
        ) : null}
      </view>
    </view>
  );
}
