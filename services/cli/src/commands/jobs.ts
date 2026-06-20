import { type Enums, getCandidacy, listCandidacies, setCandidacyStatus } from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, requireUser, run } from "../context.js";

type CStatus = Enums<"candidacy_status">;
const CANDIDACY_STATUSES: readonly string[] = [
  "new",
  "dismissed",
  "shortlisted",
  "alternative_outreach",
  "awaiting_cover_letter",
  "drafting",
  "in_review",
  "approved",
  "applying",
  "applied",
  "external_pending",
  "application_failed",
];

export function registerJobs(program: Command): void {
  const jobs = program
    .command("jobs")
    .description("Browse and move candidacies through the kanban");

  jobs
    .command("list")
    .description("List candidacies for the user")
    .option("--status <status>", "filter by candidacy status")
    .action(async (opts: { status?: string }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        if (opts.status && !CANDIDACY_STATUSES.includes(opts.status)) {
          throw new CliError(`--status must be one of ${CANDIDACY_STATUSES.join(", ")}`);
        }
        const rows = await listCandidacies(ctx.db, requireUser(ctx), {
          status: opts.status as CStatus | undefined,
        });
        output(ctx, rows, (cs) => {
          for (const c of cs) {
            const at = c.company_name ? `  @ ${c.company_name}` : "";
            const score = c.match_score == null ? "    " : `${c.match_score}`.padStart(3) + " ";
            console.log(
              `${c.id}  ${score} ${c.status.padEnd(20)} ${c.board_slug.padEnd(14)} ${c.posting_title}${at}`,
            );
          }
        });
      });
    });

  jobs
    .command("show")
    .description("Show one candidacy")
    .argument("<id>", "candidacy id")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const c = await getCandidacy(ctx.db, id);
        if (!c) throw new CliError(`unknown candidacy: ${id}`);
        output(ctx, c, (x) => console.log(JSON.stringify(x, null, 2)));
      });
    });

  jobs
    .command("shortlist")
    .description("Shortlist a candidacy (triage decision: shortlisted)")
    .argument("<id>", "candidacy id")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const c = await setCandidacyStatus(ctx.db, id, "shortlisted", {
          triageDecision: "shortlisted",
        });
        if (!c) throw new CliError(`unknown candidacy: ${id}`);
        output(ctx, c, (x) => console.log(`${x.id}: ${x.status}`));
      });
    });

  jobs
    .command("dismiss")
    .description("Dismiss a candidacy with a reason")
    .argument("<id>", "candidacy id")
    .option("--reason <reason>", "why it was dismissed")
    .action(async (id: string, opts: { reason?: string }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const c = await setCandidacyStatus(ctx.db, id, "dismissed", {
          triageDecision: "dismissed",
          reason: opts.reason,
        });
        if (!c) throw new CliError(`unknown candidacy: ${id}`);
        output(ctx, c, (x) =>
          console.log(`${x.id}: ${x.status}${opts.reason ? ` (${opts.reason})` : ""}`),
        );
      });
    });

  jobs
    .command("status")
    .description("Set a candidacy's status directly")
    .argument("<id>", "candidacy id")
    .argument("<newStatus>", `one of: ${CANDIDACY_STATUSES.join(", ")}`)
    .action(async (id: string, newStatus: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        if (!CANDIDACY_STATUSES.includes(newStatus)) {
          throw new CliError(`status must be one of ${CANDIDACY_STATUSES.join(", ")}`);
        }
        const c = await setCandidacyStatus(ctx.db, id, newStatus as CStatus);
        if (!c) throw new CliError(`unknown candidacy: ${id}`);
        output(ctx, c, (x) => console.log(`${x.id}: ${x.status}`));
      });
    });
}
