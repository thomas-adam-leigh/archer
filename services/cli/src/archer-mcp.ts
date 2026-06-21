import {
  type Db,
  type ExternalFormStatus,
  getActiveCoverLetterVersion,
  getCandidacyCompany,
  getProfile,
  listPortfolioProjects,
  setExternalApplicationFormStatus,
} from "@archer/db";

/**
 * THE ARCHER MCP — the least-privilege, server-side tool surface the external-fill
 * agent uses (ARC-41). When the board redirects an application off-site, the
 * external-fill agent must read just enough of the candidate to complete the form
 * (their profile, portfolio, the approved cover letter, the enriched company) and
 * write back the external form's status. That bounded surface is defined here.
 *
 * "Least-privilege" is structural, not a convention: a surface is constructed for
 * ONE candidacy/user/form (the scope), and every tool can only touch that scope —
 * a handler never takes a candidacy/user/form id as an argument, so the agent can
 * neither read another candidate's data nor write another candidacy's form. The
 * read tools are pure DB reads; the one write tool advances only the scoped form.
 *
 * This is the build_now Archer MCP: an in-process, typed tool surface backed by
 * @archer/db. The Chrome-DevTools browser automation that actually fills the form
 * is the stubbed seam (see commands/external-fill.ts) — it lives outside this
 * surface; the surface is only the read/write capabilities that work needs.
 */

/** A minimal JSON-Schema descriptor for a tool's input — the typed contract a
 *  real MCP transport would advertise (object with typed, optionally-required
 *  properties). The read tools take no input; the write tool is described below. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; enum?: readonly string[]; description?: string }>;
  required?: readonly string[];
  additionalProperties: false;
}

/** One Archer MCP tool: a name, a human description, its typed input schema, and
 *  the handler that runs it against the scoped candidate data. */
export interface ArcherMcpTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (input: I) => Promise<O>;
}

/** The one candidacy/user/form a surface is bound to — its privilege boundary. */
export interface ArcherMcpScope {
  db: Db;
  candidacyId: string;
  userId: string;
  /** The open external_application_form the write tool advances. */
  formId: string;
}

/** The candidate's profile, or null when none exists yet. */
export interface ProfileRead {
  about: string | null;
  location: string | null;
  resumeUrl: string | null;
  portfolioUrl: string | null;
  linkedinUrl: string | null;
  yearsExperience: number | null;
}

/** The candidate's portfolio: their links + the projects on the live profile. */
export interface PortfolioRead {
  portfolioUrl: string | null;
  projects: { name: string; role: string | null; url: string | null; description: string | null }[];
}

/** The approved cover letter the external form is filled from. */
export interface CoverLetterRead {
  versionId: string;
  label: string | null;
  content: string;
}

/** The enriched company behind the candidacy. */
export interface CompanyRead {
  name: string;
  websiteUrl: string | null;
  recruitmentEmail: string | null;
  description: string | null;
  enrichment: unknown;
}

/** Input for the one write tool: advance the scoped external form's status. */
export interface UpdateExternalStatusInput {
  status: Extract<ExternalFormStatus, "in_progress" | "completed" | "failed">;
  detail?: Record<string, unknown>;
  error?: string | null;
}

const NO_INPUT: ToolInputSchema = { type: "object", properties: {}, additionalProperties: false };

/** The Archer MCP surface: the named tools, plus a typed `call` dispatcher that
 *  validates the tool name (and the one write tool's status) before running it. */
export interface ArcherMcp {
  tools: ArcherMcpTool[];
  read_profile: () => Promise<ProfileRead | null>;
  read_portfolio: () => Promise<PortfolioRead>;
  read_cover_letter: () => Promise<CoverLetterRead | null>;
  read_enriched_company: () => Promise<CompanyRead | null>;
  update_external_status: (input: UpdateExternalStatusInput) => Promise<{ status: string }>;
  call: (name: string, input?: unknown) => Promise<unknown>;
}

const WRITE_STATUSES = ["in_progress", "completed", "failed"] as const;

/**
 * Build the Archer MCP surface scoped to one candidacy/user/form. Every tool is a
 * closure over the scope, so the surface is the agent's whole privilege boundary —
 * it can read this candidate and write this form, nothing else.
 */
export function createArcherMcp(scope: ArcherMcpScope): ArcherMcp {
  const { db, candidacyId, userId, formId } = scope;

  const read_profile = async (): Promise<ProfileRead | null> => {
    const p = await getProfile(db, userId);
    if (!p) return null;
    return {
      about: p.about,
      location: p.location,
      resumeUrl: p.resume_url,
      portfolioUrl: p.portfolio_url,
      linkedinUrl: p.linkedin_url,
      yearsExperience: p.years_experience,
    };
  };

  const read_portfolio = async (): Promise<PortfolioRead> => {
    const p = await getProfile(db, userId);
    const projects = await listPortfolioProjects(db, userId);
    return {
      portfolioUrl: p?.portfolio_url ?? null,
      projects: projects.map((pr) => ({
        name: pr.name,
        role: pr.role,
        url: pr.url,
        description: pr.description,
      })),
    };
  };

  const read_cover_letter = async (): Promise<CoverLetterRead | null> => {
    const v = await getActiveCoverLetterVersion(db, candidacyId);
    if (!v) return null;
    return { versionId: v.id, label: v.label, content: v.content };
  };

  const read_enriched_company = async (): Promise<CompanyRead | null> => {
    const co = await getCandidacyCompany(db, candidacyId);
    if (!co) return null;
    return {
      name: co.name,
      websiteUrl: co.website_url,
      recruitmentEmail: co.recruitment_email,
      description: co.description,
      enrichment: co.enrichment,
    };
  };

  const update_external_status = async (
    input: UpdateExternalStatusInput,
  ): Promise<{ status: string }> => {
    if (!WRITE_STATUSES.includes(input.status)) {
      throw new Error(`update_external_status: invalid status '${input.status}'`);
    }
    await setExternalApplicationFormStatus(db, formId, input.status, {
      detail: (input.detail ?? {}) as never,
      error: input.error ?? null,
    });
    return { status: input.status };
  };

  const tools: ArcherMcpTool[] = [
    {
      name: "read_profile",
      description: "Read the candidate's profile (about, location, links, experience).",
      inputSchema: NO_INPUT,
      handler: read_profile,
    },
    {
      name: "read_portfolio",
      description: "Read the candidate's portfolio URL and the projects on their live profile.",
      inputSchema: NO_INPUT,
      handler: read_portfolio,
    },
    {
      name: "read_cover_letter",
      description: "Read the approved cover letter the external form is filled from.",
      inputSchema: NO_INPUT,
      handler: read_cover_letter,
    },
    {
      name: "read_enriched_company",
      description: "Read the enriched company behind this candidacy.",
      inputSchema: NO_INPUT,
      handler: read_enriched_company,
    },
    {
      name: "update_external_status",
      description: "Advance this candidacy's external application form status.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: WRITE_STATUSES, description: "The new form status." },
          detail: { type: "object", description: "Structured detail to merge onto the form." },
          error: { type: "string", description: "Failure reason (on failed)." },
        },
        required: ["status"],
        additionalProperties: false,
      },
      handler: (input) => update_external_status(input as UpdateExternalStatusInput),
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  const call = async (name: string, input?: unknown): Promise<unknown> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`unknown Archer MCP tool: ${name}`);
    return await tool.handler(input);
  };

  return {
    tools,
    read_profile,
    read_portfolio,
    read_cover_letter,
    read_enriched_company,
    update_external_status,
    call,
  };
}
