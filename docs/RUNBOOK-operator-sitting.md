# RUNBOOK — the operator sitting

**The document you read while doing it.** Every command below was run or read
against the tree at `1a8f93d9` on 2026-08-13. Where it disagrees with
`docs/DEPLOY.md`, §0 says so and **this file wins** — DEPLOY.md is the reference
manual, written before phase 4 and before the app was deployed under the name it
actually has.

What the sitting does, in order: read the database's state → back it up → apply
`0002`/`0003`/`0004` → deploy the current `main` → prove the boot is clean → make
the domain resolve → create the first league. It touches a production database
that holds an irreplaceable league, and **`0003` is one-way**: §11 is the only
undo and it costs everything written since the dump.

---

## 0. WHAT IS WRONG IN THE EXISTING INSTRUCTIONS

Eight things. The first four would each produce a wrong action or a false
verdict if followed as written.

**0.1 — `docs/DEPLOY.md` §3, §4 and §6.4 name an app and a hostname that do not
exist.** They say `fly apps create topfootballgame` and
`curl https://topfootballgame.fly.dev/api/health`. The app is
**`football-manager---594q`** (`fly.toml:16`, whose own comment records that the
runbook's name was never used). `topfootballgame.fly.dev` does not resolve, so
§4's verification fails on a perfectly healthy deploy. The working command, run
2026-08-13:

```
$ curl -s https://football-manager---594q.fly.dev/api/health
{"ok":true}
```

**0.2 — §6.7's "unset every test override" list is missing the one that matters
most now.** It names three env vars. There is a fourth knob with its own boot
banner — **`SIM_ENGINE`** (`league-server.ts:79-88`). `SIM_ENGINE=agent` ships the
spatial sim, which does **not** meet the stat-harness bands; the standing ruling
is that **aggregate is the shipping engine**. It must be absent from
`fly config show`, exactly like the other three. See §6.

**0.3 — §1.4's "There is no in-app league creation; this script is the only
path" is false as of `c7769c37`.** `POST /api/leagues` and
`POST /api/leagues/join` are on `main`. That changes the last step of the sitting
from one option to two — see §9, and decide which one you are doing *before* you
write a `clubs.json`.

**0.4 — "managers log in via magic link" (§1.4's closing line, and
`setup-production.ts:110`) describes an auth system that no longer exists.**
Auth is email + password. `POST /auth/signup` claims a seeded manager row that
has the same email (`league-api.ts:157-169`), so **a seeded manager claims their
club by signing up, not by clicking an emailed link.** The only emailed link left
is password reset.

> **This corrects the standing account of why DNS blocks the sitting.** Dead DNS
> does not stop a seeded manager from claiming a club. What it does do is
> (a) make `https://topfootballgame.com` unreachable — that is the URL you would
> send people — and (b) kill every password-reset link, because `BASE_URL` in
> `fly.toml` already points at the domain. Both are real. The claiming mechanism
> is not the reason.

**0.5 — §6's checklist calls the migrate step "a no-op that just starts tracking
the schema".** That was true when `0001` was the only migration. Today the same
command **adopts `0001` and runs `0002`, `0003` and `0004`**, and `0003` rewrites
every row of `players`, `seasons` and `clubs`. It is the single most consequential
command in this document. §4 states exactly what it will do.

**0.6 — §1.6's "additive DDL is harmless to the running old code" does not hold
for `0003`.** `0003` sets `seasons.league_id` and `clubs.league_id` **NOT NULL**.
The currently deployed image does not write those columns, so between the
migration and the deploy **any INSERT into `clubs` or `seasons` by the old code
fails**. The realistic path that does this is the season-rollover job (creates
season N+1) firing from pg-boss. Mitigation: run §4 and §5 back to back, and not
near a season end. See §4's timing note.

**0.7 — §8's "run the workflow once by hand" needs a harder pass condition.**
`.github/workflows/backup.yml` exits **0** with `secrets not configured —
skipping (pre-launch)` when the secrets are missing, and uploads nothing. A green
run is not a backup. §2 gives the condition that is.

**0.8 — two directory conventions, both correct.** §1.6 runs
`node scripts/migrate.ts` from `server/`; §7 runs `node server/scripts/migrate.ts`
from the repo root. Both work: `MIGRATIONS_DIR` is resolved from the script's own
URL (`migrate.ts:54`), not from the cwd. `pnpm migrate` and
`pnpm migrate --confirm` from the repo root forward correctly — verified. This
runbook uses the repo-root form throughout so you never have to think about where
you are standing.

---

## 1. BEFORE YOU TOUCH ANYTHING

**Have open:** this file, a terminal in `/Users/romain/football-manager` on a
clean checkout of the commit you intend to deploy, the Fly dashboard, the
Cloudflare DNS page for `topfootballgame.com`, and your password manager (for
`BACKUP_PASSPHRASE` and the Supabase connection string).

**Set the connection string once**, and use `$PROD` for the rest of the sitting:

```sh
export PROD='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
```

Session pooler, port **5432** — not the transaction pooler on 6543 (pg-boss and
the row-lock transactions need session semantics; `docs/DEPLOY.md` §1.2).

**Confirm what you are deploying:**

```sh
git fetch origin && git status --short && git log --oneline -1 origin/main
```

**PASS** — no modified files, and the SHA is the one you mean to ship.
**STOP** — a dirty tree. `fly deploy` builds the repo as it is; an uncommitted
edit ships invisibly and the bundle-hash check in §7 will not save you, because
it would match the thing you accidentally built.

> **As of 2026-08-13 `origin/main` is `1a8f93d9`, and the lobby screen is NOT on
> it.** `feat/lobby-create-join` (`c51cddcc`) is pushed and unmerged. `main`
> carries the create/join **routes** but not the screen that drives them. If you
> want the self-serve path in §9.2 to be usable by a human, merge that branch
> first and deploy the merge commit.

---

## 2. STEP 1 — THE BACKUP, AND HOW TO KNOW IT IS REAL

§11 is the only undo for what §4 does. `0003` is forward-only and claims every
player row; there is no down-migration and no PITR on the free Supabase plan. So
this section is not "take a backup" — it is **hold a file you have watched
restore**.

> **TAKE THE SITTING'S BACKUP BY HAND. Do not rely on the nightly.** Not because
> the workflow is broken (it is fixed — §2.3), but because they answer different
> questions. The nightly is a net for the weeks either side of the sitting: up to
> 24 hours stale, living in a GitHub artifact that expires in 30 days and that you
> would have to download before you could use it. The sitting needs a snapshot
> from **minutes** before `--confirm`, in your own hands, decryptable now. Every
> hour between the dump and the migration is data a rollback would lose.

### 2.1 Take it

`$PROD` is already set (§1). The passphrase is the same `BACKUP_PASSPHRASE` the
workflow uses — one secret, one habit:

```sh
export BACKUP_PASSPHRASE='<the same value as the repo secret>'
OUT="league-$(date -u +%F)-pre-sitting.sql.gz.enc"

docker run --rm postgres:17-alpine \
  pg_dump --no-owner --no-privileges --dbname "$PROD" \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
  > "$OUT"

ls -lh "$OUT"
```

`postgres:17-alpine` because the client must never be older than the server, and
because the dump carries a `\restrict` header an older `psql` cannot read on the
way back. The dump is deliberately **not** narrowed with `--schema`: `pg_dump -n
public` emits `CREATE SCHEMA public`, which fails on restore into a fresh
database that already has one. Verified locally on 2026-08-13 — the unrestricted
form is the one whose restore is proven.

**PASS** — the file exists and is tens of KB or more.
**STOP** — a `pg_dump: error:` line, or a file of a few hundred bytes. Do not
continue; you have no rollback.

### 2.2 PROVE IT RESTORES — this is the step that matters

A dump that decrypts is not a backup. A dump that *restores* is. One command,
and it never touches production:

```sh
BACKUP_PASSPHRASE='…' scripts/verify-backup.sh "$OUT"
```

It decrypts, gunzips, checks pg_dump's own completion marker, starts a
throwaway `postgres:17-alpine`, restores into it with `ON_ERROR_STOP=1`, prints
the row census, and removes the container.

**PASS** — it ends with `✓ RESTORE VERIFIED`, and the census shows the league you
expect: non-zero `players`, your real club count, your seasons.
**STOP** — anything else. Each failure is named:

| What it says | What is wrong |
| --- | --- |
| `decryption failed` | wrong `BACKUP_PASSPHRASE`, or not one of our files |
| `decrypted, but not valid gzip` | the artifact is corrupt |
| `no completion marker — it was cut short` | the dump died mid-stream. It decrypts and gunzips perfectly and is **missing rows**. This is the failure that looks like success. |
| `the restore FAILED` | it will not bring the league back |
| `the player pool is EMPTY` | it restored something, but not the league |

**Send me the census.** Then keep the artifact and the passphrase somewhere that
is not the machine you might be restoring — they are useless apart.

### 2.3 The nightly, which is a separate concern

Fixed in this same change, and worth setting up while you are here, but it is
**not** the sitting's backup.

**What it was:** `.github/workflows/backup.yml` ended its secrets guard with
`echo "secrets not configured — skipping (pre-launch)"; exit 0`. A run with no
secrets was **green and uploaded nothing** — indistinguishable in the Actions
list from a run that backed the league up, while the rollback for an
irreversible migration rested on it.

**What it is now:**

- **Missing secrets fail the job**, with an `::error::` naming which ones. A red
  backup job every night until it is configured is information; a green one that
  did nothing is a trap.
- **The artifact is verified before it is uploaded** — the job decrypts its own
  output, gunzips it, and requires pg_dump's completion marker. The file is only
  given its `league-*.sql.gz.enc` name after it passes, so the upload step
  cannot pick up an unverified one.
- A green run therefore means: the dump completed, it decrypts with the stored
  passphrase, and it is whole. It still does **not** mean it restores — only
  §2.2 proves that, on the file you actually hold.

**What you must set, exactly:**

| Secret | Where | Value |
| --- | --- | --- |
| `PROD_DATABASE_URL` | **GitHub repo secret** (Settings → Secrets and variables → Actions) | the same session-pooler string as the Fly secret — `$PROD` |
| `BACKUP_PASSPHRASE` | **GitHub repo secret**, and your password manager | `openssl rand -base64 32` — generate once, never rotate casually: old artifacts only open with the passphrase they were written with |

Both are repo secrets only; neither belongs in Fly. (`DATABASE_URL`,
`SESSION_SECRET` and `RESEND_API_KEY` are the Fly side and are unrelated to
backups.)

Then: **Actions → backup → Run workflow**, and check that the run is green **and
has an artifact** named `league-backup-<run_id>`. Retention is **30 days** — long
enough to notice a problem, not long enough to be an archive. If a season becomes
precious, download one and keep it.

---

## 3. STEP 2 — THE STATE READ (this decides what §4 will do)

Nothing here writes. **Send me the whole output.**

```sh
psql "$PROD" -c "
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS managed,
       to_regclass('public.leagues')           IS NOT NULL AS has_leagues,
       to_regclass('public.club_identities')   IS NOT NULL AS has_identities,
       (SELECT count(*) FROM seasons)  AS seasons,
       (SELECT count(*) FROM clubs)    AS clubs,
       (SELECT count(*) FROM players)  AS players,
       (SELECT count(*) FROM contracts WHERE released_at IS NULL) AS live_contracts,
       (SELECT count(*) FROM managers) AS managers,
       (SELECT count(*) FROM accounts) AS accounts;"
```

Read the answer against this table:

| What you see | What it means | What §4 will do |
| --- | --- | --- |
| `managed=f`, `has_leagues=f`, **`seasons > 0`** | production as expected, with a live league | adopt `0001`, run `0002/0003/0004`; **`0003` creates "Original league" and claims every player row** |
| `managed=f`, `has_leagues=f`, **`seasons = 0`** | pool imported, no league set up yet | adopt `0001`, run `0002/0003/0004`; **no league row is created and every player stays a template** |
| `managed=t` | someone has already migrated | §4's dry-run will show what, if anything, is pending |
| `has_leagues=t` but `managed=f` | someone ran `0003`'s SQL by hand | **STOP.** Do not migrate. Send me the output. |
| `players = 0` | the pool was never imported | **STOP.** Nothing can auction. Import the pool first. |

Both `seasons` branches are proven, not inferred: I rebuilt production's exact
shape from `migrations/0001_baseline.sql` in a scratch database, seeded each
state, and ran the chain. Results in §4.2 and §4.3.

---

## 4. STEP 3 — THE MIGRATION

### 4.1 The dry-run (writes nothing, not even the bookkeeping table)

```sh
DATABASE_URL="$PROD" node server/scripts/migrate.ts
```

**Send me the plan.** On an unmanaged production database it reads exactly this
(captured from the rebuilt-production probe):

```
migrate — target <host>.pooler.supabase.com (dry-run: pass --confirm to apply)
  ⚠️  this is NOT a local database — it may be the live league.
     Take a backup first (docs/DEPLOY.md §8) and read the plan below.
  state    unmanaged — schema present, unmanaged (the baseline will be ADOPTED, not run)
  known    4 migration(s) on disk, 0 recorded as applied
    ≡ 0001_baseline                      ADOPT (record only — nothing executed)
    + 0002_club-identities               run (27 lines)
    + 0003_leagues                       run (89 lines)
    + 0004_session-selected-league       run (30 lines)
  ✓ baseline verified — all 22 tables and 5 enums present
dry-run complete — nothing written. Re-run with --confirm to apply.
```

**PASS** — `state unmanaged`, the four lines above in that order, and
`✓ baseline verified — all 22 tables and 5 enums present`.
**STOP** — any of:

- `✗ baseline verification FAILED` with `− missing table …`. The runner is
  refusing to record a schema this database does not have. Something was
  hand-run and is incomplete. Do not force it.
- `✗ EDITED AFTER APPLYING`. A migration file changed after it was applied.
  Immutable by rule — restore the file, fix forward in a new migration.
- `! recorded but no longer on disk`. The database knows a migration this
  checkout does not have. You are on the wrong commit.
- `state empty`. The sentinel (`to_regclass('public.seasons')`) found nothing —
  you are pointed at the wrong database.

### 4.2 What `--confirm` actually does when a season exists

Rebuilt production's shape (baseline schema, 2 clubs, 1 season, 40 players, 26
under contract), then applied the chain:

```
  ≡ 0001_baseline adopted (0 statements executed)
  + 0002_club-identities applied in 7 ms
  + 0003_leagues applied in 16 ms
  + 0004_session-selected-league applied in 1 ms
done — 4 migration(s) recorded as applied
```

and the database afterwards:

```
      name       | status | club_capacity     templates_left | claimed
 Original league | active |             2                  0 |      40
```

**Every player row is claimed. Not just the contracted ones — all of them. The
template pool is gone.** `club_capacity` is `GREATEST(2, LEAST(10, <club count>))`
— on production it will be your real club count. The name is provisional and
nothing keys on it; rename it freely afterwards.

**What that means for the first league created after the sitting** — say it now
so it is not discovered later. `copyPoolInto` (`league-store.ts:1472`) copies
templates when any exist and otherwise falls back to the fullest existing
league's roster. With the template pool consumed, the first self-serve league
takes the second path. Verified on the migrated probe:

```
createLeague → copied 40 from source 'league'
   Original league          40 players
   First self-serve league  40 players
```

- The source is reported as **`'league'`, not `'templates'`**. That is correct
  and expected, not a fault.
- It copies the source league's **whole roster**, contracted players included —
  they arrive in the new league as fresh, uncontracted rows. So the new league's
  pool is the same size as the old league's, not the size of its leftover pool.
- The lobby only blocks a start on source `'none'` (no templates **and** no other
  league to copy from). `'league'` starts normally.

### 4.3 What `--confirm` does when NO season exists

Same probe, seeded with 40 players and no season:

```
 leagues_created | templates_left | claimed
               0 |             40 |       0
```

No league row, nothing claimed, every player still a template. Then
`setup-production.ts` (§9.1) behaves exactly as it always did, and the first
league's pool source is `'templates'`.

### 4.4 Apply it

Timing, from §0.6: **run this and §5 back to back**, and not while an auction is
open, not within an hour of a matchweek deadline, and not at a season end. The
window between the two is the only time the old image can hit a `NOT NULL`
column it does not write.

```sh
DATABASE_URL="$PROD" node server/scripts/migrate.ts --confirm
```

**PASS** — `≡ 0001_baseline adopted (0 statements executed)`, three `+ … applied`
lines, `done — 4 migration(s) recorded as applied`.
**STOP** — `✗ <id> FAILED — rolled back`. That migration is fully rolled back
(Postgres has transactional DDL) and every earlier one stayed applied. **Do not
re-run and do not deploy.** Send me the error; the fix is forward.

### 4.5 Confirm it landed

```sh
psql "$PROD" -c "SELECT id, adopted, duration_ms FROM schema_migrations ORDER BY id;" \
             -c "SELECT name, status, club_capacity FROM leagues;" \
             -c "SELECT count(*) FILTER (WHERE league_id IS NULL) AS templates_left,
                        count(*) FILTER (WHERE league_id IS NOT NULL) AS claimed FROM players;"
```

**PASS** — four rows, `0001_baseline` with `adopted = t`, and the league/player
split matching whichever branch of §4.2/§4.3 you are in.
**STOP** — fewer than four rows, or `templates_left` and `claimed` both non-zero
when a season exists (a half-applied backfill, which should be impossible —
`0003` is one transaction).

> **Never hand-edit `schema_migrations`.** Deleting a row makes the runner
> re-execute a migration against a schema that already has it, which fails
> loudly at best.

---

## 5. STEP 4 — DEPLOY

```sh
fly deploy
```

Builds the repo Dockerfile remotely, health-checks `/api/health`, promotes. The
app is `football-manager---594q` — `fly.toml` already names it, so `fly deploy`
from the repo root targets the right app. Brief downtime on one machine.

```sh
fly status
fly checks list
curl -s https://football-manager---594q.fly.dev/api/health
```

**PASS** — one machine `started`, checks `passing`, and `{"ok":true}`. That
endpoint runs `SELECT 1` through the shared pool, so it covers the database
connection, not just HTTP.
**STOP** — `{"ok":false}` or a 503: the process is up but cannot reach Postgres.
Check `DATABASE_URL`. Do not proceed to DNS.

---

## 6. STEP 5 — THE BOOT LOG (the four banners)

```sh
fly logs | head -40
```

**Send me the first 40 lines.** Then grep for these four. Each is one line in
`server/league-server.ts`; the string is what to search for and the meaning is
what it costs you.

| Grep for | Source | If present on production |
| --- | --- | --- |
| `TEST OVERRIDE ACTIVE: auction lots close in` | `league-server.ts:52-56` | **STOP.** Lots close in seconds instead of 120s/20s. Auction is unplayable as designed. `fly secrets unset AUCTION_LOT_SECONDS_TEST` (or remove from `[env]`), redeploy. |
| `TEST OVERRIDE ACTIVE: matchweek cadence` | `league-server.ts:62-65` | **STOP.** Newly generated schedules use minutes, not 7 days. Existing matchweeks keep their deadlines, so this poisons the *next* schedule — the auction-completion one. `fly secrets unset MATCHWEEK_CADENCE_MINUTES_TEST`. |
| `TEST OVERRIDE ACTIVE: POST /api/admin/force-week-close is LIVE` | `league-server.ts:68-71` | **STOP, hardest of the three.** Any logged-in manager can close and simulate the current matchweek on demand with `{"confirm":"SIM NOW"}`. `fly secrets unset TEST_FORCE_WEEK_CLOSE`. |
| `SIM_ENGINE=agent — the spatial sim is live` | `league-server.ts:84-87` | **STOP.** This is §0.2. The uncalibrated engine would be simulating real matches against the shipping ruling. `fly secrets unset SIM_ENGINE`. |

Or in one pass:

```sh
fly logs | grep -E "TEST OVERRIDE ACTIVE|SIM_ENGINE=agent|RESEND_API_KEY not set"
```

**PASS** — no output at all.

One more line, not a banner but worth knowing:

| `RESEND_API_KEY not set — password-reset links only go to stdout` | `league-server.ts:38` | Password resets are dead. Not a stop for the sitting itself, but you cannot send a reset link until it is fixed. |

Belt and braces — the banners only print if the process read the var, so also
check the source of truth:

```sh
fly config show   # or: fly secrets list
```

**PASS** — none of `AUCTION_LOT_SECONDS_TEST`, `MATCHWEEK_CADENCE_MINUTES_TEST`,
`TEST_FORCE_WEEK_CLOSE`, `SIM_ENGINE` appears in `[env]` or the secret list, and
none of the four banners is in the log.
**STOP** — any of them present.

---

## 7. STEP 6 — THE DEPLOYED BUNDLE

The hash is a pure function of the source, so it only proves anything if you
build the **same commit** with a clean tree.

```sh
git status --short                    # must be empty
pnpm --filter @fm/web build
ls web/dist/assets/index-*.js         # → the hash you expect
curl -s https://football-manager---594q.fly.dev/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```

**PASS** — the two hashes are identical.
**STOP** — they differ. The machine is serving an older image: the deploy did not
promote, or it built a different commit. Re-check `fly status` for the release
and redeploy. Do not send anyone the URL.

For reference, the live bundle on 2026-08-13, before this sitting, was
`index-2lxYCwkN.js`.

---

## 8. STEP 7 — DNS, THE CERT, AND THE DOMAIN

State on 2026-08-13, verified:

```
$ dig +short topfootballgame.com A          →  (nothing)
$ dig +short topfootballgame.com AAAA       →  (nothing)
$ dig +short www.topfootballgame.com A      →  (nothing)
$ dig +short topfootballgame.com NS         →  elisa.ns.cloudflare.com.
                                               kianchau.ns.cloudflare.com.
```

Cloudflare holds the zone and the apex has no address record at all, while
`fly.toml` already sets `BASE_URL = "https://topfootballgame.com"`. That is the
live bug: the branded URL does not resolve, and every reset link the server mints
points into nothing.

1. Allocate and request:

```sh
fly ips allocate-v4 --shared
fly ips allocate-v6
fly ips list                 # note the v4 and v6
fly certs add topfootballgame.com
```

2. In Cloudflare DNS, **DNS-only (grey cloud)** at the apex:

```
A     @   <v4 from fly ips list>
AAAA  @   <v6 from fly ips list>
```

Grey cloud is not a preference. Fly terminates TLS with its own Let's Encrypt
cert and issuance is unreliable behind Cloudflare's proxy; Fly already does
HTTPS and the HTTP→HTTPS redirect (`force_https = true`).

3. Wait and check:

```sh
fly certs check topfootballgame.com
dig +short topfootballgame.com A
dig +short topfootballgame.com AAAA
curl -s https://topfootballgame.com/api/health
```

**Send me the dig output and the curl.**
**PASS** — `dig` returns the exact addresses `fly ips list` printed, the cert
reports issued, and the curl returns `{"ok":true}`.
**STOP** — `dig` returns a Cloudflare proxy address (104.x / 172.67.x) instead of
Fly's: the record is orange-clouded. Grey it and re-check the cert.
**STOP** — cert stuck `awaiting configuration` for more than ~15 minutes with
correct records: do not hand out the URL; the browser will show a TLS error,
which is worse than a dead name.

> `www` is not configured and this runbook does not configure it. Advertise the
> apex only. Adding `www` later means a CNAME **and** a second `fly certs add`.

---

## 9. STEP 8 — CREATE THE LEAGUE (two paths — choose before you start)

§0.3: there are now two, and they are mutually exclusive for a first season.

### 9.1 The seeded path — `setup-production.ts`

Unchanged and still correct. It refuses unless the database is a virgin league
(players present, **zero** seasons, **zero** clubs), so on a database that has
just been through §4.2 (a season exists) **it will refuse, by design**.

```sh
# from server/, with a clubs.json you wrote (shape: scripts/clubs.example.json)
cd server
DATABASE_URL="$PROD" node scripts/setup-production.ts clubs.json           # dry-run
DATABASE_URL="$PROD" node scripts/setup-production.ts clubs.json --apply
cd ..
```

Managers then **sign up at the site with the same email address** to claim their
seeded club (§0.4 — no link, no magic). Ignore the script's closing
`next: managers log in via magic link` line; it is stale text in a `console.log`.

**PASS** — the dry-run prints `pool N unclaimed templates (GK …, DF …, MF …, FW …)`
and one line per club, then `--apply` prints the season id, the schedule shape
and who nominates first.
**STOP** — `a season already exists … refusing`, or `player pool is EMPTY`, or
`no UNCLAIMED players: all N player row(s) already belong to a league`. Each means
the database is not in the state this script is for; re-read §3.

> **The word `templates` in that line is load-bearing, and it is new.** Until
> 2026-08-14 this script counted every `players` row while `setupSeason` claimed
> only `league_id IS NULL` — so on a database whose pool had been claimed, the
> dry-run said `pool 120 players` and `--apply` refused with `MF has 0 in the
> pool`, seconds apart. Both now read the same predicate. **If you ever see those
> two disagree again, stop: it is the same family of defect and the numbers are
> the symptom.**

> **AND IF YOU ARE TEMPTED BY `reset-league.ts` (DEPLOY.md §1.5) — read its
> dry-run first.** It empties EVERY league on the database, not one, and it names
> them all in the plan. On the sitting's database that is a single "Original
> league", so it does what you expect. After phase 4 it is not: it now **refuses
> outright** when a non-local database holds more than one league, and it no
> longer treats "no season" as safe when clubs exist, because a lobby has members
> and a join code and no season. If you ever see `✗ REFUSE — N leagues on a
> non-local database`, that is working as intended; there is no flag to override
> it.

### 9.2 The self-serve path — the lobby

Available in the API on `main` today (`POST /api/leagues`,
`POST /api/leagues/join`); the **screen** that drives it is on
`feat/lobby-create-join` and is not merged (§1). If you deploy that branch's
merge, the sitting's last step becomes: you sign up, create the league in the
app, and send the other managers the six-character join code. No `clubs.json`, no
emails, and the pool copy is the `'league'`-sourced one described in §4.2.

The host starts the season from the lobby at **two or more clubs** — capacity is
a ceiling, not a quorum.

---

## 10. EVERYTHING I NEED FROM YOU, IN ONE LIST

Send these six, in this order. Each is quoted verbatim above with its own pass
and stop conditions.

| # | What | Where | Good | Stop |
| --- | --- | --- | --- | --- |
| 0 | the restore census from `scripts/verify-backup.sh` | §2.2 | `✓ RESTORE VERIFIED` and a census that looks like your league | anything else — you have no rollback |
| 1 | the state read | §3 | matches one of the first three table rows | `has_leagues=t, managed=f`, or `players = 0` |
| 2 | the migrate dry-run plan | §4.1 | `state unmanaged`, adopt `0001` + run `0002/0003/0004`, `✓ baseline verified` | any `✗`, or `state empty` |
| 3 | the first 40 boot lines | §6 | none of the four banners | any banner |
| 4 | the deployed bundle hash | §7 | identical to the local build of the same commit | any difference |
| 5 | the `dig` output + apex health curl | §8 | Fly's own v4/v6 and `{"ok":true}` | Cloudflare proxy IPs, or a stuck cert |

---

## 11. ROLLBACK — AND WHAT CANNOT BE ROLLED BACK

### 11.1 What is recoverable

**Code.** `fly deploy` promotes a release; the previous image is still in the
registry.

```sh
fly releases                       # find the previous version and its image ref
fly deploy --image <previous image ref>
```

> **The only command in this runbook I could not run** (the Fly CLI was out of
> scope for writing it). Confirm the flag against `fly deploy --help` on your
> flyctl version before you need it in anger — `fly releases` itself is safe to
> run any time, so check it now rather than mid-incident.

Rolling the code back does **not** roll the schema back, and old code against the
new schema is §0.6's failure — so a code rollback after §4 is only a stopgap for
an application bug, never a fix for a bad migration.

**Data — the real rollback, and the only one for a migration.** There are no
down-migrations by decision. The path is the encrypted dump from §2:

```sh
# 0. PROVE THE ARTIFACT FIRST. You are about to drop the live schema; find out
#    that the dump is broken BEFORE that, not after. Costs ~30 seconds.
BACKUP_PASSPHRASE='...' scripts/verify-backup.sh league-2026-08-13.sql.gz.enc

# 1. STOP WRITES. pg-boss timers keep firing on a live machine.
fly scale count 0

# 2. decrypt
export BACKUP_PASSPHRASE='...'
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
  -in league-2026-08-13.sql.gz.enc | gunzip > league.sql

# 3. the dump has no DROP statements — it restores into an EMPTY schema only.
#    THIS IS ITSELF DESTRUCTIVE and is the point of no return in the other
#    direction: everything currently in the database is discarded.
psql "$PROD" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
             -c 'DROP SCHEMA IF EXISTS pgboss CASCADE;'
psql "$PROD" -v ON_ERROR_STOP=1 -f league.sql

# 4. back up
fly scale count 1
```

Restore with a `psql` **at least as new as the `pg_dump` that wrote the file** —
the dump carries a `\restrict` header an older client rejects. The workflow dumps
with `postgres:17-alpine`; `scripts/verify-backup.sh` restores with the same
image for exactly this reason (override with `PG_IMAGE=` if you already hold a
suitable one).

pg-boss rebuilds its own `pgboss` schema on boot. The dump is
`--no-owner --no-privileges`, so it also restores cleanly into a **fresh Supabase
project** — which is the safer path when the choice exists, because it never
issues a `DROP` against the database you are trying to save, and it is the only
path if the project itself is lost.

> **A restore puts you back before the migration in every sense.**
> `schema_migrations` lives in `public` too, so the restored database is
> `state unmanaged` again and the schema is the pre-`0003` one. The currently
> deployed code would then be new code against an old schema — §0.6 in reverse,
> and a 500. After any restore: roll the code back first, or re-run §4 before
> serving traffic.

### 11.2 What is NOT recoverable

Read this before typing `--confirm`; it is the whole reason the backup comes
first.

- **`0003`'s backfill is one-way, and no forward fix can undo it.** Once every
  `players` row is stamped with "Original league", nothing records which of them
  were unclaimed templates a minute earlier. `league_id IS NULL` *was* the
  distinction; after the backfill it is gone, and you cannot reconstruct it by
  looking at contracts — the uncontracted pool players were claimed too. The only
  way back to a template pool is the §11.1 restore.
- **Everything written after the dump.** A restore is a point-in-time revert.
  Every signup, bid, tactic submission, result and reset token created since §2's
  artifact is discarded. On the free Supabase plan there is no PITR to fill the
  gap — that is why the sitting starts with a fresh, hand-triggered backup rather
  than trusting last night's.
- **Three dropped global uniqueness constraints.** `0003` drops
  `seasons_number_key`, `clubs_name_key` and `players_full_name_birth_date_key`
  and replaces them with per-league ones. Restoring them later is only possible
  if the data still happens to satisfy them, which stops being true the moment a
  second league exists.
- **A partially-applied chain does not exist, and that is a guarantee.** Each
  migration runs in its own transaction, so a failure rolls that one back
  entirely and leaves the earlier ones applied and recorded. The database is
  never in a state no migration produced.
- **An applied migration is immutable.** Editing an applied file makes the runner
  refuse to run at all (checksum mismatch); the database cannot be re-run to
  match it. Fix forward with a new numbered migration, always.

---

## 12. THE WHOLE SITTING, IN ORDER

```sh
# 0 — clean tree on the commit you intend to ship
git fetch origin && git status --short && git log --oneline -1 origin/main
export PROD='postgresql://…pooler.supabase.com:5432/postgres?sslmode=require'

# 1 — TAKE THE BACKUP BY HAND, then PROVE IT RESTORES              (§2)
export BACKUP_PASSPHRASE='<same value as the repo secret>'
OUT="league-$(date -u +%F)-pre-sitting.sql.gz.enc"
docker run --rm postgres:17-alpine \
  pg_dump --no-owner --no-privileges --dbname "$PROD" \
  | gzip | openssl enc -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE > "$OUT"
scripts/verify-backup.sh "$OUT"      # must end: ✓ RESTORE VERIFIED

# 2 — read the state; send it                                     (§3)
psql "$PROD" -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS managed, …"

# 3 — dry-run; send the plan                                      (§4.1)
DATABASE_URL="$PROD" node server/scripts/migrate.ts

# 4 — apply, then immediately deploy                              (§4.4, §5)
DATABASE_URL="$PROD" node server/scripts/migrate.ts --confirm
fly deploy

# 5 — prove the boot                                              (§5, §6)
fly status && fly checks list
curl -s https://football-manager---594q.fly.dev/api/health
fly logs | head -40
fly config show

# 6 — prove the bundle                                            (§7)
pnpm --filter @fm/web build && ls web/dist/assets/index-*.js
curl -s https://football-manager---594q.fly.dev/ | grep -o 'index-[A-Za-z0-9_-]*\.js'

# 7 — make the domain resolve                                     (§8)
fly ips allocate-v4 --shared && fly ips allocate-v6 && fly ips list
fly certs add topfootballgame.com
#   … add the A + AAAA records in Cloudflare, DNS-only …
fly certs check topfootballgame.com
dig +short topfootballgame.com A && curl -s https://topfootballgame.com/api/health

# 8 — the league                                                  (§9)
```

---

## Appendix — how this document was verified

- `docs/DEPLOY.md`, `server/scripts/migrate.ts`, `server/scripts/migrate-plan.ts`,
  `server/scripts/setup-production.ts`, `server/migrations/0001..0004`,
  `server/league-server.ts`, `server/league-test-overrides.ts`,
  `.github/workflows/backup.yml` and `fly.toml` re-read in full at `1a8f93d9`.
- The migration chain was **run**, not reasoned about: a scratch database built
  from `migrations/0001_baseline.sql` (production's actual shape), seeded once
  with a live league and once with a pool-and-no-season, then migrated. §4.2 and
  §4.3 are that output.
- `copyPoolInto`'s post-migration behaviour was executed against the migrated
  probe, not inferred: `copied 40 from source 'league'`.
- The live app was probed read-only: health, the served bundle name, and `dig`.
  Nothing on Fly, Cloudflare or Supabase was changed.
- `pnpm playable` on `main` @ `1a8f93d9`: **41 assertions, 0 failures**, two
  leagues driven to a complete match — the loop closes on the commit this
  runbook deploys.
- **The restore path in §2.2 and §11.1 was executed, not described.** A rich
  local database (2 leagues, 4 clubs, 68 players, 52 contracts, 4 played
  fixtures) was dumped with the workflow's own pipeline, encrypted, then
  restored into a throwaway container: every row count matched. Both restore
  targets were tested — a brand-new database, and one wiped with
  `DROP SCHEMA public CASCADE; CREATE SCHEMA public`.
- Verified on the script's own default, `postgres:17-alpine`, restoring a dump
  written by `pg_dump` 16 — the direction that matters (a client no older than
  the server on the way out, a server no older than the dump on the way back).
- **And the failure that looks like success was constructed and caught.** A
  truncated dump — valid encryption, valid gzip, 2 000 lines of perfectly good
  SQL, 281 KB — is rejected by the completion-marker check with exit 1 before
  any restore is attempted. Five other failure modes (wrong passphrase, corrupt
  file, tiny file, random bytes, no passphrase) all exit non-zero with named
  messages.
