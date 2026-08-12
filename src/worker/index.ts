/**
 * The Worker: a Hono app under /api, static assets for everything else.
 *
 * Route map (all responses JSON unless noted):
 *   GET    /api/health                          open     deploy-verification contract
 *   GET    /api/state                           session  bootstrap: session + projects
 *   POST   /api/account                         session  paste an account token, bind the session
 *   DELETE /api/account                         account  drop our copy of that token
 *   POST   /api/projects                        tenant   start a project
 *   DELETE /api/projects/:id                    tenant   forget a project (never deletes the agent)
 *   POST   /api/projects/:id/worker             tenant   record + health-check the deployed URL
 *   GET    /api/projects/:id/agent-options      account  agents to adopt, providers to create with
 *   POST   /api/projects/:id/agent              account  provision (create or adopt) the agent
 *   GET    /api/projects/:id/connections        account  the account's GitHub connections
 *   POST   /api/projects/:id/github/start       account  begin a GitHub App install
 *   GET    /api/projects/:id/repos              account  repos visible to a connection
 *   POST   /api/projects/:id/repo               account  link connection + choose the repo
 *   POST   /api/projects/:id/bootstrap          tenant   the one billed turn (text/event-stream)
 *   GET    /api/projects/:id/messages           tenant   chat history
 *   DELETE /api/projects/:id/messages           tenant   reset the conversation
 *   POST   /api/projects/:id/chat               tenant   one chat turn (text/event-stream)
 *   GET    /api/projects/:id/status             tenant   live health of the deployed app
 *
 * Three access levels. **session**: any browser, anonymous included. **tenant**: owns
 * projects — an anonymous session is its own tenant, which is what lets step 1 of the
 * wizard (deploy, no Manyfold credential needed) happen before step 2 binds an account.
 * **account**: needs the authorized Manyfold account behind the session, because it calls
 * the platform on the user's behalf.
 *
 * Either way every project query is scoped by `user_id`; `connectAccount` re-keys an
 * anonymous session's rows to the real user id at the moment of binding.
 */

import { Hono } from 'hono';
import type { AppState, ProjectStatus } from '../shared/types';
import { HttpError, type Env } from './types';
import { ensureSchema } from './db';
import { ConfigError } from './crypto';
import { A2AError, fetchTimeout, safeErrorText, validateA2AUrl } from './a2a';
import { ManyfoldError, manyfoldEnvironment, toHttpError, type Framework } from './manyfold';
import {
  connectAccount,
  createSession,
  discardManagementToken,
  loadSession,
  managementClient,
  readSessionCookie,
  requireBoundTenant,
  requireManagementClient,
  requireTenant,
  sessionCookie,
  type SessionRow,
} from './session';
import {
  createProject,
  deleteProject,
  listProjects,
  requireProject,
  toView,
  updateProject,
} from './projects';
import {
  agentOptions,
  bootstrapPrompt,
  completeBootstrap,
  linkRepository,
  provisionAgent,
} from './setup';
import { getConversation, handleChatTurn, resetConversation } from './chat';

const SERVICE = 'manyfold-launch';

const TEMPLATE_REPO_URL = 'https://github.com/manyfold-open/cloudflare-worker-starter';
const DEPLOY_BUTTON_URL = `https://deploy.workers.cloudflare.com/?url=${TEMPLATE_REPO_URL}`;

/**
 * The scopes the wizard asks for. Kept here so the UI renders exactly what the server
 * needs — a drifting list would send users to create tokens that cannot finish setup.
 * Deliberately absent: secrets, terminal, files, chat, usage, backups.
 */
const REQUIRED_SCOPES = [
  'agents:read',
  'agents:edit',
  'model-config:edit',
  'model-providers:read',
  'a2a:read',
  'a2a:edit',
  'skills:read',
  'skills:edit',
  'connections:read',
  'connections:edit',
];

type Vars = { session: SessionRow | null; setCookie: string | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/* ───────── middleware ───────── */

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Same-origin check on every mutation: browsers always send Origin on cross-site
// POSTs, so this shuts down CSRF. The session cookie is SameSite=Lax, but a
// cookie-authenticated API needs this belt as well as those braces.
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (!origin) {
      throw new HttpError(403, 'origin_required', 'Mutation requests must include a same-origin Origin header.');
    }
    if (origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'invalid_origin', 'Cross-origin requests are not allowed.');
    }
  }
  await next();
});

/** Resolves (or mints) the browser session. /api/health stays free of all of this. */
app.use('/api/*', async (c, next) => {
  if (new URL(c.req.url).pathname === '/api/health') return next();

  let session = await loadSession(c.env, readSessionCookie(c.req.header('cookie')));
  let cookie: string | null = null;
  if (!session) {
    const id = await createSession(c.env);
    session = { id, user_id: null, expires_at: '' };
    cookie = sessionCookie(id, new URL(c.req.url).protocol === 'https:');
  }
  c.set('session', session);
  c.set('setCookie', cookie);

  await next();

  const pending = c.get('setCookie');
  if (pending) c.header('set-cookie', pending);
});

/* ───────── error mapping ───────── */

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  if (error instanceof ConfigError) {
    return c.json({ error: { code: 'misconfigured', message: error.message } }, 400);
  }
  if (error instanceof ManyfoldError) {
    const mapped = toHttpError(error, 'Manyfold');
    return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as 400);
  }
  if (error instanceof A2AError) {
    return error.retryable
      ? c.json({ error: { code: 'agent_unavailable', message: error.message } }, 502)
      : c.json({ error: { code: 'agent_rejected', message: error.message } }, 400);
  }
  console.error('unhandled', safeErrorText(error));
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

/* ───────── helpers ───────── */

/** Any tenant, including an anonymous one — enough to own a project. */
const tenantOf = (c: { get: (key: 'session') => SessionRow | null }) => requireTenant(c.get('session'));

/** A tenant with an authorized Manyfold account behind it. */
const accountOf = (c: { get: (key: 'session') => SessionRow | null }) =>
  requireBoundTenant(c.get('session'));

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'bad_request', 'Body must be a JSON object.');
  }
  return body as T;
}

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'bad_request', `"${field}" must be a non-empty string.`);
  }
  return value.trim();
};

/* ───────── routes ───────── */

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: SERVICE, time: new Date().toISOString() }),
);

app.get('/api/state', async (c) => {
  const session = c.get('session');
  // Anonymous sessions are their own tenant, so a project started before authorizing is
  // still listed here — that is what lets step 1 happen before step 2.
  const tenant = requireTenant(session);
  const projects = await listProjects(c.env, tenant.userId);
  const state: AppState = {
    service: SERVICE,
    connected: tenant.bound,
    hasManagementToken: tenant.bound ? (await managementClient(c.env, tenant.userId)) !== null : false,
    projects: projects.map(toView),
    requiredScopes: REQUIRED_SCOPES,
    ...manyfoldEnvironment(c.env.MANYFOLD_API_BASE_URL),
    templateRepoUrl: TEMPLATE_REPO_URL,
    deployButtonUrl: DEPLOY_BUTTON_URL,
  };
  return c.json(state);
});

app.post('/api/account', async (c) => {
  const session = c.get('session');
  if (!session) throw new HttpError(500, 'internal', 'Session missing.');
  const body = await readJson<{ token?: unknown }>(c);
  const result = await connectAccount(c.env, session.id, str(body.token, 'token'));
  return c.json({ connected: true, agentCount: result.agentCount });
});

app.delete('/api/account', async (c) => {
  const tenant = accountOf(c);
  await discardManagementToken(c.env, tenant.userId);
  return c.json({
    ok: true,
    // Said plainly because it is easy to assume otherwise: forgetting is not revoking.
    note: 'This app no longer holds your account token. It is still valid on Manyfold — revoke it there if you want it dead.',
  });
});

app.post('/api/projects', async (c) => {
  const tenant = tenantOf(c);
  const project = await createProject(c.env, tenant.userId);
  return c.json({ project: toView(project) }, 201);
});

app.delete('/api/projects/:id', async (c) => {
  const tenant = tenantOf(c);
  await requireProject(c.env, tenant.userId, c.req.param('id'));
  await deleteProject(c.env, tenant.userId, c.req.param('id'));
  return c.json({
    ok: true,
    note: 'The project is gone from this app. The agent and its repository are untouched on Manyfold and GitHub.',
  });
});

/** Step 1: record the deployed URL, but only after proving it is actually the app. */
app.post('/api/projects/:id/worker', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  const body = await readJson<{ workerUrl?: unknown }>(c);
  const production = (c.env.ENVIRONMENT ?? '').toLowerCase() === 'production';
  const workerUrl = validateA2AUrl(str(body.workerUrl, 'workerUrl'), production, 'worker URL').replace(
    /\/+$/,
    '',
  );

  const health = await checkHealth(workerUrl);
  if (!health.healthy) {
    throw new HttpError(
      400,
      'worker_unreachable',
      `${workerUrl}/api/health did not answer as expected (${health.detail ?? 'no detail'}). Is the deploy finished?`,
    );
  }

  const updated = await updateProject(c.env, tenant.userId, project.id, {
    worker_url: workerUrl,
    setup_state: project.agent_id ? project.setup_state as never : 'agent',
  });
  return c.json({ project: toView(updated) });
});

app.get('/api/projects/:id/agent-options', async (c) => {
  const tenant = accountOf(c);
  await requireProject(c.env, tenant.userId, c.req.param('id'));
  const client = await requireManagementClient(c.env, tenant);
  return c.json(await agentOptions(client));
});

app.post('/api/projects/:id/agent', async (c) => {
  const tenant = accountOf(c);
  const client = await requireManagementClient(c.env, tenant);
  const body = await readJson<{
    mode?: unknown;
    name?: unknown;
    framework?: unknown;
    providerId?: unknown;
    apiKey?: unknown;
    agentId?: unknown;
  }>(c);

  const input =
    body.mode === 'adopt'
      ? ({ mode: 'adopt', agentId: str(body.agentId, 'agentId') } as const)
      : ({
          mode: 'create',
          name: str(body.name, 'name'),
          framework: str(body.framework, 'framework') as Framework,
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        } as const);

  const project = await provisionAgent(c.env, client, tenant.userId, c.req.param('id'), input);
  return c.json({ project: toView(project) });
});

app.get('/api/projects/:id/connections', async (c) => {
  const tenant = accountOf(c);
  await requireProject(c.env, tenant.userId, c.req.param('id'));
  const client = await requireManagementClient(c.env, tenant);
  const connections = await client.listConnections().catch((error) => {
    throw toHttpError(error, 'Could not list your connections');
  });
  return c.json({
    connections: connections
      .filter((connection) => connection.provider === 'github')
      .map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        displayName: connection.displayName,
        manageUrl: connection.manageUrl,
      })),
  });
});

app.post('/api/projects/:id/github/start', async (c) => {
  const tenant = accountOf(c);
  await requireProject(c.env, tenant.userId, c.req.param('id'));
  const client = await requireManagementClient(c.env, tenant);
  const started = await client.startGithubInstall().catch((error) => {
    throw toHttpError(error, 'Could not start the GitHub App install');
  });
  const url = started.url ?? started.installUrl ?? null;
  if (!url) {
    throw new HttpError(
      502,
      'github_start_failed',
      'Manyfold did not return an install URL. Link GitHub from Manyfold → Settings → Connections instead.',
    );
  }
  return c.json({ url });
});

app.get('/api/projects/:id/repos', async (c) => {
  const tenant = accountOf(c);
  await requireProject(c.env, tenant.userId, c.req.param('id'));
  const connectionId = c.req.query('connectionId');
  if (!connectionId) throw new HttpError(400, 'bad_request', 'connectionId is required.');
  const client = await requireManagementClient(c.env, tenant);
  const result = await client.listGithubRepos(connectionId).catch((error) => {
    throw toHttpError(error, 'Could not list repositories');
  });
  return c.json({ repos: result.repos ?? [] });
});

app.post('/api/projects/:id/repo', async (c) => {
  const tenant = accountOf(c);
  const client = await requireManagementClient(c.env, tenant);
  const body = await readJson<{ connectionId?: unknown; repoFullName?: unknown }>(c);
  const project = await linkRepository(c.env, client, tenant.userId, c.req.param('id'), {
    connectionId: str(body.connectionId, 'connectionId'),
    repoFullName: str(body.repoFullName, 'repoFullName'),
  });
  return c.json({ project: toView(project) });
});

/**
 * The bootstrap turn. This is the only place the launcher spends the user's money, so it
 * is a route of its own rather than a hidden side effect of another step — and the report
 * is recorded server-side, so a closed tab cannot lose it.
 */
app.post('/api/projects/:id/bootstrap', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  if (!project.agent_id) {
    throw new HttpError(400, 'agent_missing', 'Set up the agent before running the readiness check.');
  }
  return handleChatTurn({
    env: c.env,
    project,
    message: bootstrapPrompt(project),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    onComplete: async ({ text }) => {
      await completeBootstrap(c.env, tenant.userId, project.id, text);
    },
  });
});

app.get('/api/projects/:id/messages', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  return c.json(await getConversation(c.env, project.id));
});

app.delete('/api/projects/:id/messages', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  await resetConversation(c.env, project.id);
  return c.json({ ok: true });
});

app.post('/api/projects/:id/chat', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  const body = await readJson<{ message?: unknown }>(c);
  return handleChatTurn({
    env: c.env,
    project,
    message: str(body.message, 'message'),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

app.get('/api/projects/:id/status', async (c) => {
  const tenant = tenantOf(c);
  const project = await requireProject(c.env, tenant.userId, c.req.param('id'));
  const status: ProjectStatus = project.worker_url
    ? { workerUrl: project.worker_url, ...(await checkHealth(project.worker_url)), checkedAt: new Date().toISOString() }
    : { workerUrl: null, healthy: null, detail: 'No deployment URL recorded yet.', checkedAt: new Date().toISOString() };
  return c.json(status);
});

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

// Anything else that reaches the Worker is a static asset (or the SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/* ───────── deployment health ───────── */

/**
 * Asks a deployed app whether it is alive. The starter's `/api/health` is an open route by
 * contract, so this needs no credential — and deliberately sends none.
 */
async function checkHealth(workerUrl: string): Promise<{ healthy: boolean; detail: string | null }> {
  try {
    const response = await fetchTimeout(`${workerUrl}/api/health`, { redirect: 'manual' }, 10_000);
    if (!response.ok) return { healthy: false, detail: `HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== 'ok') return { healthy: false, detail: 'Unexpected health payload.' };
    return { healthy: true, detail: null };
  } catch (error) {
    // The message, not the error object: `String(error)` prefixes the class name, and
    // "A2AError: ..." in a wizard hint reads like a crash rather than "your app is not up".
    return { healthy: false, detail: safeErrorText(error instanceof Error ? error.message : error) };
  }
}

export default app;
