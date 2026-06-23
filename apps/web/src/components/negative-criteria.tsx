import { Ban, Loader2, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import type { NegativeCriterion } from "#/lib/preferences.ts";

/**
 * The "Never send me" rule-out capture (ARC-110) — the last onboarding input.
 *
 * Presentational: the route owns the data + mutations (see `useNegativeCriteria`
 * / `useAddNegativeCriterion` / `useRemoveNegativeCriterion`) and hands them down.
 * Adding submits the trimmed text; the populated state renders each rule-out as a
 * removable chip (⊘ text ✕); the empty state shows the spec's italic prompt. The
 * "Send to Archer →" submit + hunt setup land in ARC-111.
 */
export function NegativeCriteria({
	criteria,
	onAdd,
	onRemove,
	adding = false,
	removingId = null,
	error = null,
}: {
	criteria: NegativeCriterion[];
	onAdd: (text: string) => void;
	onRemove: (id: string) => void;
	adding?: boolean;
	removingId?: string | null;
	error?: string | null;
}) {
	const [text, setText] = useState("");
	const hasCaptured = criteria.length > 0;

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const trimmed = text.trim();
		if (!trimmed || adding) return;
		onAdd(trimmed);
		setText("");
	}

	return (
		<div className="rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[22px] py-5">
			<div className="mb-1.5 flex items-center gap-2.5">
				<Ban className="size-[17px] text-[var(--accent)]" />
				<div className="font-heading text-[15px] font-semibold">
					Never send me
				</div>
			</div>
			<p className="mb-3.5 text-[13px] text-[var(--txt3)]">
				So I can filter sharply from day one. Tell me anything to rule out.
			</p>

			<form onSubmit={handleSubmit} className="mb-3.5 flex gap-2.5">
				<Input
					value={text}
					onChange={(e) => setText(e.target.value)}
					disabled={adding}
					aria-label="Something to rule out"
					placeholder="nothing in .NET or C#"
					data-testid="criteria-input"
				/>
				<Button
					type="submit"
					variant="brand"
					disabled={adding || text.trim().length === 0}
					data-testid="criteria-add"
				>
					{adding ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Plus className="size-4" />
					)}
					Add
				</Button>
			</form>

			{error ? (
				<p
					className="mb-3.5 text-[13px] font-semibold text-[var(--accent-2)]"
					role="alert"
				>
					{error}
				</p>
			) : null}

			{hasCaptured ? (
				<div className="flex flex-wrap gap-2" data-testid="criteria-list">
					{criteria.map((c) => {
						const removing = removingId === c.id;
						return (
							<span
								key={c.id}
								className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 py-2 pr-2 pl-3.5 text-[13px] font-semibold text-[var(--accent-2)]"
							>
								<span aria-hidden>⊘</span>
								{c.text}
								<button
									type="button"
									onClick={() => onRemove(c.id)}
									disabled={removing}
									aria-label={`Remove ${c.text}`}
									data-testid="criteria-remove"
									className="inline-flex size-5 items-center justify-center rounded-full text-[var(--accent-2)] transition-colors hover:bg-brand/20 disabled:opacity-50"
								>
									{removing ? (
										<Loader2 className="size-3 animate-spin" />
									) : (
										<X className="size-3" />
									)}
								</button>
							</span>
						);
					})}
				</div>
			) : (
				<p
					className="text-[13px] italic text-[var(--txt3)]"
					data-testid="criteria-empty"
				>
					Nothing ruled out yet — say something like "nothing in .NET or C#".
				</p>
			)}
		</div>
	);
}
