import type { createThreadSession, ThreadView } from "@archer/agui-client";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createWebThreadSession } from "#/lib/agui.ts";
import type { Session } from "#/lib/auth.ts";
import {
	REVISE_SUBTEXT,
	readReviseView,
	reviseProcessingView,
} from "#/lib/revise-processing.ts";

/**
 * The "Archer is reworking your draft" overlay (ARC-129) shown over the profile
 * review while a revise run rebuilds the draft from the candidate's feedback.
 *
 * Like the résumé processing screen (ARC-125), it subscribes to the run's AG-UI
 * `events` via the shared client (`createWebThreadSession`) — seeding from history,
 * streaming live over Supabase Realtime, folding the run — and renders the live
 * `state.phase` the backend emits (`reading → revising → complete`). There is no
 * timer: the overlay only shows progress the revise run has actually made, instead
 * of the old dead "Reworking…" spinner.
 *
 * It signals upward rather than navigating: {@link onComplete} fires once a FRESH
 * proposed version lands (a finished run whose versionId differs from
 * {@link fromVersion}, the version on screen when the feedback was sent), and
 * {@link onError} fires on a terminal run failure (`run_error` / `state.phase ===
 * 'error'`). The owning route keeps polling `/onboarding/progress` as a
 * reconnect/fallback, so a dropped socket still lands the revision.
 */
interface ProfileRevisingProps {
	/** The authenticated session (its access token authorizes history + Realtime). */
	session: Session;
	/** The review thread the revise run streams on. */
	threadId: string;
	/** The proposed version id on screen when the feedback was sent (the "from"). */
	fromVersion: string | null;
	/** Fired once when a fresh proposed version lands — the route hands off to it. */
	onComplete: () => void;
	/** Fired once on a terminal run failure — the route surfaces the error. */
	onError: (message?: string) => void;
	/** Injectable thread-session factory so the suite runs without a real socket. */
	createSession?: typeof createThreadSession;
}

export function ProfileRevising({
	session,
	threadId,
	fromVersion,
	onComplete,
	onError,
	createSession,
}: ProfileRevisingProps) {
	const [view, setView] = useState<ThreadView | null>(null);
	// Fire each upward signal at most once per revise run.
	const completed = useRef(false);
	const errored = useRef(false);

	// Open the live session for the revise run. Seed from history, stream live; a
	// failed seed is non-fatal (Realtime + the route's progress poll still drive).
	useEffect(() => {
		completed.current = false;
		errored.current = false;
		const ts = createWebThreadSession({
			session,
			threadId,
			onChange: setView,
			createSession,
		});
		try {
			ts.subscribe();
		} catch {
			// Opening the socket is best-effort: a host that can't (no WebSocket,
			// a bad URL) still gets history + the route's progress poll.
		}
		ts.loadHistory()
			.then(setView)
			.catch(() => {
				// Non-fatal: the live stream + the route's progress poll still land it.
			});
		return () => {
			ts.close();
			setView(null);
		};
	}, [threadId, session, createSession]);

	const revise = readReviseView(view, fromVersion);

	// Signal completion / failure exactly once.
	useEffect(() => {
		if (revise.failed && !errored.current) {
			errored.current = true;
			onError();
		} else if (revise.complete && !completed.current) {
			completed.current = true;
			onComplete();
		}
	}, [revise.failed, revise.complete, onComplete, onError]);

	const card = reviseProcessingView(revise.phase);

	return (
		<div
			data-testid="profile-review-reworking"
			className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 rounded-[24px] bg-[rgba(8,8,9,0.82)] px-6 text-center backdrop-blur-[6px]"
			aria-busy="true"
		>
			<div className="relative flex size-[96px] items-center justify-center">
				<div
					className="a-glowpulse absolute inset-0 rounded-full"
					style={{
						background:
							"radial-gradient(circle, var(--glow) 0%, transparent 68%)",
					}}
				/>
				<Loader2 className="size-7 animate-spin text-[var(--accent)]" />
			</div>

			<div>
				<h2
					data-testid="profile-reworking-stage"
					className="min-h-[30px] font-heading text-[clamp(18px,2.2vw,22px)] font-bold tracking-tight"
				>
					{card.title}
				</h2>
				<p className="mt-2 text-sm text-[var(--txt2)]">{REVISE_SUBTEXT}</p>
			</div>

			<div className="w-full max-w-[360px]">
				<div className="h-1.5 overflow-hidden rounded-[6px] bg-[rgba(255,255,255,0.08)]">
					<div
						className="h-full rounded-[6px] bg-[linear-gradient(90deg,var(--accent-2),var(--accent))] transition-[width] duration-500 ease-out"
						style={{ width: `${card.pct}%` }}
					/>
				</div>
			</div>

			<ul
				data-testid="profile-reworking-log"
				className="flex flex-col items-start gap-2 text-left"
			>
				{card.log.map((line) => (
					<li
						key={line}
						className="a-fadeup flex items-center gap-2.5 text-sm text-[var(--txt2)]"
					>
						<span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[11px] text-brand">
							✓
						</span>
						{line}
					</li>
				))}
			</ul>
		</div>
	);
}
