import {
  advanceCandidaciesToCoverLetter,
  companyHasShortlistedCandidacy,
  createNotification,
  type Db,
  type Enums,
  failActivity,
  failCompanyEnrichment,
  getCompany,
  saveCompanyEnrichment,
  setCompanyStatus,
  startActivity,
  succeedActivity,
  upsertContacts,
} from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, readJsonFixture, run } from "../context.js";

/** One person found at a company (phone omitted — the contacts schema omits it). */
export interface FoundContact {
  fullName: string;
  email?: string | null;
  linkedinUrl?: string | null;
  roleTitle?: string | null;
}

/** What the (stubbed) Researcher gathers for a company: the fields the schema
 *  promotes to columns, the people it found, and the raw tool-output blob. */
export interface EnrichmentResult {
  websiteUrl?: string | null;
  recruitmentEmail?: string | null;
  description?: string | null;
  linkedinUrl?: string | null;
  domain?: string | null;
  contacts: FoundContact[];
  /** Raw provider output, persisted whole into companies.enrichment for provenance. */
  source: Record<string, unknown>;
}

/** The company context the Researcher enriches against. */
export interface EnrichContext {
  company: { id: string; name: string; domain: string | null; websiteUrl: string | null };
  log: (msg: string) => void;
}

/**
 * The Researcher brain: gather company data via LinkedIn MCP + Firecrawl. The real
 * implementation drops those tool calls in here; the default `stubEnricher` is a
 * deterministic, network-free stand-in so the whole enrich loop runs (and is tested)
 * with no live MCP. Mockable seam: pass your own `Enricher` to `runEnrich`.
 */
export type Enricher = (ctx: EnrichContext) => EnrichmentResult | Promise<EnrichmentResult>;

/** A url-safe slug of a company name — the key the stub derives a domain from. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company"
  );
}

/**
 * A deterministic, network-free stand-in for the LinkedIn MCP + Firecrawl tools. It
 * derives a plausible domain (preferring any the company already has), a recruitment
 * email, a website, a LinkedIn URL, and one talent contact — enough to exercise the
 * whole enrich orchestration and its writes. Swap in a real provider via `runEnrich`.
 */
export const stubEnricher: Enricher = ({ company }) => {
  const slug = slugify(company.name);
  const domain = company.domain ?? `${slug}.example.com`;
  return {
    websiteUrl: company.websiteUrl ?? `https://${domain}`,
    recruitmentEmail: `careers@${domain}`,
    description: `${company.name} — enriched by the Researcher stub (no live MCP).`,
    linkedinUrl: `https://www.linkedin.com/company/${slug}`,
    domain,
    contacts: [
      {
        fullName: `${company.name} Talent`,
        email: `talent@${domain}`,
        linkedinUrl: `https://www.linkedin.com/in/${slug}-talent`,
        roleTitle: "Talent Acquisition",
      },
    ],
    source: { provider: "stub", linkedin: "stub", firecrawl: "stub" },
  };
};

/** The structured detail an enrich run records on its Activity and prints. */
export interface EnrichSummary {
  companyId: string;
  company: string;
  status: Enums<"company_status">;
  /** true when the company was already enriched and the run was a no-op (no Activity). */
  skipped: boolean;
  contactsFound: number;
  /** Candidacies advanced shortlisted/alternative_outreach → awaiting_cover_letter
   *  by the enrichment gate (ARC-35) — the hand-off into Applications & Cover Letters. */
  candidaciesAdvanced: number;
  /** The enrich Activity's id, or null when the run was a skipped no-op. */
  activityId: string | null;
}

/**
 * Enrich one company: gather its data through the (stubbed) Researcher tools and
 * persist it, wrapping the work in a single `enrich` Activity (in_progress→
 * succeeded/failed). The company moves new|… → researching while the run is open,
 * then → enriched on success or → enrichment_failed (with the reason) on failure.
 * Idempotent: an already-`enriched` company is a no-op that opens NO Activity, unless
 * `force` is set. Gated to the shortlist: a company with no `shortlisted`/
 * `alternative_outreach` candidacy behind it is refused (fail-closed precondition,
 * no Activity opened) so enrichment never runs on dismissed or never-matched
 * companies. The LinkedIn MCP + Firecrawl calls are a mockable seam — pass your own
 * `enrich` to swap the stub for a real provider.
 */
export async function runEnrich(
  db: Db,
  args: { companyId: string; userId?: string | null; force?: boolean; enrich?: Enricher },
): Promise<EnrichSummary> {
  const enrich = args.enrich ?? stubEnricher;
  const company = await getCompany(db, args.companyId);
  if (!company) throw new CliError(`unknown company: ${args.companyId}`);

  // Idempotent: skip an already-enriched company (no Activity opened) unless forced.
  if (company.status === "enriched" && !args.force) {
    return {
      companyId: company.id,
      company: company.name,
      status: company.status,
      skipped: true,
      contactsFound: 0,
      candidaciesAdvanced: 0,
      activityId: null,
    };
  }

  // Shortlist gate: only research companies a candidacy actually shortlisted. A
  // precondition guard like the unknown-company check — refused before any status
  // change or Activity, so no wasted enrichment of dismissed/never-matched companies.
  if (!(await companyHasShortlistedCandidacy(db, company.id))) {
    throw new CliError(
      `enrichment is gated to shortlisted companies: ${company.name} has no shortlisted candidacy`,
    );
  }

  // Open the Activity FIRST, then move the company in-flight INSIDE the try (ARC-58
  // M4): a throw from startActivity leaves the company un-moved (nothing stranded),
  // and any later throw lands in the catch that records the failed Activity.
  const activity = await startActivity(db, {
    type: "enrich",
    userId: args.userId ?? null,
    companyId: company.id,
    detail: { company: company.name },
  });
  try {
    await setCompanyStatus(db, company.id, "researching");
    const result = await enrich({
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        websiteUrl: company.website_url,
      },
      log: (m) => console.error(m),
    });
    await saveCompanyEnrichment(db, company.id, {
      websiteUrl: result.websiteUrl ?? null,
      recruitmentEmail: result.recruitmentEmail ?? null,
      description: result.description ?? null,
      linkedinUrl: result.linkedinUrl ?? null,
      domain: result.domain ?? null,
      // The whole tool output (incl. the contacts it found) lands in the enrichment
      // jsonb for provenance.
      detail: { ...result.source, contacts: result.contacts },
    });
    // Promote the found people into the dedicated contacts table (idempotent: a
    // re-enriched company adds no duplicate rows). The jsonb above keeps provenance.
    await upsertContacts(db, company.id, result.contacts);
    await setCompanyStatus(db, company.id, "enriched");
    // Candidacy gate (ARC-35): the company is now enriched, so advance every
    // shortlisted / alternative_outreach candidacy behind it to awaiting_cover_letter
    // and push each owner a notification — the hand-off that unblocks Applications &
    // Cover Letters. Idempotent: only those two statuses move, so a forced re-enrich
    // (whose candidacies are already advanced) advances none.
    const advanced = await advanceCandidaciesToCoverLetter(db, company.id);
    for (const c of advanced) {
      await createNotification(db, {
        userId: c.user_id,
        kind: "candidacy",
        title: "A role is ready for your cover letter",
        body: `${company.name} is researched — "${c.posting_title}" is awaiting a cover letter.`,
        ref: { candidacyId: c.id, companyId: company.id, status: "awaiting_cover_letter" },
      });
    }
    await succeedActivity(db, activity.id, {
      company: company.name,
      contactsFound: result.contacts.length,
      candidaciesAdvanced: advanced.length,
    });
    return {
      companyId: company.id,
      company: company.name,
      status: "enriched",
      skipped: false,
      contactsFound: result.contacts.length,
      candidaciesAdvanced: advanced.length,
      activityId: activity.id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failCompanyEnrichment(db, company.id, msg);
    await failActivity(db, activity.id, msg);
    throw err;
  }
}

interface EnrichOpts {
  fixture?: string;
  force?: boolean;
}

export function registerEnrich(program: Command): void {
  program
    .command("enrich")
    .description(
      "Enrich a company via the (stubbed) Researcher — website, recruitment email, contacts",
    )
    .argument("<company>", "company id (uuid)")
    .option(
      "--fixture <path>",
      "read an EnrichmentResult from a JSON file instead of the tools (dev/testing)",
    )
    .option("--force", "re-enrich even if the company is already enriched")
    .action(async (companyId: string, opts: EnrichOpts, cmd) => {
      await run(cmd.optsWithGlobals() as GlobalOpts, async (ctx) => {
        let enrich: Enricher | undefined;
        if (opts.fixture) {
          const path = opts.fixture;
          enrich = () => readJsonFixture<EnrichmentResult>(path, "--fixture");
        }
        const summary = await runEnrich(ctx.db, {
          companyId,
          userId: ctx.userId,
          force: opts.force,
          enrich,
        });
        output(ctx, summary, (s) =>
          console.log(
            s.skipped
              ? `enrich: ${s.company} already enriched (no-op)`
              : `enrich: ${s.company} → ${s.status}, ${s.contactsFound} contact(s), ${s.candidaciesAdvanced} candidacy(ies) → awaiting_cover_letter`,
          ),
        );
      });
    });
}
