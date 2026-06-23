import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { NegativeCriteria } from "#/components/negative-criteria.tsx";
import {
	useAddNegativeCriterion,
	useNegativeCriteria,
	useRemoveNegativeCriterion,
} from "#/lib/hooks.ts";
import { progressSegmentForRoute } from "#/lib/onboarding-flow.ts";
import { useOnboardingResume } from "#/lib/onboarding-guard.ts";
import { OnboardingPending } from "./route.tsx";

export const Route = createFileRoute("/onboarding/criteria")({
	component: CriteriaRoute,
	staticData: { onboardingStep: progressSegmentForRoute("criteria") },
});

/**
 * Negative-criteria capture — "Here's what I'll hunt for" (M7: ARC-110). The
 * candidate adds the rule-outs Archer should never surface; each one persists via
 * the criteria contract and renders as a removable chip, with the spec's empty
 * state until the first is captured. Hunt setup + the "Send to Archer →" submit
 * that advances to home land in ARC-111, so the stage shows only the rule-outs
 * card for now — wrapped in the shared `onboarding-stage-criteria` testid so the
 * review E2E's "approve advances to criteria" assertion stays green.
 */
function CriteriaRoute() {
	const { status } = useOnboardingResume("criteria");
	const criteria = useNegativeCriteria();
	const add = useAddNegativeCriterion();
	const remove = useRemoveNegativeCriterion();
	const [removingId, setRemovingId] = useState<string | null>(null);

	const onAdd = (text: string) => add.mutate({ text });
	const onRemove = (id: string) => {
		setRemovingId(id);
		remove.mutate({ id }, { onSettled: () => setRemovingId(null) });
	};

	if (status !== "ready") return <OnboardingPending />;

	const error =
		add.isError || remove.isError
			? "Couldn't save that just now. Please try again."
			: null;

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
					A few deal-breakers help me filter sharply from day one.
				</p>
			</header>

			{criteria.isPending ? (
				<div
					className="flex min-h-[30vh] items-center justify-center"
					aria-busy="true"
				>
					<Loader2 className="size-5 animate-spin text-[var(--accent)]" />
				</div>
			) : (
				<NegativeCriteria
					criteria={criteria.data ?? []}
					onAdd={onAdd}
					onRemove={onRemove}
					adding={add.isPending}
					removingId={removingId}
					error={error}
				/>
			)}
		</div>
	);
}
