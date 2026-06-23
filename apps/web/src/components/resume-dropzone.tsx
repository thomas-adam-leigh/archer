import { ArrowRight, FileText, UploadCloud } from "lucide-react";
import { type DragEvent, useCallback, useState } from "react";
import {
	fileToPicked,
	ResumeUploadError,
	validateResume,
} from "#/lib/resume.ts";
import { cn } from "#/lib/utils.ts";

/**
 * The résumé intake screen (ARC-101): a drag-and-drop / click-to-browse zone that
 * accepts a PDF or Word (.docx) résumé, a "How it works" disclosure, and the
 * "Talk to me instead" escape hatch to the scratch conversation.
 *
 * Validation reuses the backend contract directly — {@link fileToPicked} +
 * {@link validateResume} from `resume.ts` — so the friendly rejection a user sees
 * here is exactly the one the upload (ARC-102) enforces. (The design copy says
 * ".doc/.docx", but the bucket accepts PDF + DOCX, not legacy binary .doc; the
 * copy here follows what actually uploads.)
 *
 * Choosing a valid file lands in the selected-file state, from which the candidate
 * can confirm ("Read my résumé →", handed to {@link ResumeDropzoneProps.onUpload})
 * or swap the file. The upload + "reading every line" processing screen the upload
 * leads to live in the résumé route (ARC-102).
 */
interface ResumeDropzoneProps {
	/** Upload the chosen file and start its ingest ("Read my résumé →"). */
	onUpload: (file: File) => void;
	/** Switch to the conversational path ("Talk to me instead →"). */
	onTalkInstead: () => void;
}

const ACCEPT =
	".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const HOW_IT_WORKS = [
	"Drop in your résumé — PDF or Word (.docx).",
	"I'll extract your name, links, experience and skills.",
	"You review what I built — and tell me anything to fix.",
];

export function ResumeDropzone({
	onUpload,
	onTalkInstead,
}: ResumeDropzoneProps) {
	const [dragging, setDragging] = useState(false);
	const [selected, setSelected] = useState<File | null>(null);
	const [error, setError] = useState<string | null>(null);

	const accept = useCallback(async (file: File) => {
		try {
			const picked = await fileToPicked(file);
			validateResume(picked);
			setSelected(file);
			setError(null);
		} catch (err) {
			setSelected(null);
			setError(
				err instanceof ResumeUploadError
					? err.message
					: "Couldn't read that file. Please try another.",
			);
		}
	}, []);

	const onDrop = useCallback(
		(e: DragEvent<HTMLLabelElement>) => {
			e.preventDefault();
			setDragging(false);
			const file = e.dataTransfer.files?.[0];
			if (file) void accept(file);
		},
		[accept],
	);

	return (
		<div className="a-fadeup mx-auto w-full max-w-[620px] pt-[6vh]">
			<header className="mb-[34px] text-center">
				<h1 className="font-heading text-[clamp(24px,3vw,32px)] font-bold tracking-tight">
					Drop in your résumé
				</h1>
				<p className="mt-2.5 text-base text-[var(--txt2)]">
					I'll pull out your experience, links and skills — then show you what I
					found.
				</p>
			</header>

			<label
				data-testid="resume-dropzone"
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
				className={cn(
					"block cursor-pointer rounded-[22px] border-[1.6px] border-dashed bg-[var(--card-2)] px-[30px] py-[44px] text-center transition-[border-color,background] duration-200",
					"focus-within:border-brand/70 hover:border-brand/70 hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]",
					dragging
						? "border-brand bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
						: "border-[var(--line)]",
				)}
			>
				<input
					type="file"
					accept={ACCEPT}
					aria-label="Upload your résumé — PDF or Word (.docx)"
					className="sr-only"
					data-testid="resume-input"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void accept(file);
						e.target.value = "";
					}}
				/>

				{selected ? (
					<div
						data-testid="resume-selected"
						className="flex flex-col items-center"
					>
						<div className="mb-4 flex size-16 items-center justify-center rounded-[18px] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-brand">
							<FileText className="size-7" strokeWidth={2} />
						</div>
						<div className="font-heading text-lg font-semibold">
							{selected.name}
						</div>
						<div className="mt-1 text-sm text-[var(--txt3)]">
							{formatBytes(selected.size)} · ready to read
						</div>
						<span className="mt-5 inline-block rounded-xl border border-[var(--line)] px-5 py-2.5 text-sm font-semibold text-[var(--txt2)] transition-colors hover:border-brand/45 hover:text-[var(--txt)]">
							Choose a different file
						</span>
					</div>
				) : (
					<div className="flex flex-col items-center">
						<div className="mb-[18px] flex size-16 items-center justify-center rounded-[18px] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-brand">
							<UploadCloud className="size-7" strokeWidth={2} />
						</div>
						<div className="font-heading text-lg font-semibold">
							Drop your résumé here
						</div>
						<div className="mt-1.5 text-sm text-[var(--txt3)]">
							or click to browse · PDF or Word (.docx)
						</div>
						<span className="mt-5 inline-block rounded-xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)]">
							Choose file
						</span>
					</div>
				)}
			</label>

			{selected ? (
				<button
					type="button"
					data-testid="resume-upload"
					onClick={() => onUpload(selected)}
					className="mt-5 block w-full rounded-2xl bg-[linear-gradient(135deg,var(--accent-2),var(--accent))] px-6 py-3.5 text-[15px] font-bold text-[#160a02] shadow-[0_10px_28px_var(--glow)] transition-transform hover:-translate-y-px"
				>
					Read my résumé →
				</button>
			) : null}

			{error ? (
				<p
					role="alert"
					data-testid="resume-error"
					className="mt-4 rounded-[13px] border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] px-4 py-3.5 text-sm font-semibold text-brand-2"
				>
					{error}
				</p>
			) : null}

			<details className="mt-[30px] rounded-[18px] border border-[var(--line-2)] bg-[var(--card-2)] px-6 py-[18px]">
				<summary className="cursor-pointer list-none text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--txt2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
					How it works
				</summary>
				<ol className="mt-3.5 space-y-2.5">
					{HOW_IT_WORKS.map((step, i) => (
						<li key={step} className="flex items-start gap-3">
							<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--line)] text-[11px] text-[var(--txt3)]">
								{i + 1}
							</span>
							<span className="text-sm leading-normal text-[var(--txt2)]">
								{step}
							</span>
						</li>
					))}
				</ol>
			</details>

			<button
				type="button"
				data-testid="resume-talk-instead"
				onClick={onTalkInstead}
				className="mx-auto mt-6 flex items-center gap-1.5 text-sm font-semibold text-[var(--txt3)] transition-colors hover:text-[var(--txt2)]"
			>
				No résumé handy? Talk to me instead
				<ArrowRight className="size-4" />
			</button>
		</div>
	);
}

/** A compact, human file size (e.g. "284 KB", "1.4 MB") for the selected file. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
