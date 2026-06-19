import { hc } from "hono/client";
import type { AppType } from "@archer/api";

export const apiBaseUrl = process.env.ARCHER_API_URL ?? "http://localhost:3000";

export const api = hc<AppType>(apiBaseUrl);
