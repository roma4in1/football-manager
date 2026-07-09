# DEPLOY.md — going live at topfootballgame.com

One Fly.io machine runs the whole app (`server/league-server.ts`: Fastify API +
pg-boss worker in a single process, serving the built PWA from `web/dist`).
Supabase hosts Postgres — **connection string only**: auth is our own
magic-link system, so no Supabase Auth/Realtime/Storage is ever wired in.
Cloudflare holds the `topfootballgame.com` DNS zone and points it at Fly.

```
browser ──https──▶ Fly proxy ──▶ league-server (API + worker + static PWA)
                                      │ DATABASE_URL (TLS)
                                      ▼
                                Supabase Postgres
login emails: server ──▶ Resend API ──▶ manager inboxes
```

Everything the app needs at runtime is an environment variable; the
non-secret ones live in `fly.toml` (`HOST`, `PORT`, `BASE_URL`, `EMAIL_FROM`),
the secrets in Fly's secret store (§3). Nothing is committed.

| Secret | What it is | Generate / obtain |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **session-pooler** connection string | Supabase dashboard (§1.2) |
| `SESSION_SECRET` | HMAC key signing magic links + deriving session ids | `openssl rand -base64 48` |
| `RESEND_API_KEY` | transactional email key for login links | Resend dashboard (§2) |

Costs: Fly `shared-cpu-1x` / 512 MB always-on ≈ **$3–5/mo**; Supabase free
tier and Resend free tier (100 emails/day) comfortably hold an 8-manager
league. Total ≈ $5/mo.

---

## 0. Prerequisites

- Accounts: [fly.io](https://fly.io), [supabase.com](https://supabase.com),
  [resend.com](https://resend.com); Cloudflare already manages the domain.
- CLI: `brew install flyctl`, then `fly auth login`. `psql` locally
  (`brew install libpq` or use the repo's docker Postgres).
- A green `main` — CI's `deploy-image` job builds and boots this exact image.

## 1. Supabase — create the database

### 1.1 Create the project
Dashboard → **New project**. Pick a region near the Fly region (`fly.toml`
says `cdg` — Paris; Supabase `eu-west-3` Paris or `eu-central-1` Frankfurt).
The database password you set here goes into the connection string — keep it
in your password manager.

### 1.2 Get the connection string
Dashboard → **Connect** (top bar) → **Session pooler** (a.k.a. "Session mode",
port **5432** on the `*.pooler.supabase.com` host):

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

- **Session pooler, not transaction pooler (port 6543).** pg-boss and the
  server's explicit `BEGIN … COMMIT` row-lock transactions need session
  semantics; transaction pooling breaks pg-boss's assumptions. Session mode
  behaves like a direct connection and works over IPv4.
- The **direct** connection (`db.<ref>.supabase.co:5432`) also works — Fly
  machines have IPv6 — but session pooler is the default to document because
  it works from anywhere (your laptop included, for psql/backups).
- Keep `?sslmode=require` — node-postgres then encrypts the connection
  (Supabase requires TLS).

### 1.3 Initialize the schema — ONCE
`server/schema.sql` is CREATE-only, no migration framework. Run it one time
against the fresh database:

```sh
psql "<DATABASE_URL from 1.2>" -v ON_ERROR_STOP=1 -f server/schema.sql
```

(The Supabase SQL editor also works, but psql is exact: the file manages its
own `BEGIN/COMMIT`.) pg-boss creates its own `pgboss` schema automatically on
first boot — nothing to do there.

> **⚠️ Cutover point.** Pre-launch, the schema is create-once: to change it you
> drop and re-run. **The moment real league data exists, that stops.** Any
> schema change after go-live is a migration: a hand-written, reviewed
> `ALTER`-script applied via psql, with `schema.sql` updated in the same PR so
> fresh installs stay canonical. Take a backup (§8) before applying one. We
> deliberately did not adopt a migration framework for an 8-user app — revisit
> if migrations become frequent.

### 1.4 Seed the league
The production league needs its managers, clubs, and the imported player pool
before the auction can start. Use the existing setup path (the pipeline's pool
export + the setup/seeding flow; `server/scripts/seed-demo.ts` shows the
shape). Managers are **seeded, not registered** — their emails must be real,
that's where login links go.

## 2. Resend — real login emails

1. Resend dashboard → **Domains** → add `topfootballgame.com`. It gives you
   2–3 DNS records (DKIM TXT, SPF/MX for the bounce subdomain). Add them in
   Cloudflare (DNS-only is fine) and wait for **Verified**.
2. **API keys** → create one (scope: sending). This is `RESEND_API_KEY`.
3. Sender identity is `EMAIL_FROM` in `fly.toml`
   (`FM League <login@topfootballgame.com>`) — no mailbox needs to exist;
   it only sends.

The server picks Resend automatically when `RESEND_API_KEY` is set
(`server/league-server.ts`); without it, links go to stdout (dev behavior) and
a warning is logged if `BASE_URL` is set. Free tier: 100 emails/day — an
8-manager league's login traffic rounds to zero.

**Reveal-notification fallback:** if the planned iOS-push weekly reveal turns
out flaky (push is parked pending a device test), this same email path is the
fallback — the `LinkDelivery`-style provider wrapper in `league-email.ts` is
the pattern to extend.

## 3. Fly — create the app and set secrets

```sh
fly apps create topfootballgame        # name must match `app` in fly.toml
fly secrets set \
  DATABASE_URL='<from §1.2>' \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  RESEND_API_KEY='<from §2>'
```

`fly.toml` is committed and already correct: port 8080, health check on
`/api/health`, **auto-stop off** — the machine must stay up because pg-boss
timers fire matchweek deadlines, HT windows, and auction closes; a scaled-to-
zero machine would fire them only when someone's request wakes it.
Machine size: `shared-cpu-1x` / 512 MB — smallest comfortable for Node +
worker; 8 users won't stress it.

## 4. Deploy

```sh
fly deploy        # builds the repo Dockerfile remotely, health-checks, promotes
```

The Dockerfile is the same artifact CI's `deploy-image` job builds and boots
on every push: Vite builds the PWA, the server runs the TypeScript sources
directly on Node 24, and `web/dist` is served by Fastify with the SPA
fallback.

First verification, before DNS:

```sh
curl https://topfootballgame.fly.dev/api/health   # → {"ok":true}
```

## 5. Domain — point Cloudflare at Fly

1. Allocate IPs and request the cert:
   ```sh
   fly ips allocate-v4 --shared     # free shared IPv4
   fly ips allocate-v6
   fly certs add topfootballgame.com
   fly ips list                     # note the v4 and v6 addresses
   ```
2. In Cloudflare DNS for `topfootballgame.com`, create **DNS-only (grey
   cloud)** records at the apex:
   - `A     @  <v4 from fly ips list>`
   - `AAAA  @  <v6 from fly ips list>`

   DNS-only matters: Fly terminates TLS with its own Let's Encrypt cert, and
   issuance/renewal is unreliable behind Cloudflare's proxy. Fly already gives
   HTTPS + HTTP→HTTPS redirect (`force_https`), so the proxy adds nothing here.
3. `fly certs check topfootballgame.com` until it reports issued (minutes).
4. Verify end to end:
   ```sh
   curl https://topfootballgame.com/api/health     # → {"ok":true}
   ```
   Then the real thing: open the site on a phone, request a login link for a
   seeded manager email, click it from the inbox, land signed-in. The session
   cookie is `Secure` + `httpOnly` in production.

## 6. Go-live checklist (condensed order)

1. §1 Supabase project → connection string → `schema.sql` once → seed league
2. §2 Resend domain verified → API key
3. §3 `fly apps create` + `fly secrets set`
4. §4 `fly deploy` → health check green on `topfootballgame.fly.dev`
5. §5 DNS + cert → health check green on `topfootballgame.com`
6. §8 set the two GitHub backup secrets, run the `backup` workflow once
   manually, and confirm you can decrypt the artifact
7. Send the 8 managers their URL

## 7. Ongoing ops

### Redeploy (after a merge to main)
```sh
git pull && fly deploy
```
CI green first — `deploy-image` proves the image boots. Deploys are
brief-downtime on a single machine (seconds); avoid deploying inside an
auction or right at a matchweek deadline — pg-boss retries queued work on
boot, but why test it live.

### Is it healthy?
```sh
fly status                                      # machine up? checks passing?
fly checks list
curl https://topfootballgame.com/api/health     # {"ok":true} = HTTP + DB good
fly logs                                        # live tail; look for [pg-boss] errors
```
The health endpoint runs `SELECT 1` through the shared pool, so it covers the
database connection, not just the HTTP layer. Crash-restarts are automatic
(`[[restart]] policy = "always"`).

### Rotating secrets
- `SESSION_SECRET` — **rotating it invalidates every session and all
  unredeemed login links** (sessions and links are HMAC-derived from it, per
  the PR #11 design). Everyone just logs in again — do it between matchweeks,
  not mid-auction: `fly secrets set SESSION_SECRET="$(openssl rand -base64 48)"`
  (secrets-set restarts the machine).
- `RESEND_API_KEY` — create the new key in Resend, `fly secrets set`, revoke
  the old one. No user impact.
- `DATABASE_URL` (Supabase password reset) — reset in Supabase, update the Fly
  secret **and** the `PROD_DATABASE_URL` GitHub secret (§8).

## 8. Backups — the league is irreplaceable

**What Supabase provides:** the **free plan has no automated backups at all**;
the Pro plan ($25/mo) adds daily backups with 7-day retention (PITR costs
extra). For a multi-season save, free-plan-with-no-net is not acceptable —
hence the supplementary dump.

**What the repo provides:** `.github/workflows/backup.yml` runs a nightly
`pg_dump`, gzips, **encrypts with AES-256**, and uploads a GitHub artifact
with 30-day retention. Encryption is mandatory, not paranoia: this repo is
public and public-repo artifacts are downloadable by any logged-in GitHub
user, while a raw dump contains manager emails and live session ids.

Set two repo secrets (GitHub → Settings → Secrets and variables → Actions):
- `PROD_DATABASE_URL` — same value as the Fly secret
- `BACKUP_PASSPHRASE` — `openssl rand -base64 32`, **kept in your password
  manager**: a backup you can't decrypt is not a backup

Then run the workflow once by hand (Actions → backup → Run workflow) and
**rehearse the restore** before go-live:

```sh
# decrypt + inspect
export BACKUP_PASSPHRASE='...'
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
  -in league-2026-07-09.sql.gz.enc | gunzip > league.sql

# restore into an EMPTY database (fresh Supabase project or wiped schema):
psql "<DATABASE_URL>" -v ON_ERROR_STOP=1 -f league.sql
```

Restoring over a live app: `fly scale count 0` first (stop writes), restore,
`fly scale count 1`. The dump is `--no-owner --no-privileges`, so it restores
cleanly into a fresh Supabase project too — that is also the disaster path if
the Supabase project itself is lost.

Posture summary: **nightly encrypted off-site dump (30 days back) on the free
tier; consider Supabase Pro later for provider-side daily backups on top.**
Multi-season risk that remains: a corruption noticed >30 days late. If a
season save becomes precious, occasionally download an artifact and keep it
locally.

## 9. What is deliberately NOT here

- **Supabase Auth / Realtime / Storage** — our magic-link auth is the auth.
- **A migration framework** — see the §1.3 cutover note.
- **Public Postgres exposure** — only Fly (and the backup workflow) hold the
  connection string; Supabase's pooler requires TLS.
- **Multi-machine / zero-downtime deploys** — one process is the design
  (single pg-boss worker); revisit never, probably.
