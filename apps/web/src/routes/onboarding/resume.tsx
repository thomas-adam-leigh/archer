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

/** How often to poll `/onboarding/progress` while the ingest run builds the draft. */
const POLL_MS = 2000;
/** How long to wait for the draft before surfacing a recoverable failure. The web
 *  client has no Realtime run-error channel (mobile's `state.phase === 'error'`),
 *  so an ingest that never completes is caught here rather than spinning forever. */
const MAX_WAIT_MS = 90_000;

/** The résumé path's local stage: intake → processing → (recoverable) error. */
type Stage =
	| { kind: "intake" }
	| { kind: "processing"; fileName: string }
	| { kind: "error"; fileName: string; message?: string };

/**
 * The résumé upload path (M4). The dropzone (ARC-101) collects a file; confirming
 * it uploads to Storage and starts the ingest run, then the "reading every line"
 * processing screen polls `/onboarding/progress` until the draft profile is ready
 * and advances to review (ARC-102). Upload failures and a stalled ingest both land
 * on a recoverable error with "Try again".
 *
 * The backend step machine keeps this route mounted through `processing` (it maps
 * back to `resume`); once the draft lands the step flips to `review` and we — and
 * the route guard — send the candidate onward.
 */
function ResumeRoute() {
	const navigate = useNavigate();
	const session = useSession();
	const resume = useOnboardingResume("resume");
	const upload = useUploadResume();
	const [stage, setStage] = useState<Stage>({ kind: "intake" });

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

	// Advance to review the moment the polled progress reports the draft is ready.
	useEffect(() => {
		if (stage.kind !== "processing") return;
		if (progressQuery.data && isDraftReady(progressQuery.data)) {
			navigate({ to: routePath("review"), replace: true });
		}
	}, [stage, progressQuery.data, navigate]);

	// Cap the wait: a stalled ingest falls back to a recoverable error rather than
	// spinning forever (the web client has no Realtime run-error signal).
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
			setStage({ kind: "processing", fileName: file.name });
			upload.mutate(
				{ file, deps: { resolveThreadId: (s) => fetchPrimaryThreadId(s) } },
				{
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

	const onRetry = useCallback(() => {
		upload.reset();
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
			fileName={stage.fileName}
			status={stage.kind === "error" ? "error" : "processing"}
			failureMessage={stage.kind === "error" ? stage.message : undefined}
			onRetry={onRetry}
		/>
	);
}
