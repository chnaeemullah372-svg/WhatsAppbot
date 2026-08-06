---
name: monorepo db package build gotcha
description: Why api-server typecheck reads stale @workspace/db types after a schema edit, and the fix.
---

# @workspace/db schema edits need a declaration rebuild before api-server typechecks

After editing a table in `lib/db/src/schema/*.ts` (e.g. adding columns), the
`@workspace/db` package exports raw `.ts` (`exports` map points at `src/...`),
so **runtime** picks up the change immediately. But **typecheck does not**:
`lib/db/tsconfig.json` is `composite` + `emitDeclarationOnly` → it emits `.d.ts`
into `lib/db/dist`, and the artifacts (api-server) consume it via TS **project
references**, which resolve to that stale `dist/*.d.ts`.

**Symptom:** `pnpm --filter @workspace/api-server run typecheck` fails with
`Property 'quotedSender' does not exist on type 'PgTableWithColumns<...>'`
(or `... in PgUpdateSetSource`) even though the source schema clearly has it,
and `support-connect` typecheck passes.

**Fix:** rebuild the db declarations first: `npx tsc -b lib/db` (or root
`pnpm run typecheck:libs` / `tsc --build`), then re-run the artifact typecheck.

**Why:** the artifact tsconfig uses `references` to `lib/db`, not a path alias to
its source, so its type view is whatever is in `dist`.
**How to apply:** any time you change `lib/db/src/schema`, run `npx tsc -b lib/db`
before typechecking/building api-server. Also still run `drizzle-kit push`
(`pnpm --filter @workspace/db run push`) to apply the columns to the actual DB —
that is a separate step from the declaration rebuild.
