import { Constants, setCandidacyStatus } from "@archer/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { runCli } from "./cli.js";
import { getDb } from "./db.js";

const CANDIDACY_STATUSES = Constants.public.Enums.candidacy_status as readonly string[];

// Shared-secret gate for command + webhook routes. Open in dev when unset.
function authorized(c: Context): boolean {
  const secret = process.env.ARCHER_API_SECRET;
  if (!secret) return true;
  return c.req.header("x-archer-secret") === secret;
}

const app = new Hono()
  .get("/", (c) => c.json({ name: "archer-api", status: "ok" }))
  .get("/health", (c) => c.json({ status: "ok" }))
  // Trigger a collect run by invoking the CLI (browser work stays in the CLI).
  .post("/commands/collect/:board", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const board = c.req.param("board");
    const user = c.req.query("user") ?? process.env.ARCHER_USER_ID;
    const args = ["collect", board, "--json"];
    if (user) args.push("--user", user);
    const res = await runCli(args);
    if (res.code !== 0) {
      return c.json({ error: res.stderr.trim() || "collect failed", code: res.code }, 502);
    }
    return c.json(JSON.parse(res.stdout));
  })
  // DB-only command: move a candidacy through the kanban (in-process, no CLI).
  .post("/commands/candidacies/:id/transition", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to : undefined;
    if (!to || !CANDIDACY_STATUSES.includes(to)) {
      return c.json({ error: `'to' must be one of ${CANDIDACY_STATUSES.join(", ")}` }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const updated = await setCandidacyStatus(getDb(), id, to as never, { reason });
    if (!updated) return c.json({ error: "unknown candidacy" }, 404);
    return c.json({ id: updated.id, status: updated.status });
  })
  // Webhook: a redirected (external) application form was inserted.
  .post("/hooks/external-form", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { record?: { id?: string } };
    // TODO(M3): wake the external-form-filling agent. For now, acknowledge.
    return c.json({ received: true, ref: body.record?.id ?? null }, 202);
  })
  // Webhook: an Activity failed -> the self-heal Mechanic should investigate.
  .post("/hooks/activity-failed", async (c) => {
    if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
    await c.req.json().catch(() => ({}));
    // TODO(M4): wake the Mechanic. For now, acknowledge.
    return c.json({ received: true }, 202);
  });

export type AppType = typeof app;
export default app;
