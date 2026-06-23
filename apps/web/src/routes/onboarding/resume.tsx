import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ResumeDropzone } from "#/components/resume-dropzone.tsx";
import { ResumeProcessing } from "#/components/resume-processing.tsx";
import type { Session } from "#/lib/auth.ts";
import { queryKeys, useUploadResume } from "#/lib/hooks.ts";
import { fetchOnboardingProgress } from "#/lib/onboarding.ts";
import { progressSegmentForRoute, routePath } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { ResumeUploadError } from "#/lib/resume.ts";
import { isDraftReady } from "#/lib/resume-processing.ts";
import { useSession } from "#/lib/session.ts";
import { fetchPrimaryThreadId } from "#/lib/threads.ts";
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/resume")({
	component: ResumeRoute,
	staticData: { onboardingStep: progressSegmentForRoute("resume") },
});

/** How often to poll `/onboarding/progress` as the reconnect/fallback signal. */
const POLL_MS = 2000;
/** A last-resort backstop: a stalled ingest that never streams a phase nor a
 *  progress update still surfaces a recoverable failure rather than spinning
 *  forever. The live AG-UI stream (`run_error` / `state.phase === 'error'`) is the
 *  primary failure signal now; this only catches a wholly silent stall. */
const MAX_WAIT_MS = 90_000;

/** The résumé path's local stage: intake → processing → (recoverable) error. */
type Stage =
	| { kind: "intake" }
	| { kind: "processing"; fileName: string }
	| { kind: "error"; fileName: string; message?: string };

/**
 * The résumé upload path (M4 + ARC-125). The dropzone (ARC-101) collects a file;
 * confirming it uploads to Storage and starts the ingest run, then the "reading
 * every line" processing screen subscribes to the run's AG-UI events and renders
 * the **live** backend phases as Archer reads the résumé. The screen signals
 * completion (the proposed draft landed) and failure upward; the route advances to
 * review or surfaces a recoverable error.
 *
 * `/onboarding/progress` is still polled as a reconnect/fallback: if the live
 * socket drops, the readiness signal it exposes (`step → review`) still advances
 * the candidate. The backend step machine keeps this route mounted through
 * `processing` (it maps back to `resume`); once the draft lands the step flips to
 * `review` and we — and the route guard — send the candidate onward.
 */
function ResumeRoute() {
	const navigate = useNavigate();
	const session = useSession();
	const resume = useOnboardingResume("resume");
	const upload = useUploadResume();
	const [stage, setStage] = useState<Stage>({ kind: "intake" });
	// The ingest run's thread, learned when the upload's ingest start resolves;
	// the processing screen attaches its live session to it.
	const [threadId, setThreadId] = useState<string | null>(null);

	const processing = stage.kind === "processing";

	// Poll progress only while processing; reusing the shared query key keeps the
	// route guard's view fresh too, so resume-at-step stays consistent.
	const progressQuery = useQuery({
		queryKey: session
			? queryKeys.onboardingProgress(session.user.id)
			: ["onboarding", "progress", "anonymous"],
		queryFn: () => fetchOnboardingProgress(session as Session),
		enabled: processing && Boolean(session),
		refetchInterval: processing ? POLL_MS : false,
	});

	const goToReview = useCallback(() => {
		navigate({ to: routePath("review"), replace: true });
	}, [navigate]);

	// Reconnect/fallback: advance to review the moment the polled progress reports
	// the draft is ready, in case the live socket never delivered the completion.
	useEffect(() => {
		if (stage.kind !== "processing") return;
		if (progressQuery.data && isDraftReady(progressQuery.data)) {
			goToReview();
		}
	}, [stage, progressQuery.data, goToReview]);

	// Backstop: a wholly silent ingest (no phase stream, no progress update) falls
	// back to a recoverable error rather than spinning forever.
	useEffect(() => {
		if (stage.kind !== "processing") return;
		const { fileName } = stage;
		const id = setTimeout(
			() => setStage({ kind: "error", fileName }),
			MAX_WAIT_MS,
		);
		return () => clearTimeout(id);
	}, [stage]);

	const onUpload = useCallback(
		(file: File) => {
			setThreadId(null);
			setStage({ kind: "processing", fileName: file.name });
			upload.mutate(
				{ file, deps: { resolveThreadId: (s) => fetchPrimaryThreadId(s) } },
				{
					onSuccess: (started) => setThreadId(started.threadId),
					onError: (err) =>
						setStage({
							kind: "error",
							fileName: file.name,
							message:
								err instanceof ResumeUploadError ? err.message : undefined,
						}),
				},
			);
		},
		[upload],
	);

	// A terminal run failure from the live stream surfaces the error stage.
	const onIngestError = useCallback((message?: string) => {
		setStage((prev) =>
			prev.kind === "processing"
				? { kind: "error", fileName: prev.fileName, message }
				: prev,
		);
	}, []);

	const onRetry = useCallback(() => {
		upload.reset();
		setThreadId(null);
		setStage({ kind: "intake" });
	}, [upload]);

	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;

	if (stage.kind === "intake") {
		return (
			<ResumeDropzone
				onUpload={onUpload}
				onTalkInstead={() =>
					navigate({ to: routePath("conversation"), replace: true })
				}
			/>
		);
	}

	return (
		<ResumeProcessing
			session={session as Session}
			threadId={threadId}
			fileName={stage.fileName}
			status={stage.kind === "error" ? "error" : "processing"}
			failureMessage={stage.kind === "error" ? stage.message : undefined}
			onComplete={goToReview}
			onError={onIngestError}
			onRetry={onRetry}
		/>
	);
}
