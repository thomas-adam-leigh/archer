import type { AppType } from "@archer/api";
import { hc } from "hono/client";

export const apiBaseUrl = process.env.ARCHER_API_URL ?? "http://localhost:3000";

export const api = hc<AppType>(apiBaseUrl);
