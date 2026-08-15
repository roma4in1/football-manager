#!/usr/bin/env bash
# verify-backup.sh — PROVE an encrypted dump is restorable. Not that it exists,
# not that the job was green: that this exact file, with this exact passphrase,
# rebuilds the league.
#
# WHY THIS EXISTS. `.github/workflows/backup.yml` used to exit 0 with "secrets
# not configured — skipping" and upload nothing, which is indistinguishable from
# a run that worked. The rollback for a one-way migration rested on that. The
# workflow now fails loudly, but a green job still only proves the pipeline ran —
# so this script restores the artifact for real and counts the rows.
#
#   BACKUP_PASSPHRASE='…' scripts/verify-backup.sh league-2026-08-13.sql.gz.enc
#
# It restores into a THROWAWAY container (postgres:17-alpine, the same image the
# workflow dumps with — a psql older than the pg_dump that wrote the file chokes
# on its \restrict header) and removes it afterwards. It never connects to
# production and never writes anything outside Docker.
#
# Exit 0 = restored, and the row census is printed. Any other exit = do not
# trust this artifact.

set -euo pipefail

ENC="${1:-}"
CONTAINER=fm-backup-verify
PGPASS=verify
IMAGE="${PG_IMAGE:-postgres:17-alpine}"   # override if you already hold a suitable image

die() { echo "✗ $*" >&2; exit 1; }

[ -n "${ENC}" ] || die "usage: BACKUP_PASSPHRASE='…' scripts/verify-backup.sh <league-YYYY-MM-DD.sql.gz.enc>"
[ -f "${ENC}" ] || die "no such file: $ENC"
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is not set — it is the repo secret of the same name, in your password manager"
command -v docker >/dev/null || die "docker is required (the restore runs in a throwaway container)"

SIZE=$(wc -c < "${ENC}" | tr -d ' ')
echo "verify-backup — $ENC ($SIZE bytes)"
[ "${SIZE}" -gt 1024 ] || die "the artifact is $SIZE bytes. That is not a database."

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

# ── 1. decrypt + decompress ─────────────────────────────────────────────────
# Two steps, not one pipe into psql: a pipe hides WHICH stage failed, and this
# is the one moment you need to know.
echo "  1. decrypting..."
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "${ENC}" > "$WORK/league.sql.gz" \
  || die "decryption failed. Wrong BACKUP_PASSPHRASE, or the file is not one of ours."
gunzip -c "$WORK/league.sql.gz" > "$WORK/league.sql" \
  || die "decrypted, but not valid gzip — the artifact is corrupt."

# ── 2. is the dump WHOLE? ───────────────────────────────────────────────────
# pg_dump writes this as its last line. A dump cut short by a dropped connection
# decrypts and gunzips perfectly and is missing rows in silence.
echo "  2. checking the dump is complete..."
grep -q '^-- PostgreSQL database dump complete' "$WORK/league.sql" \
  || die "the dump has no completion marker — it was cut short. DO NOT TRUST IT."
echo "     $(wc -l < "$WORK/league.sql" | tr -d ' ') lines, complete"

# ── 3. restore it, for real ─────────────────────────────────────────────────
echo "  3. starting a throwaway ${IMAGE}..."
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER}" -e POSTGRES_PASSWORD="${PGPASS}" "${IMAGE}" >/dev/null \
  || die "could not start ${IMAGE}. If this machine cannot reach Docker Hub, set PG_IMAGE to an image you already hold — it must be at least as new as the pg_dump that wrote the artifact."
for _ in $(seq 1 60); do
  docker exec "${CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 || die "the verification container never became ready"

echo "  4. restoring into an empty database..."
docker exec "${CONTAINER}" psql -U postgres -q -c 'CREATE DATABASE restored' >/dev/null
docker exec -i "${CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null -d restored < "$WORK/league.sql" \
  || die "the restore FAILED. This artifact will not bring the league back."

# ── 4. count what came back ─────────────────────────────────────────────────
echo "  5. census of the restored league:"
docker exec "${CONTAINER}" psql -U postgres -d restored -c "
  SELECT (SELECT count(*) FROM leagues)   AS leagues,
         (SELECT count(*) FROM seasons)   AS seasons,
         (SELECT count(*) FROM clubs)     AS clubs,
         (SELECT count(*) FROM players)   AS players,
         (SELECT count(*) FROM contracts) AS contracts,
         (SELECT count(*) FROM fixtures)  AS fixtures,
         (SELECT count(*) FROM half_results) AS results,
         (SELECT count(*) FROM managers)  AS managers,
         (SELECT count(*) FROM accounts)  AS accounts"

EMPTY=$(docker exec "${CONTAINER}" psql -U postgres -At -d restored -c \
  "SELECT count(*) FROM players" | tr -d '\r')
[ "${EMPTY:-0}" -gt 0 ] || die "the restore succeeded but the player pool is EMPTY. That is not the league."

echo "✓ RESTORE VERIFIED — this artifact rebuilds the league. Keep it and its passphrase together."
