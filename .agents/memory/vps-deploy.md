---
name: VPS self-host deploy (hmeriweb.xyz)
description: Gotchas for deploying this monorepo to the user's external VPS without breaking the co-hosted punjab-case-management site.
---

# Self-hosting this monorepo on an external VPS

**Why:** The user runs a fresh standalone deploy of the WhatsApp panel (api-server + support-connect) on their own Ubuntu VPS, alongside an unrelated `punjab-case-management` nginx site that must never be touched.

## Replit DATABASE_URL is NOT portable
The Replit-provided `DATABASE_URL` secret points to internal host **`helium`**, which only resolves inside Replit's network (`getaddrinfo EAI_AGAIN helium` off-platform). Any external/self-host deploy must provision its **own** Postgres (installed local PostgreSQL, created role+db `shoib`, wrote a localhost `DATABASE_URL`, ran `drizzle-kit push`). Do not assume the secret works off-Replit.

## pnpm 11 build gotcha
`pnpm install` **exits 1** on `ERR_PNPM_IGNORED_BUILDS` (refuses until build scripts approved), and `pnpm run <script>`'s pre-run deps check re-runs install and inherits that failure — even with `verify-deps-before-run=false`. 
**How to apply:** linking still completes fine; bypass the pnpm wrapper and run build binaries directly: api = `node build.mjs`; web = `./node_modules/.bin/vite build --config vite.config.ts`. esbuild's native binary comes from its `@esbuild/linux-x64` optional dep so it works without the approved postinstall.

## PM2 stale-env trap
`pm2 restart` / `--update-env` keeps the env captured at first `pm2 start` (does NOT re-read the ecosystem/.env). After editing `.env`, you must `pm2 delete <app> && pm2 start ecosystem.config.cjs` to load changes. Verify presence via `tr '\0' '\n' < /proc/$(pm2 pid <app>)/environ | grep -c '^KEY='`.

## Runtime env the api-server needs in production
`DATABASE_URL`, `PORT`, `NODE_ENV=production`, and **`SESSION_SECRET`** (panel/admin token signing falls back to a hardcoded constant if unset → forgeable tokens). Optional: `LOG_LEVEL`, `ADMIN_USERNAME`/`ADMIN_PASSWORD` (else seeds default `admin`/`admin123`).

## Serving model on the VPS
Frontend calls root-relative `/api`; api-server serves only `/api` (no static). nginx server_name `hmeriweb.xyz`: `location /api` → 127.0.0.1:4000 (SSE: `proxy_http_version 1.1; proxy_buffering off; Connection ""; proxy_read_timeout 3600s`), `location /` → 127.0.0.1:4001 (`pm2 serve dist/public --spa`). Always `nginx -t` then `reload` (never restart) to protect the co-hosted site.

## How to push updates from Replit → VPS (no git on the VPS)
`/var/www/shoib` is NOT a git repo — it was populated by file copy, so updates are pushed from the Replit workspace, not `git pull`. **rsync is absent on Replit**, so sync with tar-over-ssh: `tar czf - --exclude=node_modules --exclude=dist --exclude='*.log' --exclude=uploads --exclude=.user-sessions --exclude=.env <paths> | ssh '... cd /var/www/shoib && tar xzf -'`. This is additive (no deletes) — fine because new revisions only add/modify files. Then on the VPS: `pnpm install` (tolerate exit 1), build via direct binaries, `drizzle-kit push` (direct binary), `pm2 delete shoib-api && pm2 start ecosystem.config.cjs` + `pm2 restart shoib-web`. `deploy-vps.sh` at repo root automates the whole flow (reads Host/Port/Username/Password secrets).
**Never sync** the VPS `.env`, `.npmrc` (has extra `verify-deps-before-run=false`), or `ecosystem.config.cjs` — they are environment-specific and live only on the VPS.

## Live URL structure (single domain, path-based — not separate subdomains)
Main app: `https://hmeriweb.xyz` · Admin panel: `https://hmeriweb.xyz/admin` (path, not a subdomain) · API: `https://hmeriweb.xyz/api` · realtime is SSE at `/api/panel/events` (no WebSocket). The DB push is the easy thing to forget on a redeploy: code that adds a table (e.g. `wa_call_logs` for the calls feature) breaks prod with `relation ... does not exist` until `drizzle-kit push` runs against the VPS `shoib` DB.

## Non-additive schema changes (PK/unique swaps) need RAW SQL in the deploy, not `drizzle-kit push` alone
`drizzle-kit push` is fine for additive columns/tables, but a PRIMARY-KEY or UNIQUE-constraint change on a populated table is risky to leave to push (it can prompt or do a destructive rebuild). For those, put a hand-written, IDEMPOTENT, single-transaction migration in `deploy-vps.sh` BEFORE the push step: `pg_dump -Fc` backup → `pm2 stop shoib-api` (maintenance window) → `BEGIN; pg_advisory_xact_lock(...)` → validate no NULLs/dupes (RAISE EXCEPTION to abort+rollback) → `ALTER ... SET NOT NULL` → `DROP CONSTRAINT IF EXISTS <old> / ADD CONSTRAINT <new>` (guard ADD with a `pg_constraint` existence check) → `DROP INDEX IF EXISTS <old> / CREATE UNIQUE INDEX IF NOT EXISTS <new>` → backfill `INSERT ... ON CONFLICT DO NOTHING` → `COMMIT;`. Run via `psql -v ON_ERROR_STOP=1`. Keep the existing `drizzle-kit push` AFTER it as a no-op verification (it should print in-sync).
**CRITICAL — match drizzle's exact auto-generated names** or the later push will see drift and try to rebuild your constraints. Get the authoritative names OFFLINE (no DB needed): `drizzle-kit generate --dialect postgresql --schema ./src/schema/index.ts --out /tmp/probe --name probe` then read the emitted SQL. For this schema they are PK `wa_chats_account_phone_jid_pk` (on account_phone,jid) and unique index `wa_messages_account_phone_wa_message_id_uq`; the OLD names dropped were `wa_chats_pkey` (inline single-col PK) and `wa_messages_wa_message_id_uq`. A clean run prints `INSERT 0 0` when nothing needs backfill and drizzle then reports "schema in sync".
**Why:** verified live — after the raw migration, push reported in-sync (names matched), proving future deploys won't destructively rebuild the keys.

## Open follow-ups (when user sets DNS A record → VPS IP)
1. `certbot --nginx -d hmeriweb.xyz -d www.hmeriweb.xyz` for SSL (blocked until DNS resolves).
2. After HTTPS forced, lock 4000/4001 to localhost (or firewall) — currently bound 0.0.0.0 so they're reachable plaintext by IP, bypassing nginx/TLS.
