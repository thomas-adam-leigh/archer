import { getProfile, type ProfilePatch, upsertProfile } from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, requireUser, run } from "../context.js";

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
}
