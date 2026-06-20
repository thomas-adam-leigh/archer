import { readFileSync } from "node:fs";
import {
  type Db,
  type Enums,
  failActivity,
  failCompanyEnrichment,
  getCompany,
  saveCompanyEnrichment,
  setCompanyStatus,
  startActivity,
  succeedActivity,
} from "@archer/db";
import type { Command } from "commander";
import { CliError, type GlobalOpts, output, run } from "../context.js";

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
  /** The enrich Activity's id, or null when the run was a skipped no-op. */
  activityId: string | null;
}

/**
 * Enrich one company: gather its data through the (stubbed) Researcher tools and
 * persist it, wrapping the work in a single `enrich` Activity (in_progress→
 * succeeded/failed). The company moves new|… → researching while the run is open,
 * then → enriched on success or → enrichment_failed (with the reason) on failure.
 * Idempotent: an already-`enriched` company is a no-op that opens NO Activity, unless
 * `force` is set. The LinkedIn MCP + Firecrawl calls are a mockable seam — pass your
 * own `enrich` to swap the stub for a real provider.
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
      activityId: null,
    };
  }

  await setCompanyStatus(db, company.id, "researching");
  const activity = await startActivity(db, {
    type: "enrich",
    userId: args.userId ?? null,
    companyId: company.id,
    detail: { company: company.name },
  });
  try {
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
      // jsonb for provenance; promoting contacts into the contacts table is a later
      // milestone (Contacts + companies.enrichment write surface).
      detail: { ...result.source, contacts: result.contacts },
    });
    await setCompanyStatus(db, company.id, "enriched");
    await succeedActivity(db, activity.id, {
      company: company.name,
      contactsFound: result.contacts.length,
    });
    return {
      companyId: company.id,
      company: company.name,
      status: "enriched",
      skipped: false,
      contactsFound: result.contacts.length,
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
          enrich = () => JSON.parse(readFileSync(path, "utf8")) as EnrichmentResult;
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
              : `enrich: ${s.company} → ${s.status}, ${s.contactsFound} contact(s)`,
          ),
        );
      });
    });
}
