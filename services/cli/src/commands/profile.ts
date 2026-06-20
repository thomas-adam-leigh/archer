import {
  applyVersionProposal,
  createProfileVersion,
  getProfile,
  getProfileVersion,
  type Json,
  listProfileVersions,
  type ProfilePatch,
  rollbackToVersion,
  submitVersionProposal,
  upsertProfile,
  type VersionDecision,
} from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, requireUser, run } from "../context.js";

/** Parse a JSON string CLI flag into attributes, or undefined when absent. */
function parseJsonFlag(s: string | undefined, flag: string): Json | undefined {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s) as Json;
  } catch {
    throw new CliError(`${flag} must be valid JSON`);
  }
}

// Whitelisted settable fields + how to coerce the CLI string value.
const FIELDS = {
  about: "text",
  location: "text",
  current_salary: "text",
  preferred_salary: "text",
  notice_period: "text",
  resume_url: "text",
  resume_text: "text",
  portfolio_url: "text",
  linkedin_url: "text",
  work_pref: "enum",
  willing_remote: "bool",
  years_experience: "int",
} as const;
type Field = keyof typeof FIELDS;
const WORK_PREF: readonly string[] = ["remote", "hybrid", "office", "unknown"];

export function registerProfile(program: Command): void {
  const profile = program.command("profile").description("View and edit the candidate profile");

  profile
    .command("show")
    .description("Show the profile")
    .action(async (_opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const p = await getProfile(ctx.db, requireUser(ctx));
        output(ctx, p ?? null, (x) =>
          console.log(x ? JSON.stringify(x, null, 2) : "(no profile yet)"),
        );
      });
    });

  profile
    .command("set")
    .description("Set a profile field")
    .argument("<field>", `one of: ${Object.keys(FIELDS).join(", ")}`)
    .argument("<value>", "new value")
    .action(async (field: string, value: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        if (!(field in FIELDS)) {
          throw new CliError(`unknown field '${field}'. one of: ${Object.keys(FIELDS).join(", ")}`);
        }
        const kind = FIELDS[field as Field];
        let coerced: string | number | boolean = value;
        if (kind === "int") {
          coerced = Number.parseInt(value, 10);
          if (Number.isNaN(coerced)) throw new CliError(`${field} must be an integer`);
        } else if (kind === "bool") {
          if (value !== "true" && value !== "false") {
            throw new CliError(`${field} must be true or false`);
          }
          coerced = value === "true";
        } else if (kind === "enum" && !WORK_PREF.includes(value)) {
          throw new CliError(`${field} must be one of ${WORK_PREF.join(", ")}`);
        }
        const patch = { [field]: coerced } as ProfilePatch;
        const p = await upsertProfile(ctx.db, requireUser(ctx), patch);
        output(ctx, p, () => console.log(`set ${field} = ${String(coerced)}`));
      });
    });

  // ── profile versions: the version history + draft/submit/decide/rollback ──
  const versions = profile
    .command("versions")
    .description("Manage profile versions (history, draft, submit, approve, rollback)");

  versions
    .command("list")
    .description("List the profile version history")
    .action(async (_opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const rows = await listProfileVersions(ctx.db, requireUser(ctx));
        output(ctx, rows, (vs) => {
          for (const v of vs) {
            const live = v.status === "approved" ? "●" : " ";
            console.log(
              `${v.id}  ${live} v${v.version_no} [${v.status}] ${v.label ?? ""}`.trimEnd(),
            );
          }
        });
      });
    });

  versions
    .command("show")
    .description("Show a single profile version")
    .argument("<id>", "profile-version id")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const v = await getProfileVersion(ctx.db, requireUser(ctx), id);
        output(ctx, v ?? null, (x) =>
          console.log(x ? JSON.stringify(x, null, 2) : "(no such version)"),
        );
      });
    });

  versions
    .command("draft")
    .description("Create a new draft version")
    .option("--label <label>", "human label for the version")
    .option("--attributes <json>", "profile-wide attributes as a JSON object")
    .action(async (opts: { label?: string; attributes?: string }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const attributes = parseJsonFlag(opts.attributes, "--attributes");
        const v = await createProfileVersion(ctx.db, {
          userId: requireUser(ctx),
          label: opts.label,
          attributes,
        });
        output(ctx, v, (x) => console.log(`drafted ${x.id} (v${x.version_no})`));
      });
    });

  versions
    .command("submit")
    .description("Submit a draft version for approval")
    .argument("<id>", "profile-version id")
    .option("--title <title>", "proposal title shown to the reviewer")
    .action(async (id: string, opts: { title?: string }, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const proposal = await submitVersionProposal(ctx.db, {
          userId: requireUser(ctx),
          versionId: id,
          title: opts.title ?? "Approve your profile",
        });
        output(ctx, { versionId: id, proposalId: proposal.id }, (x) =>
          console.log(`submitted ${x.versionId} as proposal ${x.proposalId}`),
        );
      });
    });

  versions
    .command("decide")
    .description("Approve (optionally with edits) or reject a version proposal")
    .argument("<proposalId>", "version proposal id")
    .requiredOption("--action <action>", "approve | reject")
    .option("--note <note>", "decision note")
    .option("--attributes <json>", "approve-with-edits: replacement attributes (JSON object)")
    .option("--label <label>", "approve-with-edits: replacement label")
    .action(
      async (
        proposalId: string,
        opts: { action: string; note?: string; attributes?: string; label?: string },
        cmd,
      ) => {
        await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
          if (opts.action !== "approve" && opts.action !== "reject") {
            throw new CliError("--action must be approve or reject");
          }
          let decision: VersionDecision;
          if (opts.action === "approve") {
            const attributes = parseJsonFlag(opts.attributes, "--attributes");
            const edits =
              attributes !== undefined || opts.label !== undefined
                ? { attributes, label: opts.label }
                : undefined;
            decision = { action: "approve", edits, note: opts.note };
          } else {
            decision = { action: "reject", note: opts.note };
          }
          const result = await applyVersionProposal(ctx.db, proposalId, decision);
          output(ctx, result, (r) =>
            console.log(`proposal ${r.proposalStatus}; version ${r.versionStatus ?? "gone"}`),
          );
        });
      },
    );

  versions
    .command("rollback")
    .description("Cycle the live profile back to an earlier version")
    .argument("<id>", "profile-version id to make live")
    .action(async (id: string, _opts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        const result = await rollbackToVersion(ctx.db, requireUser(ctx), id);
        if (result.error) throw new CliError(result.error);
        output(ctx, result, (r) =>
          console.log(`rolled back to ${r.versionId} (${r.versionStatus})`),
        );
      });
    });
}
