import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionProposal,
  createProfileVersion,
  readProfileSpine,
  submitVersionProposal,
  writeProfileSpine,
} from "./queries.js";

// ARC-136 (M10 · Onboarding finalization) — the capstone completeness check.
//
// The per-field materialisation is proven piecemeal in profile-version-apply.test.ts
// (ARC-130/131/132) and the ordering writer in queries.ts (ARC-134). This test is the
// holistic guard: it drives ONE onboarding-shaped version — rich attributes + résumé
// details + a multi-row spine — through the real submit → approve round trip and then
// asserts the WHOLE class of typed columns is populated together (no silent NULLs) and
// the spine reads back in explicit `position` order. It's the regression net for the
// NULL-columns class the milestone closed.
//
// The apply executor is path-agnostic — both onboarding paths (résumé ingest and
// start-from-scratch) converge on a proposed profile_version and approve through this
// exact seam — so this single assertion covers both paths at the contract level. The
// browser-side résumé journey is covered by cypress/e2e/profile-completeness.cy.ts.
//
// Targets the same migrated Postgres as packages/db/scripts/gen-types.sh builds. Point
// TEST_DATABASE_URL at it to run (`pnpm --filter @archer/db test` with it set);
// skipped otherwise so the default no-DB CI vitest run stays green.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// One synthetic signup. UUID is fixed + namespaced (…036, after ARC-136) so reruns
// are idempotent and never collide with the …027 user in profile-version-apply.test.ts.
const userId = "cccccccc-0000-4000-8000-000000000036";

// The durable signed résumé URL minted at ingest (ARC-131), carried on the version's
// `details` and materialised onto profiles.resume_url at approval.
const resumeUrl = "https://proj.supabase.co/storage/v1/object/sign/resumes/uid/cv.pdf?token=xyz";

describe.skipIf(!TEST_DB_URL)("onboarding profile completeness (ARC-136)", () => {
  let sql: postgres.Sql;

  const cleanup = async (db: postgres.Sql) => {
    // public.users cascades to profiles, profile_versions, and the spine rows.
    await db`delete from public.proposals where plan->>'userId' = ${userId}`;
    await db`delete from public.users where id = ${userId}`;
    await db`delete from auth.users where id = ${userId}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { prepare: false, max: 1 });
  });

  beforeEach(async () => {
    await cleanup(sql);
    // Signup fires on_auth_user_created → public.users (+ first thread).
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}, 'complete@example.com', ${sql.json({ full_name: "Robin" })})`;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  /**
   * Build, submit, and approve one complete onboarding-shaped version. The work
   * experiences are written OLDEST-first (position 0 = the 2016 role, position 1 =
   * the 2022 role) — the inverse of the reader's start_date-desc tiebreak — so the
   * ordering assertion proves `position` wins, not the date fallback (ARC-134).
   */
  const approveCompleteProfile = async () => {
    const version = await createProfileVersion(sql, {
      userId,
      label: "Onboarding draft",
      attributes: {
        summary: "Pragmatic staff engineer who ships accessible web apps.",
        location: "Cape Town, ZA",
        years_experience: 9,
        links: {
          linkedin: "https://linkedin.com/in/robin",
          website: "https://robin.dev",
          github: "https://github.com/robin",
        },
      },
      details: {
        resumeText: "Robin — full résumé text extracted at ingest.",
        storageRef: "resumes/uid/cv.pdf",
        resumeUrl,
      },
    });

    await writeProfileSpine(sql, userId, version.id, {
      workExperiences: [
        {
          title: "Junior Engineer",
          organization: "Brightwave",
          startDate: "2016-01",
          endDate: "2021-12",
          isCurrent: false,
        },
        {
          title: "Staff Engineer",
          organization: "Northwind Labs",
          startDate: "2022-01",
          isCurrent: true,
        },
      ],
      education: [{ institution: "UCT", degree: "BSc", fieldOfStudy: "Computer Science" }],
      skills: [{ name: "TypeScript", proficiency: "Expert" }],
      certifications: [{ name: "CPACC", issuer: "IAAP", issuedOn: "2022-05" }],
      courses: [{ name: "Advanced React", provider: "Frontend Masters", completedOn: "2023-02" }],
    });

    const { id: proposalId } = await submitVersionProposal(sql, {
      userId,
      versionId: version.id,
      title: "Approve onboarding profile",
    });
    const result = await applyVersionProposal(sql, proposalId, { action: "approve" });
    expect(result.proposalStatus).toBe("completed");
    return version.id;
  };

  it("materialises every implemented typed column on approval (no silent NULLs)", async () => {
    await approveCompleteProfile();

    const rows = await sql<
      {
        about: string | null;
        location: string | null;
        linkedin_url: string | null;
        portfolio_url: string | null;
        resume_text: string | null;
        resume_url: string | null;
        years_experience: number | null;
      }[]
    >`
      select about, location, linkedin_url, portfolio_url, resume_text, resume_url, years_experience
      from profiles where user_id = ${userId}`;
    const profile = rows[0];

    // The whole class, exact: a faithful projection of the approved version.
    expect(profile).toEqual({
      about: "Pragmatic staff engineer who ships accessible web apps.",
      location: "Cape Town, ZA",
      linkedin_url: "https://linkedin.com/in/robin",
      portfolio_url: "https://robin.dev",
      resume_text: "Robin — full résumé text extracted at ingest.",
      resume_url: resumeUrl,
      years_experience: 9,
    });

    // The explicit "no silent NULLs for implemented fields" guard — the regression
    // this milestone exists to prevent. Fails loudly naming any column that drifts null.
    for (const [column, value] of Object.entries(profile)) {
      expect(value, `profiles.${column} must be materialised, not null`).not.toBeNull();
    }
  });

  it("reads the approved spine back in explicit position order (ARC-134)", async () => {
    const versionId = await approveCompleteProfile();

    const spine = await readProfileSpine(sql, userId, versionId);

    // Written oldest-first; position must win over the start_date-desc tiebreak, so
    // the 2016 role reads back BEFORE the 2022 one despite being older.
    expect(spine.workExperiences?.map((w) => w.title)).toEqual([
      "Junior Engineer",
      "Staff Engineer",
    ]);

    // The rest of the spine survives the round trip (completeness, not just ordering).
    expect(spine.education?.[0]?.institution).toBe("UCT");
    expect(spine.skills?.[0]?.name).toBe("TypeScript");
    expect(spine.certifications?.[0]?.name).toBe("CPACC");
    expect(spine.courses?.[0]?.name).toBe("Advanced React");
  });
});
