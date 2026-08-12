# Cloudflare Worker Launch

Ship a Cloudflare app — and an AI agent that keeps building it.

Cloudflare Worker Launch is a five-step wizard. At the end of it you own a deployed Cloudflare
Worker, a GitHub repository, and a [Manyfold](https://manyfold.ai) agent that can clone
that repository, change it, push, and let Cloudflare deploy the result. From then on you
develop by talking to it.

```
Deploy the app  →  authorize your account  →  agent is provisioned  →  hand it your repo  →  readiness check
```

Everything except the last step is a plain API call on your own Manyfold account: no agent
turns run, so nothing is billed until the readiness check — which the UI says out loud
before it runs.

## What it actually does for you

Doing this by hand means visiting the Cloudflare dashboard, the Manyfold agent list, the
model configuration page, the skills catalog, the A2A tab, the connections page, and the
agent settings page — in the right order, with the right values. The wizard collapses that
into one sequence:

| Step | What happens |
| --- | --- |
| 1 · Deploy | You click Deploy to Cloudflare; we verify the result by calling `/api/health` on your new app |
| 2 · Authorize | You paste a scoped Manyfold API token; we verify it and bind your session |
| 3 · Agent | We create the agent, set its model, install the development skill, enable A2A, and mint a credential — or adopt an agent you already have |
| 4 · GitHub | We link your GitHub connection to the agent and record which repository it owns |
| 5 · Readiness | The agent clones, reads the conventions, checks it can push, runs the tests, and reports back |

## Credentials, and what we hold

Two different credentials, deliberately kept apart:

- **Your account token** (management plane) provisions the agent. It is encrypted at rest,
  never leaves the Worker, and is only needed during setup — the wizard offers to forget it
  when setup is done. Forgetting is not revoking, and the UI says so: Manyfold has no
  "delete the token I am calling with" endpoint, so revocation stays yours to do.
- **The agent credential** (conversation plane) is minted per agent, scoped to that agent
  alone, valid for 90 days. It is what the chat console uses, and it keeps working after
  the account token is gone.

Neither reaches the browser in any form. The scopes the wizard asks for are listed in the
UI and enforced by the platform; `secrets`, `terminal`, `files` and `chat` are not among
them.

## Running it yourself

```bash
npm ci
cp .dev.vars.example .dev.vars   # point MANYFOLD_API_BASE_URL at staging for development
npm run dev
```

Then `npm run check` (typecheck + build + a deploy dry run) and `npm test` before pushing.

**`CONFIG_ENCRYPTION_KEY` is required for any real deployment.** This app is multi-tenant
and holds other people's account credentials, so the starter template's
generate-a-key-into-D1 fallback is not good enough here:

```bash
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

## Troubleshooting

**"api token not found" when you paste your token.** Almost always the wrong environment,
not a bad paste: Manyfold tokens belong to exactly one host, and a staging token sent to
production (or the reverse) comes back with that flat message. The authorize step names the
host this deployment talks to and links to the token page that matches it — create the token
there. To point a local checkout somewhere else, set `MANYFOLD_API_BASE_URL` in `.dev.vars`;
without a `.dev.vars` the default from `wrangler.jsonc` (production) applies.

**"token missing scope: one of […]"** is the platform telling you precisely which scope the
token lacks. Add it and paste the token again — the wizard lists the full set it needs.

## Layout

| Path | What lives there |
| --- | --- |
| `src/worker/manyfold.ts` | Manyfold platform client — every endpoint the setup plane uses |
| `src/worker/setup.ts` | The orchestration: provision, link, bootstrap, and the cleanup when a step fails |
| `src/worker/session.ts` | Sessions, tenant binding, the management token's life cycle |
| `src/worker/projects.ts` | Project storage; the only read path, so the only place tenant scoping matters |
| `src/worker/a2a.ts`, `chat.ts`, `crypto.ts` | Inherited from the starter template: A2A protocol, streaming turns, encryption |
| `src/app/components/Wizard.tsx` | The five steps |
| `src/app/components/Console.tsx` | The development console once setup is done |
| `skills/cf-starter-dev/` | The harness skill installed onto every provisioned agent |
| `SPEC.md` | Product spec, including the verified platform API surface and what is still open |

## Status

Draft. The setup chain has been verified end to end against Manyfold staging — account
binding, agent creation with zero keys, skill install, A2A exposure and token minting,
GitHub linking, and a live streamed turn. What has not been exercised in a real browser is
the GitHub App install pop-up round trip. See `SPEC.md` for the open questions and the
milestones.
