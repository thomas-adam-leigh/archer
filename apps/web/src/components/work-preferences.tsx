import { Briefcase, Mic, Square } from "lucide-react";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import type { WorkPreferences as Prefs, WorkMode } from "#/lib/preferences.ts";
import {
	type UseVoiceCapture,
	useVoiceCapture,
} from "#/lib/use-voice-capture.ts";

/**
 * Capture the typed work preferences a résumé can't supply (ARC-133): the work
 * mode + remote willingness, salary expectations, and notice period. It sits in
 * the hunt-setup stage as an OPTIONAL section — the candidate may answer any
 * subset or skip it entirely (the submit isn't gated on it); whatever is set is
 * persisted to the typed `profiles` columns on "Send to Archer →".
 *
 * Presentational: the route owns the `value` and lifts every change via
 * `onChange`, so the parent holds the single `WorkPreferences` it submits.
 * Consistent with the scripted-voice model — each free-text field offers voice
 * capture with the text box as the always-present fallback.
 */
const WORK_MODES: readonly { value: WorkMode; label: string }[] = [
	{ value: "remote", label: "Remote" },
	{ value: "hybrid", label: "Hybrid" },
	{ value: "office", label: "Office" },
];

export function WorkPreferences({
	value,
	onChange,
}: {
	value: Prefs;
	onChange: (next: Prefs) => void;
}) {
	const setMode = (mode: WorkMode) =>
		// Toggle: tapping the selected mode again clears it (back to "unset").
		onChange({
			...value,
			workPref: value.workPref === mode ? undefined : mode,
		});

	return (
		<div
			data-testid="work-preferences"
			className="mt-4 rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-[22px] py-5"
		>
			<div className="mb-1.5 flex items-center gap-2.5">
				<Briefcase className="size-[17px] text-[var(--accent)]" />
				<div className="font-heading text-[15px] font-semibold">
					Where &amp; how you'll work
				</div>
			</div>
			<p className="mb-4 text-[13px] text-[var(--txt3)]">
				Optional, but it sharpens my matching from day one. Skip anything you'd
				rather not say.
			</p>

			{/* Work mode — single choice, tap again to clear. */}
			<div className="mb-4">
				<div className="mb-2 text-[13px] font-semibold text-[var(--txt2)]">
					Preferred setup
				</div>
				<div className="flex flex-wrap gap-2" data-testid="work-pref-modes">
					{WORK_MODES.map((mode) => {
						const active = value.workPref === mode.value;
						return (
							<button
								key={mode.value}
								type="button"
								data-testid={`work-pref-${mode.value}`}
								onClick={() => setMode(mode.value)}
								aria-pressed={active}
								className={`rounded-full border px-4 py-2 text-[13px] font-semibold transition-colors ${
									active
										? "border-brand/50 bg-brand/15 text-[var(--accent-2)]"
										: "border-[var(--line)] text-[var(--txt2)] hover:border-brand/40 hover:text-[var(--txt)]"
								}`}
							>
								{mode.label}
							</button>
						);
					})}
				</div>
			</div>

			{/* Remote willingness. */}
			<Label className="mb-4 flex items-center justify-between gap-3">
				<span className="text-[13px] font-semibold text-[var(--txt2)]">
					Open to fully-remote roles
				</span>
				<Switch
					data-testid="willing-remote-toggle"
					checked={value.willingRemote ?? false}
					onCheckedChange={(checked) =>
						onChange({ ...value, willingRemote: checked })
					}
				/>
			</Label>

			<div className="grid gap-3 sm:grid-cols-2">
				<VoiceField
					label="Current salary"
					testid="current-salary"
					placeholder="e.g. R900k / year"
					value={value.currentSalary ?? ""}
					onChange={(v) =>
						onChange({ ...value, currentSalary: v || undefined })
					}
				/>
				<VoiceField
					label="Target salary"
					testid="preferred-salary"
					placeholder="e.g. R1.1m / year"
					value={value.preferredSalary ?? ""}
					onChange={(v) =>
						onChange({ ...value, preferredSalary: v || undefined })
					}
				/>
			</div>
			<div className="mt-3">
				<VoiceField
					label="Notice period"
					testid="notice-period"
					placeholder="e.g. 30 days"
					value={value.noticePeriod ?? ""}
					onChange={(v) => onChange({ ...value, noticePeriod: v || undefined })}
				/>
			</div>
		</div>
	);
}

/**
 * A short free-text field with optional voice capture — the transcript is
 * appended to whatever's typed, and the text box is the always-present fallback
 * when the browser can't record.
 */
function VoiceField({
	label,
	testid,
	placeholder,
	value,
	onChange,
}: {
	label: string;
	testid: string;
	placeholder: string;
	value: string;
	onChange: (next: string) => void;
}) {
	const voice = useVoiceCapture((text) =>
		onChange(value.trim() ? `${value.trim()} ${text}` : text),
	);
	return (
		<div>
			<div className="mb-1.5 text-[13px] font-semibold text-[var(--txt2)]">
				{label}
			</div>
			<div className="flex items-center gap-2">
				<Input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					aria-label={label}
					data-testid={`${testid}-input`}
				/>
				<VoiceButton voice={voice} label={label} testid={`${testid}-voice`} />
			</div>
		</div>
	);
}

/** A compact record/stop mic button; hidden when the browser can't record. */
function VoiceButton({
	voice,
	label,
	testid,
}: {
	voice: UseVoiceCapture;
	label: string;
	testid: string;
}) {
	if (!voice.supported) return null;
	const recording = voice.status === "recording";
	const transcribing = voice.status === "transcribing";
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={recording ? voice.stop : voice.start}
			disabled={transcribing}
			aria-pressed={recording}
			aria-label={recording ? `Stop recording ${label}` : `Record ${label}`}
			className={`flex size-9 shrink-0 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
				recording
					? "border-[#f0936c]/60 bg-[#f0936c]/10 text-[#f0936c]"
					: "border-[var(--line)] text-[var(--txt2)] hover:border-brand/45 hover:text-[var(--txt)]"
			}`}
		>
			{recording ? (
				<Square className="size-4 fill-current" />
			) : (
				<Mic className="size-4" />
			)}
		</button>
	);
}
