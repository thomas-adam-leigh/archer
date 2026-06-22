import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
			<h1 className="max-w-2xl font-heading text-5xl font-bold leading-[1.05] text-balance">
				Never apply for a job <span className="text-brand">on your own</span>{" "}
				again.
			</h1>
			<p className="mt-6 max-w-md text-lg leading-relaxed text-muted-foreground">
				Archer reads your résumé, learns what you want, and hunts for roles so
				you don't have to.
			</p>
			<Button variant="brand" size="lg" className="mt-10 rounded-xl px-7">
				Get started
			</Button>
		</div>
	);
}
