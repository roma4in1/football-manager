#!/usr/bin/env bash
# take-backup.sh — take the backup, and prove it, in one command.
#
#   BACKUP_PASSPHRASE='…' DATABASE_URL='<session-pooler url>' scripts/take-backup.sh
#
# Writes league-YYYY-MM-DD-<label>.sql.gz.enc in the current directory and then
# hands it straight to scripts/verify-backup.sh. Nothing is written to the
# database; `pg_dump` is a read.
#
# ── WHY THIS EXISTS AS A SCRIPT AND NOT AS A LINE IN A RUNBOOK ──────────────
# The hand-typed form failed twice in ways a script cannot:
#
#  · `-pass env:BACKUP_PASSPHRASE` is correct openssl, but it is the one shell
#    idiom where a `$` is WRONG. Typed as `-pass env:$BACKUP_PASSPHRASE` the
#    shell expands it first, openssl reports `Can't read environment variable
#    <your passphrase>` — printing the secret — and the redirect leaves a
#    ZERO-BYTE artifact that looks like a backup. `-pass file:` takes the `$`
#    the way everything else does and keeps the secret out of `ps`.
#  · An interactive shell has no `pipefail`, so `pg_dump | gzip | openssl > out`
#    reports success when pg_dump dies. Here the pipeline is guarded and the
#    output is size-checked before anyone can trust it.
#
# ── AND THE DUMP IS SCOPED, WHICH IS A DECISION ─────────────────────────────
# `--schema=public --schema=pgboss` — the two schemas this app owns. Supabase
# owns auth/storage/graphql/vault/extensions and the extensions inside them; an
# unrestricted dump carries `CREATE EXTENSION supabase_vault`, which cannot be
# installed in stock Postgres (so no verifier can restore it) and must not be
# re-created in a Supabase project (it is already there). Scoped, the dump
# contains exactly what a rollback has to put back. pg_dump tolerates `pgboss`
# being absent as long as one pattern matches, so this is safe before pg-boss
# has ever booted.

set -euo pipefail

LABEL="${1:-pre-sitting}"
OUT="league-$(date -u +%F)-${LABEL}.sql.gz.enc"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "✗ $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required (the Supabase session-pooler string — docs/DEPLOY.md §1.2)"
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is required — the same value as the repo secret, from your password manager"
command -v docker >/dev/null || die "docker is required (pg_dump runs in ${IMAGE} so the client is never older than the server)"
[ -e "${OUT}" ] && die "${OUT} already exists — move it aside rather than overwriting a backup"

WORK=$(mktemp -d)
cleanup() { rc=$?; rm -rf "${WORK}"; exit "${rc}"; }
trap cleanup EXIT
PASSFILE="${WORK}/pass"
(umask 077; printf '%s' "${BACKUP_PASSPHRASE}" > "${PASSFILE}")

echo "take-backup — $(printf '%s' "${DATABASE_URL}" | sed 's#//[^@]*@#//…@#') → ${OUT}"
echo "  1. dumping public + pgboss with ${IMAGE}..."
set -o pipefail
if ! docker run --rm -i "${IMAGE}" \
       pg_dump --no-owner --no-privileges --schema=public --schema=pgboss --dbname "${DATABASE_URL}" \
     | gzip \
     | openssl enc -aes-256-cbc -pbkdf2 -pass file:"${PASSFILE}" \
     > "${WORK}/out.enc"; then
  die "the dump FAILED — nothing was written. (Check DATABASE_URL, and that the host is reachable.)"
fi

SIZE=$(wc -c < "${WORK}/out.enc" | tr -d ' ')
[ "${SIZE}" -gt 1024 ] || die "the dump produced ${SIZE} bytes. That is not a database — refusing to leave it lying around looking like a backup."
mv "${WORK}/out.enc" "${OUT}"
echo "  2. wrote ${OUT} (${SIZE} bytes)"

echo "  3. verifying it restores..."
"${HERE}/verify-backup.sh" "${OUT}"

echo
echo "KEEP ${OUT} AND ITS PASSPHRASE TOGETHER, AND NOT ON THE MACHINE YOU MIGHT BE RESTORING."
