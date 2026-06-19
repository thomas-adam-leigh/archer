import { Hono } from "hono";

const app = new Hono()
  .get("/", (c) => c.json({ name: "archer-api", status: "ok" }))
  .get("/health", (c) => c.json({ status: "ok" }));

export type AppType = typeof app;
export default app;
