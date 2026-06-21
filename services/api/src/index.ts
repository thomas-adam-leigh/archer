import { serve } from "@hono/node-server";
import app, { assertSecureStartup } from "./app.js";

// Fail closed before opening a port: in production a missing ARCHER_API_SECRET
// hard-fails here rather than serving an unauthenticated/locked API (ARC-55).
assertSecureStartup();

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
