// Typed data-access layer over the Archer schema. Thin, hand-written queries so
// the rest of the tool layer never embeds SQL. Grows one helper at a time as the
// CLI / API need it. All functions take a `Db` from createDb().
import type { Db } from "./client.js";
import type { Database } from "./database.types.js";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
type Enum<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T];

export type Board = Row<"boards">;
export type Activity = Row<"activities">;
export type TargetTitle = Row<"target_titles">;
export type Profile = Row<"profiles">;

// ── boards ────────────────────────────────────────────────────────────────
export async function listBoards(db: Db): Promise<Board[]> {
  return await db<Board[]>`select * from boards order by slug`;
}

export async function getBoard(db: Db, slug: string): Promise<Board | undefined> {
  const rows = await db<Board[]>`select * from boards where slug = ${slug}`;
  return rows[0];
}

export async function setBoardStatus(
  db: Db,
  slug: string,
  patch: { collect?: Enum<"integration_status">; apply?: Enum<"integration_status"> },
): Promise<Board | undefined> {
  const rows = await db<Board[]>`
    update boards set
      collect_status = coalesce(${patch.collect ?? null}::integration_status, collect_status),
      apply_status   = coalesce(${patch.apply ?? null}::integration_status, apply_status)
    where slug = ${slug}
    returning *`;
  return rows[0];
}

// ── activities (the universal run primitive) ──────────────────────────────
export interface StartActivityInput {
  type: Enum<"activity_type">;
  userId?: string | null;
  boardSlug?: string | null;
  postingId?: string | null;
  candidacyId?: string | null;
  companyId?: string | null;
  detail?: Record<string, unknown>;
}

export async function startActivity(db: Db, input: StartActivityInput): Promise<Activity> {
  const rows = await db<Activity[]>`
    insert into activities
      (type, status, user_id, board_slug, posting_id, candidacy_id, company_id, detail, started_at)
    values
      (${input.type}, 'in_progress', ${input.userId ?? null}, ${input.boardSlug ?? null},
       ${input.postingId ?? null}, ${input.candidacyId ?? null}, ${input.companyId ?? null},
       ${input.detail ? db.json(input.detail as never) : null}, now())
    returning *`;
  return rows[0];
}

export async function succeedActivity(
  db: Db,
  id: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db`
    update activities set
      status = 'succeeded', finished_at = now(),
      detail = coalesce(${detail ? db.json(detail as never) : null}::jsonb, detail)
    where id = ${id}`;
}

export async function failActivity(
  db: Db,
  id: string,
  error: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db`
    update activities set
      status = 'failed', finished_at = now(), error = ${error},
      detail = coalesce(${detail ? db.json(detail as never) : null}::jsonb, detail)
    where id = ${id}`;
}

// ── target titles (the collect search keys) ───────────────────────────────
export async function listTargetTitles(
  db: Db,
  userId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<TargetTitle[]> {
  if (opts.activeOnly) {
    return await db<TargetTitle[]>`
      select * from target_titles where user_id = ${userId} and is_active order by created_at`;
  }
  return await db<TargetTitle[]>`
    select * from target_titles where user_id = ${userId} order by created_at`;
}

export async function addTargetTitle(db: Db, userId: string, title: string): Promise<TargetTitle> {
  const rows = await db<TargetTitle[]>`
    insert into target_titles (user_id, title) values (${userId}, ${title}) returning *`;
  return rows[0];
}

export async function removeTargetTitle(db: Db, id: string): Promise<void> {
  await db`delete from target_titles where id = ${id}`;
}

// ── profile ───────────────────────────────────────────────────────────────
export async function getProfile(db: Db, userId: string): Promise<Profile | undefined> {
  const rows = await db<Profile[]>`select * from profiles where user_id = ${userId}`;
  return rows[0];
}
