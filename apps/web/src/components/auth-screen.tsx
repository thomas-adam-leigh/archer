import { type FormEvent, useCallback, useId, useState } from "react";

import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { AuthError, type Session, signIn, signUp } from "#/lib/auth.ts";

type Mode = "signin" | "signup";

/**
 * Email + password auth screen, ported from the mobile `AuthScreen`
 * (apps/mobile/src/components/AuthScreen.tsx) and styled to the web design
 * system. Owns the form state (mode toggle, validation, busy, error/notice) and
 * calls the GoTrue auth client; what happens on success is the caller's choice
 * via {@link AuthScreenProps.onAuthed} (session persistence + resume-at-step
 * routing land in ARC-96).
 */
interface AuthScreenProps {
	/** Called with the live session once sign in / sign up succeeds. */
	onAuthed: (session: Session) => void;
}

export function AuthScreen({ onAuthed }: AuthScreenProps) {
	const [mode, setMode] = useState<Mode>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const emailId = useId();
	const passwordId = useId();
	const isSignin = mode === "signin";

	const submit = useCallback(
		(e: FormEvent) => {
			e.preventDefault();
			if (busy) return;
			setError(null);
			setNotice(null);

			if (!email.trim() || !password) {
				setError("Enter an email and password.");
				return;
			}

			setBusy(true);
			const run = async () => {
				if (mode === "signin") {
					onAuthed(await signIn(email.trim(), password));
					return;
				}
				const { session } = await signUp(email.trim(), password);
				if (session) {
					onAuthed(session);
				} else {
					setNotice(
						"Account created — check your email to confirm, then sign in.",
					);
					setMode("signin");
				}
			};
			run()
				.catch((err: unknown) => {
					setError(
						err instanceof AuthError ? err.message : "Something went wrong.",
					);
				})
				.finally(() => setBusy(false));
		},
		[busy, email, password, mode, onAuthed],
	);

	const toggleMode = useCallback(() => {
		setMode((prev) => (prev === "signin" ? "signup" : "signin"));
		setError(null);
		setNotice(null);
	}, []);

	return (
		<div className="flex min-h-[70vh] items-center justify-center">
			<form
				data-testid="auth-form"
				onSubmit={submit}
				noValidate
				className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-[0_24px_64px_rgba(0,0,0,0.45)] backdrop-blur-sm"
			>
				<h1 className="font-heading text-2xl font-bold tracking-tight">
					{isSignin ? "Welcome back" : "Create account"}
				</h1>
				<p className="mt-1.5 text-sm text-muted-foreground">
					{isSignin ? "Sign in to continue" : "Sign up to get started"}
				</p>

				<div className="mt-7 grid gap-2">
					<Label htmlFor={emailId}>Email</Label>
					<Input
						id={emailId}
						type="email"
						autoComplete="email"
						placeholder="you@example.com"
						value={email}
						aria-invalid={Boolean(error)}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</div>

				<div className="mt-4 grid gap-2">
					<Label htmlFor={passwordId}>Password</Label>
					<Input
						id={passwordId}
						type="password"
						autoComplete={isSignin ? "current-password" : "new-password"}
						placeholder="••••••••"
						value={password}
						aria-invalid={Boolean(error)}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</div>

				{error ? (
					<p role="alert" className="mt-4 text-sm text-destructive">
						{error}
					</p>
				) : null}
				{notice ? (
					<output className="mt-4 block text-sm text-brand">{notice}</output>
				) : null}

				<Button
					type="submit"
					variant="brand"
					size="lg"
					disabled={busy}
					className="mt-6 w-full rounded-xl"
				>
					{busy ? "Please wait…" : isSignin ? "Sign in" : "Sign up"}
				</Button>

				<button
					type="button"
					onClick={toggleMode}
					className="mt-5 block w-full text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
				>
					{isSignin
						? "Don't have an account? Sign up"
						: "Already have an account? Sign in"}
				</button>
			</form>
		</div>
	);
}
