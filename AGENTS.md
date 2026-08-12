# Working on this repository

Rules for anyone — human or AI agent — working on Manyfold Launch. This app is derived from
[cloudflare-worker-starter](https://github.com/manyfold-open/cloudflare-worker-starter) and
keeps its deployment model and its worker-side invariants; what follows adds the ones that
only apply because this app is multi-tenant and holds other people's credentials.

## How deployment works

- **Workers Builds is the deploy path.** Every push to `main` runs `npm run build` and then
  `npx wrangler deploy` on Cloudflare's side. CI only checks; it never deploys and holds no
  credentials.
- `wrangler deploy` ships what `vite build` wrote to `dist/`. Never deploy without building
  first, and never remove the `build` script.
- After every push, verify: `GET /api/health` must return HTTP 200 JSON.

## Invariants inherited from the starter

1. **Keep `wrangler.jsonc` deployable** — `main`, `assets` and the `DB` binding are read by
   the app.
2. **Keep `GET /api/health` returning 200 JSON.** It is the deploy-verification contract,
   and it is also what this app calls on *other* deployments to check they are alive.
3. **Evolve the database only through `SCHEMA` in `src/worker/db.ts`**, with
   `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and no semicolons inside
   statement bodies. The schema is applied as one batch on every cold start, so a
   non-idempotent statement takes the whole app down — see `skills/cf-starter-dev/SKILL.md`
   for the full explanation and the column-adding workaround.
4. **Never commit secrets.** New secrets get a commented entry in `.dev.vars.example` and an
   instruction to run `npx wrangler secret put NAME`.
5. **Respect the runtime split.** `src/worker/` runs in workerd only (no Node built-ins),
   `src/app/` in the browser only, `src/shared/` in both.

## Invariants specific to this app

6. **`CONFIG_ENCRYPTION_KEY` is mandatory in any shared deployment.** The starter's
   fall-back-to-a-generated-key behaviour exists to make one-click deploys work for a
   single user's own data. Here the database holds *other people's* account tokens, so the
   key must live outside it. Do not restore the fallback for convenience.

7. **Every query that touches `projects`, `conversations` or `messages` is scoped by
   `user_id`.** `loadProject` in `src/worker/projects.ts` is deliberately the only read
   path so that this is enforced in one place; new features go through it rather than
   writing their own `SELECT`. A leak across tenants bills one user's turns to another
   user's agent.

8. **Credentials are write-only from the browser's perspective.** `toView` is the boundary:
   it must never gain a field carrying a token, a ciphertext, an IV, or a token id. There
   is a test asserting exactly this — if it fails, the product is broken, not the test.

9. **Keep the two planes apart.** The account (management) token provisions; the per-agent
   caller token converses. Never use the account token to talk to an agent, and never
   persist the caller token anywhere but its project row.

10. **Nothing bills the user except an explicit turn.** Reachability checks use
    `probeAgentAuth` (`tasks/get`), never `message/send`. `messageId` is derived from the
    stored row so a retry cannot double-charge. The bootstrap turn is the one deliberate
    exception and it is announced in the UI before it runs.

11. **Do not promise revocation you cannot perform.** Dropping our copy of a token is not
    revoking it. The wording in `DELETE /api/account` and in the UI is load-bearing.

12. **Platform 401s are informative — pass them through.** Manyfold says exactly which
    scope is missing; flattening that into "unauthorized" turns a fixable problem into a
    mystery. `toHttpError` in `src/worker/manyfold.ts` is where this is decided.

## Platform API notes that cost hours to rediscover

- A2A management from a token must use `/agent-self/a2a/*` with `?agentId=`. The web app's
  `/a2a/agents/{id}/*` routes reject API tokens outright. Exposure toggles with **PUT**;
  POST and DELETE 404.
- `/auth/me`, `/me/api-tokens` and `/agent-self/connections` require an `api.full` token, so
  a narrow-scope token cannot use them. Tenant identity comes from the `userId` on any
  record returned by `GET /agents`.
- A newly created agent has `model: null` and fails its first turn with "Codex model is
  required" — `PATCH /agents/{id}/model-config` is part of provisioning, not an
  afterthought.
- `DELETE /agents/{id}` cascades to installed skills and A2A grants, which is what makes it
  usable as the compensating transaction in `provisionAgent`.

## Checks

```bash
npm run check   # typecheck + build + wrangler deploy --dry-run
npm test        # vitest
```
