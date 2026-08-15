#!/usr/bin/env bash
# verify-backup.sh — PROVE an encrypted dump is restorable. Not that it exists,
# not that the job was green: that this exact file, with this exact passphrase,
# rebuilds the league.
#
#   BACKUP_PASSPHRASE='…' scripts/verify-backup.sh league-2026-08-15.sql.gz.enc
#
# Exit 0 = restored, and the row census is printed. Any other exit = do not
# trust this artifact. It never connects to production and writes nothing
# outside a throwaway container.
#
# ── IT RESTORES THE WAY THE ROLLBACK RESTORES, WHICH IS THE POINT ───────────
# The first version of this script was proven against a `pnpm playable`
# database and NOT against a Supabase dump, and a Supabase dump broke it two
# different ways:
#
#   unrestricted      →  extension "supabase_vault" is not available
#   --schema=public   →  schema "public" already exists
#
# Both are now designed out rather than tolerated, and the fix is in the DUMP as
# much as in the target (see scripts/take-backup.sh):
#
#   · THE DUMP IS SCOPED TO THE SCHEMAS WE OWN — `public` and `pgboss`. Supabase
#     owns `auth`, `storage`, `graphql`, `vault`, `extensions` and the extensions
#     inside them; those already exist in any project we would restore into, and
#     `supabase_vault` cannot be installed anywhere else at all. A scoped dump
#     emits no CREATE EXTENSION line, so the blocker is gone BY CONSTRUCTION.
#   · AND THE TARGET DROPS `public` FIRST, because a scoped dump carries
#     `CREATE SCHEMA public;` and a fresh database already has one. That is not a
#     workaround: dropping what we own is exactly what the rollback does to a
#     live project before restoring into it (runbook §11). This script therefore
#     rehearses the real sequence rather than an easier one.
#
# NO TOLERANCE WAS ADDED ANYWHERE. `ON_ERROR_STOP=1` still stops on the first
# error, and no SQL is filtered out of the dump — an earlier restore only
# "worked" by grepping `CREATE SCHEMA public;` away, which is a workaround and
# was never a verified backup.

set -euo pipefail

ENC="${1:-}"
CONTAINER=fm-backup-verify
PGPASS=verify
IMAGE="${PG_IMAGE:-postgres:17-alpine}"   # override if you already hold a suitable image

die() { echo "✗ $*" >&2; exit 1; }

[ -n "${ENC}" ] || die "usage: BACKUP_PASSPHRASE='…' scripts/verify-backup.sh <league-YYYY-MM-DD.sql.gz.enc>"
[ -f "${ENC}" ] || die "no such file: ${ENC}"
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is not set — it is the repo secret of the same name, in your password manager"
command -v docker >/dev/null || die "docker is required (the restore runs in a throwaway container)"

SIZE=$(wc -c < "${ENC}" | tr -d ' ')
echo "verify-backup — ${ENC} (${SIZE} bytes)"
[ "${SIZE}" -gt 1024 ] || die "the artifact is ${SIZE} bytes. That is not a database."

WORK=$(mktemp -d)
# The trap must PRESERVE the exit status. A cleanup whose last command succeeds
# can report 0 out of a failed run — which is the exact defect this script
# exists to catch, and it does not get to have it too.
cleanup() {
  rc=$?
  rm -rf "${WORK}"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT

# ── 0. the passphrase goes in a FILE, never in argv and never in `env:` ──────
# `-pass env:BACKUP_PASSPHRASE` is correct openssl and works — but it is the one
# idiom in the shell where a `$` is WRONG, and typing `-pass env:$BACKUP_PASSPHRASE`
# makes the shell expand it first: openssl then reports `Can't read environment
# variable <your passphrase>`, prints it in the clear, and the redirect still
# leaves a zero-byte artifact behind. That happened. `-pass pass:…` is worse —
# it puts the secret in the process list for anyone running `ps`.
# `file:` takes a `$` the way every other command does, keeps the secret out of
# argv, and behaves the same on LibreSSL (macOS) and OpenSSL 3 (CI).
PASSFILE="${WORK}/pass"
(umask 077; printf '%s' "${BACKUP_PASSPHRASE}" > "${PASSFILE}")

# ── 1. decrypt + decompress ─────────────────────────────────────────────────
# Two steps, not one pipe into psql: a pipe hides WHICH stage failed, and this
# is the one moment you need to know.
echo "  1. decrypting..."
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"${PASSFILE}" -in "${ENC}" > "${WORK}/league.sql.gz" \
  || die "decryption failed. Wrong BACKUP_PASSPHRASE, or the file is not one of ours."
gunzip -c "${WORK}/league.sql.gz" > "${WORK}/league.sql" \
  || die "decrypted, but not valid gzip — the artifact is corrupt."

# ── 2. is the dump WHOLE? ───────────────────────────────────────────────────
# pg_dump writes this as its last line. A dump cut short by a dropped connection
# decrypts and gunzips perfectly and is missing rows in silence.
echo "  2. checking the dump is complete..."
grep -q '^-- PostgreSQL database dump complete' "${WORK}/league.sql" \
  || die "the dump has no completion marker — it was cut short. DO NOT TRUST IT."
echo "     $(wc -l < "${WORK}/league.sql" | tr -d ' ') lines, complete"

# ── 3. what shape is this dump, before we try to restore it? ────────────────
# A dump that carries schemas we do not own cannot restore into stock Postgres,
# and must not be restored into a live Supabase project either. Say so here
# rather than failing forty seconds later with a Postgres error.
FOREIGN=$(grep -c '^CREATE EXTENSION' "${WORK}/league.sql" || true)
if [ "${FOREIGN}" -gt 0 ]; then
  echo "  ✗ this dump carries ${FOREIGN} CREATE EXTENSION statement(s):" >&2
  grep '^CREATE EXTENSION' "${WORK}/league.sql" | sed 's/^/      /' >&2
  die "it was taken UNSCOPED. Supabase's own extensions (supabase_vault) cannot be installed elsewhere, and are already present in any project you would restore into. Re-take it with scripts/take-backup.sh, which scopes the dump to public + pgboss."
fi

# ── 4. restore it, for real ─────────────────────────────────────────────────
echo "  3. starting a throwaway ${IMAGE}..."
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER}" -e POSTGRES_PASSWORD="${PGPASS}" "${IMAGE}" >/dev/null \
  || die "could not start ${IMAGE}. If this machine cannot reach Docker Hub, set PG_IMAGE to an image you already hold — it must be at least as new as the pg_dump that wrote the artifact."
for _ in $(seq 1 60); do
  docker exec "${CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 || die "the verification container never became ready"

echo "  4. restoring into an empty database (public dropped first — the rollback's own sequence)..."
docker exec "${CONTAINER}" psql -U postgres -q -c 'CREATE DATABASE restored' >/dev/null
docker exec "${CONTAINER}" psql -U postgres -q -d restored -c 'DROP SCHEMA public CASCADE' >/dev/null
docker exec -i "${CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null -d restored < "${WORK}/league.sql" \
  || die "the restore FAILED. This artifact will not bring the league back."

# ── 5. count what came back — AND DEGRADE, DO NOT CRASH ─────────────────────
# The census used to name `leagues` unconditionally and died with `relation
# "leagues" does not exist` on a PRE-0003 dump — which is the single artifact it
# most needs to verify, the one taken the moment before the migration. It now
# counts whatever the schema actually has and says which version it found.
echo "  5. census of the restored league:"
docker exec -i "${CONTAINER}" psql -U postgres -d restored -X <<'SQL'
SELECT string_agg(
         format('SELECT %L::text AS "table", count(*)::text AS rows FROM public.%I', relname, relname),
         E'\nUNION ALL ' ORDER BY relname) || E'\nORDER BY 1'
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND relname IN ('accounts','club_identities','clubs','contracts','fixtures','half_results',
                  'leagues','managers','players','schema_migrations','seasons','sessions','squad_players')
\gexec
SQL

VERSION=$(docker exec "${CONTAINER}" psql -U postgres -At -d restored -c "
  SELECT CASE
    WHEN to_regclass('public.leagues')         IS NOT NULL THEN '0003+ — leagues exist; the migration HAS been applied'
    WHEN to_regclass('public.club_identities') IS NOT NULL THEN '0002 — club_identities but no leagues'
    WHEN to_regclass('public.accounts')        IS NOT NULL THEN 'PRE-0003 baseline — accounts, no club_identities, no leagues'
    ELSE 'older than the baseline — no accounts table'
  END || CASE WHEN to_regclass('public.schema_migrations') IS NOT NULL
              THEN ' (tracked by schema_migrations)' ELSE ' (untracked)' END" | tr -d '\r')
echo "     schema: ${VERSION}"

PLAYERS=$(docker exec "${CONTAINER}" psql -U postgres -At -d restored -c \
  "SELECT count(*) FROM public.players" 2>/dev/null | tr -d '\r' || echo 0)
[ "${PLAYERS:-0}" -gt 0 ] || die "the restore succeeded but the player pool is EMPTY. That is not the league."

echo "✓ RESTORE VERIFIED — this artifact rebuilds the league. Keep it and its passphrase together."
