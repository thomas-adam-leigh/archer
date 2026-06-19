# Observability (`infra/observability`)

Right-sized for a tenant-of-one: Komodo already aggregates container logs, server
stats, and health (and alerts on them). This adds the two things it doesn't:

## 1. Uptime monitoring

[Uptime Kuma](https://github.com/louislam/uptime-kuma) (FOSS) watches the public
surfaces and notifies the same channel as the Komodo alerter:

- **HTTP monitor** → `https://<archer-api host>/health` (expects `200`).
- Notifications → Slack/Discord/ntfy/n8n (mirror `ARCHER_ALERT_WEBHOOK`).

## 2. Dead-man's-switch on the daily Collect ⭐

Archer's whole promise is "it runs every weekday at 13:00." A silent failure is
worse than a loud one. So instead of checking that something *happened*, we alert
when an expected check-in is *missing*:

1. In Uptime Kuma, create a **Push** monitor with a heartbeat interval just over
   24h (e.g. 25h) named `daily-collect`. It gives you a push URL.
2. Store that URL as Supabase/Komodo secret `UPTIME_KUMA_PUSH_URL`.
3. At the **end of a successful Collect Activity**, the pipeline pings it:

   ```sh
   curl -fsS "$UPTIME_KUMA_PUSH_URL?status=up&msg=collect-ok"
   ```

If 13:00 passes and no ping arrives within the window, Kuma fires — you learn the
collect broke *that day*, not when a user notices empty results. When the Mechanic
self-heals the adapter, the next successful collect silences it automatically.

> The same Push pattern works for the per-minute Matchmaker and any other Activity
> whose absence is the failure mode.
