---
name: cf-starter-dev
version: 1.0.0
description: Develop and ship an app built from the Manyfold cloudflare-worker-starter template, where every push to main deploys straight to production on Cloudflare. Covers the ship loop (check, test, push, verify the live health endpoint), the load-bearing invariants that break the deploy or leak a credential when violated (D1 schema-only-via-SCHEMA with no migrations, the admin gate on /api/ routes, AES-GCM sealed tokens, the non-billing tasks/get probe, the workerd/browser/shared runtime split), and the failure modes that look like your code but are not (schema splitter semicolons, encryption-key rotation, a deploy that built but never went live). Use this whenever you are asked to add a feature, fix a bug, change the UI, extend the database, add a route, or deploy an app whose repo contains wrangler.jsonc plus src/worker and src/app — and especially before the first push, because on this template a bad push is a production incident, not a failed build.
---

# Developing an app built from cloudflare-worker-starter

You are the developer of a live application. This is not a sandbox: **pushing to `main` deploys to
production.** There is no staging environment, no preview branch in the default setup, and no
approval step between your commit and real users. Everything below exists to make that safe.

`AGENTS.md` in the repo root is the authoritative invariant list and is maintained alongside the
code — read it before your first change and re-read it when it changes. This skill is the part
that lives outside the repo: the loop to follow, the traps that cost hours, and the judgement
calls the file cannot make for you.

## What you have

- **Git and GitHub credentials, already authenticated.** Your runtime has `GH_TOKEN` and a
  configured `git`; `gh` is signed in. Clone, commit, push, and open PRs without asking for
  credentials. Run `mf connections` to see what is linked. The platform maintains a context
  document in your workspace describing these connections — that file, not this skill, is the
  source of truth for credential mechanics.
- **The repository**, a fork or copy of `manyfold-open/cloudflare-worker-starter` in the user's
  own GitHub account.
- **Cloudflare's Workers Builds**, watching `main`. It runs `npm run build` then
  `npx wrangler deploy` on Cloudflare's side. You do not hold Cloudflare credentials unless a
  Cloudflare connection is linked, and you do not need them.

## The ship loop

Follow this every time. The order matters.

```bash
npm ci                 # first time in a fresh clone
npm run check          # tsc -b && vite build && wrangler deploy --dry-run
npm test               # vitest
git commit && git push # push to main == deploy to production
npm run smoke -- https://<the app url>   # after the build finishes
```

**Never skip `npm run check` before a push.** It is the only thing standing between a type error
and a failed production deploy. `--dry-run` catches a broken `wrangler.jsonc` without deploying.

**The deploy is asynchronous.** After `git push` returns, Cloudflare still has to build. Wait
before declaring victory: poll `GET /api/health` until it returns 200 JSON (typically one to two
minutes), or run `npm run smoke -- <url>`. A green push with a red health endpoint means the
build failed on Cloudflare's side — check the Workers Builds log in the Cloudflare dashboard,
which you cannot read directly, so report the symptom and ask the user to look.

**If you do not know the app's URL**, ask the user for it rather than guessing. `wrangler.jsonc`
holds the worker `name`, not the deployed hostname.

## Invariants you can break without noticing

`AGENTS.md` lists all of them. These four are the ones that fail quietly, long after the change:

**The database has no migrations.** Schema lives entirely in the `SCHEMA` string in
`src/worker/db.ts`, applied as one `db.batch()` on the first request of every isolate. To add a
table, append a `CREATE TABLE IF NOT EXISTS` to that string. Do not write a migration file, do
not add a migration runner, and do not assume one exists.

Three consequences, in descending order of how badly they bite:

- **Every statement in `SCHEMA` must be idempotent, because it runs on every cold start.** The
  batch is a transaction: one failing statement fails the whole thing, `ensureSchema` rethrows,
  and *every request 500s* until you fix it. This is the single fastest way to take the app down.
- **You cannot add a column by putting `ALTER TABLE ... ADD COLUMN` in `SCHEMA`.** SQLite has no
  `IF NOT EXISTS` for it, so the second cold start throws `duplicate column name` and you hit the
  failure above. Prefer a **new side table keyed by the existing row id** — that is a plain
  idempotent `CREATE TABLE IF NOT EXISTS` and needs no special casing. If a real column is
  unavoidable, it needs a guarded one-off *outside* the batch (read `PRAGMA table_info(t)`, then
  `ALTER` only when the column is absent), and say out loud that you are doing it.
- **Editing an existing `CREATE TABLE` does nothing to a live database.** `IF NOT EXISTS` makes
  the edit a no-op, so the change appears to work locally on a fresh database and silently
  does not apply in production.

Also: **`;` inside a statement body breaks everything**, because the splitter treats every
semicolon as a statement boundary. No triggers, no `BEGIN...END`.

**New `/api/` routes are behind the admin gate automatically.** The middleware in
`src/worker/index.ts` protects everything except `/api/health` and `/api/state`. If you add a
route and it 401s in the browser, that is the gate working, not a bug. Adding an exception needs
a reason as good as those two have; a route that is merely inconvenient to authenticate does not
qualify.

**Credential handling is not ordinary code.** Agent tokens and device codes are AES-GCM sealed in
D1 (`seal`/`unseal` in `src/worker/crypto.ts`) and must never reach a response body, a log line,
or the browser. Connectivity checks use `probeAgentAuth` (`tasks/get`), never `message/send` —
a real turn bills the user money. Agent-supplied URLs go through `validateA2AUrl` before you
fetch them. Error strings go through `safeErrorText` before leaving the worker. If a change of
yours touches `src/worker/{connect,a2a,chat,crypto}.ts`, re-read invariant 6 in `AGENTS.md`
before committing.

**Three runtimes, one repo.** `src/worker/` runs in workerd — no Node built-ins, no `fs`, no
`process`. `src/app/` runs in the browser only. `src/shared/` must work in both. Importing a
Node module into the worker compiles fine locally and fails on deploy.

## Traps that look like your bug and are not

| Symptom | Cause | Fix |
|---|---|---|
| Deploy succeeds, app 500s on every request | `CONFIG_ENCRYPTION_KEY` changed | Old ciphertext is unreadable. Users must reconnect their agents. Never rotate casually. |
| Stored agents vanish after a redeploy | `database_id` in `wrangler.jsonc` was edited | Restore the original. The Deploy button wrote the real one; changing it orphans the user's data. |
| Tests pass locally, fail in CI on a clean checkout | vitest was made to load `vite.config.ts` | Keep `vitest.config.ts` standalone — the Cloudflare Vite plugin rejects vitest's `resolve.external` injection. |
| `npm run build` works, `wrangler deploy` ships stale code | The `build` script was removed or reordered | `wrangler deploy` ships what `vite build` wrote to `dist/`. Build first, always. |
| A chat turn double-charges after a retry | A fresh random `messageId` on the retry path | `messageId` must be derived from the stored row (see `src/worker/chat.ts`), so a retry returns the original task. |

## Secrets

Never commit one. Never print one. A new secret gets a commented entry in `.dev.vars.example`
plus an instruction for the user to run `npx wrangler secret put NAME` themselves — you do not
have their Cloudflare account, and `.dev.vars` is git-ignored and must stay that way.

If the app needs a value you cannot set, say so plainly and give the exact command. Do not work
around it by hardcoding a fallback.

## Judgement

**What is safe to change: nearly everything.** The template exists to be rebuilt into the user's
app. New pages, new routes, new tables, a different UI, deleting the chat and settings views once
they are no longer needed — all fine. Keep `src/worker/{connect,a2a,crypto}.ts` if the app talks
to Manyfold agents at all; keep `/api/health` returning 200 JSON regardless, because it is the
deploy-verification contract.

**When a change is risky, say so before making it.** Schema changes against a live database,
anything touching credentials, and anything that could take the app down are worth a sentence of
warning and a moment for the user to object — they are watching production, and you are the one
who knows the change is load-bearing.

**Report deploys honestly.** "Pushed, build succeeded, `/api/health` returns 200" is a result.
"Pushed" alone is not. If the health check fails, lead with that rather than with what you
changed.
