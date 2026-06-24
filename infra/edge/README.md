# Edge routing (`infra/edge`)

How Archer's web surfaces reach the internet. Archer lives on **`archer.careers`**;
build/Komodo/infra stays on `n8n.computer`. The live config is on the host
(`/home/n8n/.cloudflared/config.yml` + Caddy's admin API); this file is the
version-controlled record of what was added.

## Topology

```
Cloudflare (proxied CNAME, zone archer.careers)
   │   app.archer.careers · api.archer.careers · status.archer.careers
   ▼
cloudflared tunnel "n8n-computer" (f35f87f2-…)  ── ingress ──▶ http://localhost:80
   ▼
Caddy (host, :80, admin :2019)  ── reverse_proxy by Host ──▶ 127.0.0.1:<port>
   ▼
container   archer-web → :9127   archer-api → :9125   uptime-kuma → :9126
```

The same `n8n-computer` tunnel serves multiple zones (n8n.computer, customaiagents.co.za,
archer.careers) — a Cloudflare tunnel can front any hostname on the account.

## The three pieces per host

| Host | Cloudflare DNS | cloudflared ingress | Caddy upstream |
|---|---|---|---|
| `app.archer.careers` | CNAME → `f35f87f2-….cfargotunnel.com` (proxied) | `→ http://localhost:80` | `127.0.0.1:9127` |
| `api.archer.careers` | CNAME → `f35f87f2-….cfargotunnel.com` (proxied) | `→ http://localhost:80` | `127.0.0.1:9125` |
| `status.archer.careers` | CNAME → `f35f87f2-….cfargotunnel.com` (proxied) | `→ http://localhost:80` | `127.0.0.1:9126` |

**TLS** is terminated at Cloudflare (the tunnel is the trust boundary), so Caddy runs
these as plain `:80` reverse proxies. `archer.careers` is on the Cloudflare Free plan;
because `api`/`status` are a single level under the apex, the free `*.archer.careers`
Universal SSL covers them — no Advanced Certificate Manager needed.

## cloudflared ingress — **remotely managed** ⚠️

This tunnel's config `source` is **`cloudflare`**, so its ingress lives in the Cloudflare
API, **not** in `/home/n8n/.cloudflared/config.yml` (that file is ignored for ingress —
editing it and restarting does nothing). Add hostnames by updating the tunnel
configuration via the API; it applies **live, with no restart**:

```
# GET then PUT  /accounts/{account_id}/cfd_tunnel/f35f87f2-…/configurations
# insert before the trailing { service: "http_status:404" } rule:
{ "hostname": "app.archer.careers",    "service": "http://localhost:80" }
{ "hostname": "api.archer.careers",    "service": "http://localhost:80" }
{ "hostname": "status.archer.careers", "service": "http://localhost:80" }
```

> ⚠️ Never `SIGHUP` cloudflared — it treats SIGHUP as *terminate* and drops the whole
> tunnel (taking every host on it down). If you ever must reload, `sudo systemctl restart
> cloudflared-n8n-computer.service` — but for ingress changes you don't even need that,
> since the config is remote.

## Caddy routes (Caddyfile equivalent of the JSON applied via the admin API)

```caddyfile
app.archer.careers {
    reverse_proxy 127.0.0.1:9127   # archer-web (TanStack Start SSR server)
}

api.archer.careers {
    reverse_proxy 127.0.0.1:9125
}

status.archer.careers {
    reverse_proxy 127.0.0.1:9126   # Uptime Kuma (WebSocket upgrade handled automatically)
}
```
