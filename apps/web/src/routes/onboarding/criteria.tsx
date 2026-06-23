import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { NegativeCriteria } from "#/components/negative-criteria.tsx";
import { TargetTitles } from "#/components/target-titles.tsx";
import { WorkPreferences } from "#/components/work-preferences.tsx";
import {
	useAddNegativeCriterion,
	useNegativeCriteria,
	useRemoveNegativeCriterion,
	useSubmitHuntSetup,
	useSuggestedTitles,
} from "#/lib/hooks.ts";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import type { WorkPreferences as Prefs } from "#/lib/preferences.ts";
import { OnboardingGate } from "./route.tsx";

export const Route = createFileRoute("/onboarding/criteria")({
	component: CriteriaRoute,
	staticData: { onboardingStep: progressSegmentForRoute("criteria") },
});

/**
 * Hunt setup — "Here's what I'll hunt for" (M7: ARC-110 + ARC-111). Archer's
 * ranked target titles (suggested from the approved profile) sit above the
 * rule-outs the candidate adds; the single "Send to Archer →" submit confirms the
 * titles and captures completion (the Acceptance-Gate submit), after which the
 * resume guard forwards the now-`done` user to home. The submit is gated until
 * the readiness inputs exist — at least one target title and one rule-out — so it
 * never trips the backend's 409. The shared `onboarding-stage-criteria` testid
 * keeps the review E2E's "approve advances to criteria" assertion green.
 */
function CriteriaRoute() {
	const resume = useOnboardingResume("criteria");
	const titles = useSuggestedTitles();
	const criteria = useNegativeCriteria();
	const add = useAddNegativeCriterion();
	const remove = useRemoveNegativeCriterion();
	const submit = useSubmitHuntSetup();
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [preferences, setPreferences] = useState<Prefs>({});

	const onAdd = (text: string) => add.mutate({ text });
	const onRemove = (id: string) => {
		setRemovingId(id);
		remove.mutate({ id }, { onSettled: () => setRemovingId(null) });
	};

	if (resume.status !== "ready") return <OnboardingGate resume={resume} />;

	const criteriaError =
		add.isError || remove.isError
			? "Couldn't save that just now. Please try again."
			: null;

	const titleList = titles.data ?? [];
	const ruleOuts = criteria.data ?? [];
	// Readiness needs ≥1 target title and ≥1 rule-out before /onboarding/complete.
	const canSubmit =
		titleList.length > 0 && ruleOuts.length > 0 && !submit.isPending;

	const onSubmit = () => {
		if (!canSubmit) return;
		submit.mutate({ titles: titleList, preferences });
	};

	return (
		<div
			data-testid="onboarding-stage-criteria"
			className="mx-auto max-w-[680px] pt-[3vh]"
		>
			<header className="a-fadeup mb-7 text-center">
				<h2 className="mb-2 font-heading text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.02em]">
					Here's what I'll hunt for.
				</h2>
				<p className="m-0 text-[15px] text-[var(--txt2)]">
					Your target roles, plus a few deal-breakers so I filter sharply from
					day one.
				</p>
			</header>

			<TargetTitles
				titles={titleList}
				loading={titles.isPending}
				error={
					titles.isError ? "Couldn't load your target titles just now." : null
				}
				onRetry={() => titles.refetch()}
			/>

			<WorkPreferences value={preferences} onChange={setPreferences} />

			{criteria.isPending ? (
				<div
					className="flex min-h-[20vh] items-center justify-center"
					aria-busy="true"
				>
					<Loader2 className="size-5 animate-spin text-[var(--accent)]" />
				</div>
			) : (
				<NegativeCriteria
					criteria={ruleOuts}
					onAdd={onAdd}
					onRemove={onRemove}
					adding={add.isPending}
					removingId={removingId}
					error={criteriaError}
				/>
			)}

			<div className="mt-6 flex flex-col items-end gap-2">
				<button
					type="button"
					data-testid="hunt-setup-submit"
					onClick={onSubmit}
					disabled={!canSubmit}
					className="flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
				>
					{submit.isPending ? (
						<Loader2 className="size-[18px] animate-spin" />
					) : null}
					Send to Archer
					<ArrowRight className="size-[18px]" />
				</button>
				{submit.isError ? (
					<p
						data-testid="hunt-setup-error"
						className="text-[13px] font-semibold text-[#f0936c]"
						role="alert"
					>
						Couldn't send that to Archer just now. Please try again.
					</p>
				) : ruleOuts.length === 0 ? (
					<p className="text-[13px] text-[var(--txt3)]">
						Add at least one rule-out to continue.
					</p>
				) : null}
			</div>
		</div>
	);
}
