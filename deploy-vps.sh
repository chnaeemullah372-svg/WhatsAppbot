#!/usr/bin/env bash
# ============================================================================
# Deploy / sync this monorepo to the production VPS (hmeriweb.xyz).
#
# Usage:   bash deploy-vps.sh
# Requires Replit secrets in the environment: Host, Port, Username, Password
#
# SAFE BY DESIGN — this script never touches production-owned files:
#   - VPS .env, .npmrc, ecosystem.config.cjs are excluded from the sync
#   - uploaded media (uploads/) and WhatsApp sessions (.user-sessions/) are kept
#   - the co-hosted punjab-case-management site is never referenced
# It only ADDS/UPDATES source files (no deletions), rebuilds, migrates the DB
# additively, and reloads the PM2 processes.
# ============================================================================
set -uo pipefail

: "${Host:?Host secret not set}"
: "${Port:?Port secret not set}"
: "${Username:?Username secret not set}"
: "${Password:?Password secret not set}"

REMOTE_DIR=/var/www/shoib
SSH=(sshpass -p "$Password" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -p "$Port" "$Username@$Host")

echo "==> [1/5] Sync source -> $REMOTE_DIR (tar over ssh; rsync is absent on Replit)"
tar czf - \
  --exclude='node_modules' --exclude='dist' --exclude='.git' \
  --exclude='*.log' --exclude='uploads' --exclude='.user-sessions' \
  --exclude='.env' \
  artifacts lib scripts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json \
  | "${SSH[@]}" "cd $REMOTE_DIR && tar xzf - && echo '    extracted OK'"

echo "==> [2/5] Install deps + build (direct binaries; bypass pnpm-run wrapper)"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -uo pipefail
cd /var/www/shoib
pnpm install >/tmp/deploy-install.out 2>&1 || true   # ERR_PNPM_IGNORED_BUILDS exit 1 is expected; linking still completes
( cd artifacts/api-server && node build.mjs >/tmp/deploy-apibuild.out 2>&1 ) \
  && echo "    API build OK" || { echo "    API BUILD FAILED"; tail -20 /tmp/deploy-apibuild.out; exit 1; }
( cd artifacts/support-connect && ./node_modules/.bin/vite build --config vite.config.ts >/tmp/deploy-webbuild.out 2>&1 ) \
  && echo "    WEB build OK" || { echo "    WEB BUILD FAILED"; tail -20 /tmp/deploy-webbuild.out; exit 1; }
REMOTE
[ $? -eq 0 ] || { echo "Build step failed; aborting before restart."; exit 1; }

echo "==> [3/6] Per-number isolation migration (backup -> stop api -> transactional schema swap + backfill)"
# Stop the API first so no writes hit the tables mid-swap, then run one atomic,
# IDEMPOTENT transaction: validate -> enforce NOT NULL -> swap wa_chats PK to
# (account_phone, jid) -> swap wa_messages unique to (account_phone, wa_message_id)
# -> backfill missing per-account chat rows from wa_messages. Safe to re-run.
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -uo pipefail
cd /var/www/shoib
DATABASE_URL="$(grep '^DATABASE_URL=' /var/www/shoib/.env | cut -d= -f2-)"; export DATABASE_URL

mkdir -p /var/www/shoib/backups
BACKUP="/var/www/shoib/backups/wa_pre_isolation_$(date +%Y%m%d_%H%M%S).dump"
echo "    backing up DB -> $BACKUP"
pg_dump "$DATABASE_URL" -Fc -f "$BACKUP" && echo "    backup OK ($(du -h "$BACKUP" | cut -f1))" \
  || { echo "    BACKUP FAILED — aborting migration"; exit 1; }

echo "    stopping shoib-api (maintenance window begins)"
pm2 stop shoib-api >/dev/null 2>&1 || true

echo "    applying migration (single transaction; rolls back on any error)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(911002);

-- 1) Refuse to proceed if data would violate the new constraints ----------------
DO $$
DECLARE c bigint; m bigint;
BEGIN
  SELECT count(*) INTO c FROM wa_chats    WHERE account_phone IS NULL;
  SELECT count(*) INTO m FROM wa_messages WHERE account_phone IS NULL;
  IF c > 0 OR m > 0 THEN
    RAISE EXCEPTION 'ABORT: NULL account_phone (wa_chats=%, wa_messages=%)', c, m;
  END IF;
END $$;
DO $$
DECLARE d bigint;
BEGIN
  SELECT count(*) INTO d FROM (
    SELECT 1 FROM wa_chats GROUP BY account_phone, jid HAVING count(*) > 1
  ) x;
  IF d > 0 THEN RAISE EXCEPTION 'ABORT: % duplicate (account_phone,jid) in wa_chats', d; END IF;
END $$;
DO $$
DECLARE d bigint;
BEGIN
  SELECT count(*) INTO d FROM (
    SELECT 1 FROM wa_messages GROUP BY account_phone, wa_message_id HAVING count(*) > 1
  ) x;
  IF d > 0 THEN RAISE EXCEPTION 'ABORT: % duplicate (account_phone,wa_message_id) in wa_messages', d; END IF;
END $$;

-- 2) Enforce NOT NULL (idempotent) ---------------------------------------------
ALTER TABLE wa_chats    ALTER COLUMN account_phone SET NOT NULL;
ALTER TABLE wa_messages ALTER COLUMN account_phone SET NOT NULL;

-- 3) Swap wa_chats primary key  jid-only -> (account_phone, jid) ----------------
ALTER TABLE wa_chats DROP CONSTRAINT IF EXISTS wa_chats_pkey;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_chats_account_phone_jid_pk') THEN
    ALTER TABLE wa_chats ADD CONSTRAINT wa_chats_account_phone_jid_pk PRIMARY KEY (account_phone, jid);
  END IF;
END $$;

-- 4) Swap wa_messages unique  (wa_message_id) -> (account_phone, wa_message_id) -
DROP INDEX IF EXISTS wa_messages_wa_message_id_uq;
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_account_phone_wa_message_id_uq
  ON wa_messages (account_phone, wa_message_id);

-- 5) Backfill: every (account_phone, jid) that has messages must have a chat row.
--    Old jid-only schema kept ONE chat row per contact, so the same contact's
--    messages under a second account had no chat. Recreate them, copying the
--    contact's display name from any existing same-jid chat row.
INSERT INTO wa_chats (account_phone, jid, phone, name, saved_name, last_msg, last_msg_ts)
SELECT m.account_phone,
       m.jid,
       split_part(m.jid, '@', 1)        AS phone,
       nm.name,
       nm.saved_name,
       m.text                           AS last_msg,
       m.ts                             AS last_msg_ts
FROM (
  SELECT DISTINCT ON (account_phone, jid)
         account_phone, jid, text, ts
  FROM wa_messages
  WHERE jid NOT LIKE '%@broadcast'
  ORDER BY account_phone, jid, ts DESC
) m
LEFT JOIN LATERAL (
  SELECT name, saved_name
  FROM wa_chats c
  WHERE c.jid = m.jid AND (c.name IS NOT NULL OR c.saved_name IS NOT NULL)
  LIMIT 1
) nm ON true
ON CONFLICT (account_phone, jid) DO NOTHING;

COMMIT;
SQL
[ $? -eq 0 ] && echo "    migration committed OK" || { echo "    MIGRATION FAILED (rolled back)"; exit 1; }
REMOTE
[ $? -eq 0 ] || { echo "Migration step failed; api is stopped — fix DB then re-run deploy. Aborting."; exit 1; }

echo "==> [4/6] DB schema push (drizzle; should report in-sync after migration)"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -uo pipefail
cd /var/www/shoib/lib/db
DATABASE_URL="$(grep '^DATABASE_URL=' /var/www/shoib/.env | cut -d= -f2-)"; export DATABASE_URL
BIN=./node_modules/.bin/drizzle-kit; [ -x "$BIN" ] || BIN=../../node_modules/.bin/drizzle-kit
"$BIN" push --config ./drizzle.config.ts </dev/null && echo "    schema in sync"
REMOTE

echo "==> [5/6] Restart PM2 (delete+start reloads .env into shoib-api; ends maintenance window)"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -uo pipefail
cd /var/www/shoib
pm2 delete shoib-api >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs >/dev/null && echo "    shoib-api started"
pm2 restart shoib-web >/dev/null 2>&1 && echo "    shoib-web restarted"
pm2 save >/dev/null 2>&1 && echo "    pm2 state saved"
REMOTE

echo "==> [6/6] Verify"
sleep 3
curl -fsS -m15 https://hmeriweb.xyz/api/healthz >/dev/null && echo "    https://hmeriweb.xyz/api/healthz -> OK"
echo "Deploy complete."
