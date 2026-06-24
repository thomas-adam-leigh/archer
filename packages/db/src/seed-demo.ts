// Owner-only demo seed (ARC-162). Populates a single owner's account with a small,
// realistic, clearly-labelled fixture pipeline so the *real* dashboard (not just
// Cypress mocks) renders populated home / jobs / companies / cover-letters states
// before live scraping is wired up. It is a hand-run CLI step (`archer seed:demo`),
// never auto-run anywhere, and fully removable (`seed:demo --clear`).
//
// Every demo row carries a marker so the seed is idempotent and reversible without
// touching real data: demo postings live under the `demo.archer.local` URL host,
// demo companies are name-prefixed `Demo · `, and demo activities carry
// `detail.seed = 'demo'`. clearDemo keys off exactly these markers.
import type { Db } from "./client.js";

/** URL host every demo posting lives under — the removable marker for postings. */
export const DEMO_URL_HOST = "demo.archer.local";
/** Name prefix on every demo company — the removable marker for companies. */
export const DEMO_COMPANY_PREFIX = "Demo · ";
/** `detail.seed` value stamped on every demo activity (and the demo cover letter). */
export const SEED_MARKER = "demo";

export interface SeedDemoSummary {
  companies: number;
  contacts: number;
  postings: number;
  candidacies: number;
  coverLetterVersions: number;
  activities: number;
}

export interface ClearDemoSummary {
  proposals: number;
  postings: number;
  companies: number;
  activities: number;
}

const demoUrl = (path: string): string => `https://${DEMO_URL_HOST}/${path}`;
const demoUrlLike = `https://${DEMO_URL_HOST}/%`;
const demoCompanyLike = `${DEMO_COMPANY_PREFIX}%`;

/**
 * Remove every demo row for `userId`, in FK-safe order, atomically. The
 * cover-letter proposal's `candidacy_id` FK is `on delete set null`, so it would
 * orphan when its candidacy is cascade-deleted with the posting — delete the demo
 * proposals first (scoped to this user's demo candidacies). Deleting the demo
 * postings then cascades their candidacies (and each candidacy's
 * cover_letter_versions + external_application_forms); deleting the demo companies
 * cascades their contacts. Demo activities are deleted by the seed marker. Real
 * rows are never matched.
 */
export async function clearDemo(db: Db, userId: string): Promise<ClearDemoSummary> {
  return await db.begin(async (tx) => {
    const proposals = await tx`
      delete from proposals
      where candidacy_id in (
        select c.id from candidacies c
        join postings p on p.id = c.posting_id
        where c.user_id = ${userId} and p.url like ${demoUrlLike}
      )
      returning id`;
    const postings = await tx`
      delete from postings where url like ${demoUrlLike} returning id`;
    const companies = await tx`
      delete from companies where name like ${demoCompanyLike} returning id`;
    const activities = await tx`
      delete from activities
      where user_id = ${userId} and detail->>'seed' = ${SEED_MARKER}
      returning id`;
    return {
      proposals: proposals.length,
      postings: postings.length,
      companies: companies.length,
      activities: activities.length,
    };
  });
}

/**
 * Seed the owner's demo pipeline. Idempotent: tears down any prior demo rows for
 * `userId` first, then inserts a fresh fixture set, so a re-run always converges on
 * the same logical state. Produces: an `enriched` company (with contacts) + a
 * `researching` company (the "Archer in action" indicator) + two more; today-dated
 * postings across all three boards; candidacies across `shortlisted` +
 * `alternative_outreach` (with match scores + triage reasons) plus one progressed to
 * `in_review` with a `proposed` cover-letter version and its open review proposal;
 * and a coherent daily-run activity trail (collects incl. a clean not-integrated
 * outcome, a match, an enrich, and the cover-letter draft).
 */
export async function seedDemo(db: Db, userId: string): Promise<SeedDemoSummary> {
  await clearDemo(db, userId);
  return await db.begin(async (tx) => {
    // ── companies ──────────────────────────────────────────────────────────────
    const [helios] = await tx<{ id: string }[]>`
      insert into companies
        (name, status, domain, website_url, linkedin_url, description, recruitment_email, enrichment)
      values (
        ${`${DEMO_COMPANY_PREFIX}Helios Robotics`}, 'enriched',
        'heliosrobotics.example', 'https://heliosrobotics.example',
        'https://www.linkedin.com/company/helios-robotics-demo',
        'Helios Robotics builds autonomous warehouse systems for African logistics networks.',
        'talent@heliosrobotics.example',
        ${tx.json({ summary: "Series-B robotics scale-up (~120 staff) with a strong platform-engineering team.", headcount: "100-150", hq: "Cape Town, ZA", source: "demo" } as never)}
      )
      returning id`;
    const [northwind] = await tx<{ id: string }[]>`
      insert into companies (name, status, website_url, description)
      values (
        ${`${DEMO_COMPANY_PREFIX}Northwind Analytics`}, 'researching',
        'https://northwind-analytics.example',
        'Northwind Analytics — a data consultancy; Archer is researching them now.'
      )
      returning id`;
    const [cobalt] = await tx<{ id: string }[]>`
      insert into companies (name, status)
      values (${`${DEMO_COMPANY_PREFIX}Cobalt Software`}, 'new') returning id`;
    const [vega] = await tx<{ id: string }[]>`
      insert into companies (name, status)
      values (${`${DEMO_COMPANY_PREFIX}Vega Logistics`}, 'new') returning id`;
    const companyCount = 4;

    // ── contacts (the enriched company's team) ───────────────────────────────────
    await tx`
      insert into contacts (company_id, full_name, email, linkedin_url, role_title, notes) values
        (${helios.id}, 'Amara Okafor', 'amara.okafor@heliosrobotics.example',
         'https://www.linkedin.com/in/amara-okafor-demo', 'Head of Talent',
         'Primary recruiting contact (demo).'),
        (${helios.id}, 'Liam van der Merwe', null,
         'https://www.linkedin.com/in/liam-vdm-demo', 'Engineering Manager, Platform',
         'Hiring manager for the platform role (demo).')`;
    const contactCount = 2;

    // ── postings (today-dated, one per company, across all three boards) ─────────
    const [p1] = await tx<{ id: string }[]>`
      insert into postings
        (board_slug, url, title, company_id, company_name_raw, location, work_mode, salary_raw, description, posted_on)
      values ('careerjunction', ${demoUrl("careerjunction/senior-platform-engineer")},
              'Senior Platform Engineer', ${helios.id}, 'Helios Robotics',
              'Cape Town (Remote-friendly)', 'remote', 'R1.1m – R1.4m / year',
              'Own the platform that runs our autonomous fleet — Kubernetes, Go, and genuinely interesting scaling problems.',
              current_date)
      returning id`;
    const [p2] = await tx<{ id: string }[]>`
      insert into postings
        (board_slug, url, title, company_id, company_name_raw, location, work_mode, salary_raw, description, posted_on)
      values ('pnet', ${demoUrl("pnet/data-engineer")},
              'Data Engineer', ${northwind.id}, 'Northwind Analytics',
              'Johannesburg', 'hybrid', 'R780k – R960k / year',
              'Build and own the data pipelines behind our analytics products. dbt, Airflow, Snowflake.',
              current_date)
      returning id`;
    const [p3] = await tx<{ id: string }[]>`
      insert into postings
        (board_slug, url, title, company_id, company_name_raw, location, work_mode, salary_raw, description, posted_on)
      values ('careerjet', ${demoUrl("careerjet/backend-engineer-python")},
              'Backend Engineer (Python)', ${cobalt.id}, 'Cobalt Software',
              'Durban', 'office', null,
              'Python/Django backend role on a small product team. Adjacent to your targets.',
              current_date)
      returning id`;
    const [p4] = await tx<{ id: string }[]>`
      insert into postings
        (board_slug, url, title, company_id, company_name_raw, location, work_mode, salary_raw, description, posted_on)
      values ('careerjunction', ${demoUrl("careerjunction/staff-software-engineer")},
              'Staff Software Engineer', ${vega.id}, 'Vega Logistics',
              'Remote (ZA)', 'remote', 'R1.3m – R1.6m / year',
              'Set technical direction across our logistics platform. TypeScript, Go, event-driven systems.',
              current_date)
      returning id`;
    const postingCount = 4;

    // ── candidacies ──────────────────────────────────────────────────────────────
    // Two shortlisted + one alternative_outreach feed the jobs route; one progressed
    // to in_review feeds the cover-letters route (never shown in the jobs feed).
    const [, , c3, c4] = await tx<{ id: string }[]>`
      insert into candidacies (user_id, posting_id, status, triage_decision, triage_reason, match_score)
      values
        (${userId}, ${p1.id}, 'shortlisted', 'shortlisted',
         'Strong match — your platform/Kubernetes experience and remote preference line up with this role.', 92),
        (${userId}, ${p2.id}, 'shortlisted', 'shortlisted',
         'Solid data-engineering fit; Archer is researching the company now.', 84),
        (${userId}, ${p3.id}, 'alternative_outreach', 'alternative_outreach',
         'Adjacent to your targets — worth a speculative outreach rather than a direct apply.', 66),
        (${userId}, ${p4.id}, 'in_review', 'shortlisted',
         'Shortlisted, and a draft cover letter is ready for your review.', 88)
      returning id`;
    const candidacyCount = 4;

    // ── cover letter for the in_review candidacy (c4) ────────────────────────────
    // Final review state: a `proposed` version + its open `cover_letter_version`
    // proposal (status 'submitted'), exactly what the review screen self-decides
    // against (getOpenCoverLetterVersionProposal). A demo spoken-note artifact is
    // attached so playback renders too.
    const letter = [
      "Dear Hiring Team at Vega Logistics,",
      "",
      "I'm applying for the Staff Software Engineer role. Over the last several years I've set technical direction on event-driven platforms in TypeScript and Go — the exact shape of the systems you're scaling — and I care a lot about the kind of remote-first, high-ownership engineering culture your posting describes.",
      "",
      "I'd welcome the chance to talk about where Vega's platform is heading and how I can help get it there.",
      "",
      "Warm regards,",
      "(your name)",
    ].join("\n");
    const [clv] = await tx<{ id: string }[]>`
      insert into cover_letter_versions
        (candidacy_id, user_id, version_no, status, label, content, details)
      values (${c4.id}, ${userId}, 1, 'proposed', 'Draft 1', ${letter},
              ${tx.json({ seed: SEED_MARKER, spokenNote: { audioUrl: demoUrl("audio/vega-staff-swe.mp3"), provider: "demo", durationMs: 42000 } } as never)})
      returning id`;
    const coverLetterVersionCount = 1;
    await tx`
      insert into proposals (kind, title, rationale, plan, status, created_by, candidacy_id)
      values ('cover_letter_version',
              'Cover letter — Staff Software Engineer @ Vega Logistics',
              'Drafted from your profile and the posting; ready for your review.',
              ${tx.json({ kind: "cover_letter_version", candidacyId: c4.id, userId, versionId: clv.id } as never)},
              'submitted', 'agent', ${c4.id})`;

    // ── daily-run activity trail ─────────────────────────────────────────────────
    // The story the home feed renders: two boards collected today, CareerJet a clean
    // not-integrated outcome (not a failure), the matcher triaged the batch, the
    // Researcher enriched Helios, and a cover letter was drafted for review.
    const activities = await tx`
      insert into activities
        (type, status, user_id, board_slug, candidacy_id, company_id, detail, started_at, finished_at)
      values
        ('collect','succeeded',${userId},'careerjunction',null,null,
         ${tx.json({ seed: SEED_MARKER, outcome: "found", scraped: 2, postingsNew: 2, candidaciesNew: 2, titles: ["Senior Platform Engineer", "Staff Software Engineer"] } as never)},
         now() - interval '7 minutes', now() - interval '6 minutes'),
        ('collect','succeeded',${userId},'pnet',null,null,
         ${tx.json({ seed: SEED_MARKER, outcome: "found", scraped: 1, postingsNew: 1, candidaciesNew: 1, titles: ["Data Engineer"] } as never)},
         now() - interval '6 minutes', now() - interval '5 minutes'),
        ('collect','succeeded',${userId},'careerjet',null,null,
         ${tx.json({ seed: SEED_MARKER, outcome: "not_integrated", scraped: 0, postingsNew: 0, candidaciesNew: 0, message: "CareerJet adapter not integrated yet — recorded as a clean outcome." } as never)},
         now() - interval '5 minutes', now() - interval '5 minutes'),
        ('match','succeeded',${userId},null,null,null,
         ${tx.json({ seed: SEED_MARKER, processed: 4, shortlisted: 2, alternative_outreach: 1, dismissed: 1 } as never)},
         now() - interval '4 minutes', now() - interval '4 minutes'),
        ('enrich','succeeded',${userId},null,null,${helios.id},
         ${tx.json({ seed: SEED_MARKER, company: "Helios Robotics", contacts: 2 } as never)},
         now() - interval '3 minutes', now() - interval '2 minutes'),
        ('cover_letter','succeeded',${userId},null,${c4.id},null,
         ${tx.json({ seed: SEED_MARKER, versionNo: 1, candidacy: "Staff Software Engineer @ Vega Logistics" } as never)},
         now() - interval '2 minutes', now() - interval '1 minute')
      returning id`;

    return {
      companies: companyCount,
      contacts: contactCount,
      postings: postingCount,
      candidacies: candidacyCount,
      coverLetterVersions: coverLetterVersionCount,
      activities: activities.length,
    };
  });
}
