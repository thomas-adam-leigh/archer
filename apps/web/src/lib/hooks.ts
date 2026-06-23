/**
 * TanStack Query hooks over the Archer onboarding contract.
 *
 * Reads are queries (onboarding progress, the proposed profile draft); writes
 * are mutations (auth, résumé upload + ingest, transcription, profile decide /
 * revise, title suggestions, negative criteria). Every authenticated call reads
 * the current {@link Session} from the session store, so screens just call the
 * hook — they never thread tokens around. Auth mutations keep the store in sync.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "#/lib/auth.ts";
import { signIn, signOut, signUp } from "#/lib/auth.ts";
import {
	buildProfileFromAnswers,
	type GuidedOnboardingResult,
	type ScratchFlowDeps,
} from "#/lib/conversation.ts";
import {
	fetchOnboardingProgress,
	type OnboardingProgress,
} from "#/lib/onboarding.ts";
import {
	addNegativeCriterion,
	approveTitles,
	type NegativeCriterion,
	type SuggestTitlesInput,
	suggestTitles,
} from "#/lib/preferences.ts";
import {
	approveProposedDraft,
	fetchProposedProfileDraft,
	type ProfileDraft,
	type RevisionStarted,
	reviseProposedDraft,
} from "#/lib/profile.ts";
import {
	type IngestStarted,
	type ResumeFlowDeps,
	uploadResumeAndStartIngest,
} from "#/lib/resume.ts";
import { clearSession, setSession, useSession } from "#/lib/session.ts";
import { type AudioClip, transcribe } from "#/lib/voice.ts";

/** Stable query keys for the onboarding reads (scoped by user id). */
export const queryKeys = {
	onboardingProgress: (userId: string) =>
		["onboarding", "progress", userId] as const,
	proposedProfileDraft: (userId: string) =>
		["profile", "proposed-draft", userId] as const,
};

/** Read the current session or throw — used inside authenticated mutations. */
function requireSession(session: Session | null): Session {
	if (!session) throw new Error("You need to be signed in to do that.");
	return session;
}

/** Resume the user's onboarding progress; disabled until signed in. */
export function useOnboardingProgress() {
	const session = useSession();
	return useQuery<OnboardingProgress>({
		queryKey: session
			? queryKeys.onboardingProgress(session.user.id)
			: ["onboarding", "progress", "anonymous"],
		queryFn: () => fetchOnboardingProgress(requireSession(session)),
		enabled: Boolean(session),
	});
}

/** Fetch the proposed profile draft awaiting review; disabled until signed in. */
export function useProposedProfileDraft() {
	const session = useSession();
	return useQuery<ProfileDraft>({
		queryKey: session
			? queryKeys.proposedProfileDraft(session.user.id)
			: ["profile", "proposed-draft", "anonymous"],
		queryFn: () => fetchProposedProfileDraft(requireSession(session)),
		enabled: Boolean(session),
		retry: false,
	});
}

/** Sign in with email + password, storing the session on success. */
export function useSignIn() {
	return useMutation({
		mutationFn: (vars: { email: string; password: string }) =>
			signIn(vars.email, vars.password),
		onSuccess: (session) => setSession(session),
	});
}

/**
 * Create an account. Stores the session when the project returns tokens (email
 * confirmation disabled); otherwise resolves with `session: null` so the UI can
 * prompt the user to confirm their email.
 */
export function useSignUp() {
	return useMutation({
		mutationFn: (vars: { email: string; password: string }) =>
			signUp(vars.email, vars.password),
		onSuccess: ({ session }) => {
			if (session) setSession(session);
		},
	});
}

/** Sign out, clearing the session regardless of the server's response. */
export function useSignOut() {
	const session = useSession();
	return useMutation({
		mutationFn: async () => {
			if (session) await signOut(session.accessToken);
		},
		onSettled: () => clearSession(),
	});
}

/** Upload a chosen résumé `File` and start its ingest run. */
export function useUploadResume() {
	const session = useSession();
	return useMutation<
		IngestStarted,
		Error,
		{ file: File; deps: ResumeFlowDeps }
	>({
		mutationFn: (vars) =>
			uploadResumeAndStartIngest(requireSession(session), vars.file, vars.deps),
	});
}

/**
 * Finalize the scripted "start from scratch" onboarding: persist the captured
 * answers to the thread, structure them into a PROPOSED profile version, and
 * advance to review. Invalidates the cached onboarding progress on success so the
 * review route's resume guard sees the new `review` step instead of bouncing back.
 */
export function useFinalizeScratchOnboarding() {
	const session = useSession();
	const queryClient = useQueryClient();
	return useMutation<
		GuidedOnboardingResult,
		Error,
		{ answers: readonly string[]; deps: ScratchFlowDeps }
	>({
		mutationFn: (vars) =>
			buildProfileFromAnswers(requireSession(session), vars.answers, vars.deps),
		onSuccess: () => {
			if (session) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.onboardingProgress(session.user.id),
				});
			}
		},
	});
}

/** Transcribe a recorded audio clip to text. */
export function useTranscribe() {
	const session = useSession();
	return useMutation<string, Error, AudioClip>({
		mutationFn: (clip) => transcribe(clip, requireSession(session).accessToken),
	});
}

/** Self-approve the open proposed profile draft. */
export function useApproveDraft() {
	const session = useSession();
	return useMutation<void, Error, { proposalId: string }>({
		mutationFn: (vars) =>
			approveProposedDraft(requireSession(session), vars.proposalId),
	});
}

/** Revise the open proposed draft from the candidate's feedback. */
export function useReviseDraft() {
	const session = useSession();
	return useMutation<
		RevisionStarted,
		Error,
		{ threadId: string; feedback: string }
	>({
		mutationFn: (vars) => reviseProposedDraft(requireSession(session), vars),
	});
}

/** Suggest (or re-suggest) ranked target titles. */
export function useSuggestTitles() {
	const session = useSession();
	return useMutation<string[], Error, SuggestTitlesInput | void>({
		mutationFn: (input) => suggestTitles(requireSession(session), input ?? {}),
	});
}

/** Persist the chosen target titles. */
export function useApproveTitles() {
	const session = useSession();
	return useMutation<void, Error, { titles: string[] }>({
		mutationFn: (vars) => approveTitles(requireSession(session), vars.titles),
	});
}

/** Capture one negative criterion (a rule-out). */
export function useAddNegativeCriterion() {
	const session = useSession();
	return useMutation<NegativeCriterion, Error, { text: string }>({
		mutationFn: (vars) =>
			addNegativeCriterion(requireSession(session), vars.text),
	});
}
