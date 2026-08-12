/**
 * Manyfold platform API client (management plane).
 *
 * Every call here runs on the *user's* account token — the credential the user pastes in
 * step 2 of the wizard. That token is the only thing that can provision an agent, so it is
 * sealed in D1 and never leaves the Worker. The conversation plane (A2A) uses a different,
 * per-agent credential minted by `mintCallerToken` below; see src/worker/a2a.ts.
 *
 * Endpoint choices here are not interchangeable with the ones the Manyfold web app uses.
 * Two traps, both verified against staging on 2026-08-12:
 *
 *   1. A2A management from a *token* must go through `/agent-self/a2a/*` with an
 *      `?agentId=` query parameter. The web app's `/a2a/agents/{id}/*` routes reject API
 *      tokens outright ("this endpoint requires an auth session").
 *   2. `/auth/me` requires an `api.full` token, so a narrow-scope token cannot use it to
 *      identify its owner. `listAgents` doubles as the identity call: every agent record
 *      carries the owning `userId`.
 */

import { fetchTimeout, safeErrorText } from './a2a';
import { HttpError } from './types';

const DEFAULT_BASE_URL = 'https://api.manyfold.ai';
const TIMEOUT_MS = 30_000;
/** Provisioning a sprite is slow; the platform holds the request until the pod is warm. */
const PROVISION_TIMEOUT_MS = 300_000;

export type Framework = 'codex' | 'claude-code' | 'gemini-cli';

/** The credential field name POST /agents expects, per framework. */
const CREDENTIAL_FIELD: Record<Framework, string> = {
  codex: 'codexCredentials',
  'claude-code': 'claudeCodeCredentials',
  'gemini-cli': 'geminiCliCredentials',
};

/** The provider protocol a framework can actually drive. */
export const FRAMEWORK_PROTOCOL: Record<Framework, string> = {
  codex: 'openai_responses',
  'claude-code': 'anthropic_messages',
  'gemini-cli': 'google_generate_content',
};

export interface ManyfoldAgent {
  id: string;
  userId: string;
  name: string;
  framework: string;
  runtime: string;
  status: string;
  model: string | null;
  extras?: {
    githubConnectionId?: string | null;
    a2aExposure?: { enabled: boolean } | null;
  };
}

export interface ModelProvider {
  id: string;
  providerName: string;
  inferenceProtocol: string | null;
  source: string;
  lastTestStatus: string | null;
  lastTestModels: Record<string, string[]> | null;
}

export interface Connection {
  id: string;
  provider: string;
  displayName: string;
  manageUrl: string | null;
}

export interface GithubRepo {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export interface MintedCaller {
  token: string;
  tokenId: string;
  rpcUrl: string;
  cardUrl: string;
  expiresAt: string | null;
}

/**
 * Platform errors, already carrying the shape the browser should see.
 *
 * The platform's own 401 messages are precise ("token missing scope: one of [a2a:read]")
 * and safe to surface, so they are passed through rather than flattened into a generic
 * "unauthorized" — the user usually has to go fix a scope, and needs to know which.
 */
export class ManyfoldError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(safeErrorText(message));
    this.name = 'ManyfoldError';
    this.status = status;
    this.code = code;
  }

  /** Is this the platform telling us the token is dead or under-scoped? */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class ManyfoldClient {
  private readonly base: string;
  private readonly token: string;

  constructor(token: string, baseUrl?: string) {
    const root = (baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.base = root.endsWith('/api') ? root : `${root}/api`;
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetchTimeout(
      `${this.base}${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      },
      timeoutMs,
    );

    const raw = await response.text();
    if (!response.ok) {
      let code = 'manyfold_error';
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
        if (parsed?.error?.message) message = parsed.error.message;
        if (parsed?.error?.code) code = parsed.error.code;
      } catch {
        /* non-JSON body: keep the raw text, already truncated by safeErrorText */
      }
      throw new ManyfoldError(response.status, code, message);
    }
    if (!raw) return undefined as T;
    return JSON.parse(raw) as T;
  }

  /* ───────── identity and inventory ───────── */

  /**
   * Lists the account's agents. Doubles as the identity + token-validity check:
   * a 200 proves the token works, and `userId` on any record is the tenant key.
   */
  listAgents(): Promise<ManyfoldAgent[]> {
    return this.request<ManyfoldAgent[]>('GET', '/agents');
  }

  getAgent(agentId: string): Promise<ManyfoldAgent> {
    return this.request<ManyfoldAgent>('GET', `/agents/${encodeURIComponent(agentId)}`);
  }

  listModelProviders(): Promise<ModelProvider[]> {
    return this.request<ModelProvider[]>('GET', '/me/model-providers');
  }

  listConnections(): Promise<Connection[]> {
    return this.request<Connection[]>('GET', '/me/connections');
  }

  listGithubRepos(connectionId: string): Promise<{ repos: GithubRepo[]; totalCount: number }> {
    return this.request('GET', `/me/connections/${encodeURIComponent(connectionId)}/github/repos`);
  }

  startGithubInstall(): Promise<{ url?: string; installUrl?: string }> {
    return this.request('POST', '/me/connections/github/start', {});
  }

  /* ───────── provisioning ───────── */

  /**
   * Creates an agent. `providerId` points at one of the account's model providers, which is
   * what makes zero-key creation work — the CLI's insistence on an API key is a client-side
   * check, not a platform rule.
   *
   * The new agent comes back with `model: null`, and a turn against it fails with
   * "Codex model is required". Callers must follow up with `setModel`; `provisionAgent`
   * in setup.ts does both so no path can forget.
   */
  createAgent(input: {
    name: string;
    framework: Framework;
    providerId?: string;
    apiKey?: string;
  }): Promise<ManyfoldAgent> {
    const credentials: Record<string, string> = {};
    if (input.providerId) credentials.providerId = input.providerId;
    else if (input.apiKey) {
      credentials[input.framework === 'codex' ? 'openaiApiKey' : 'anthropicAuthToken'] = input.apiKey;
    }
    return this.request<ManyfoldAgent>(
      'POST',
      '/agents',
      {
        name: input.name,
        framework: input.framework,
        [CREDENTIAL_FIELD[input.framework]]: credentials,
      },
      PROVISION_TIMEOUT_MS,
    );
  }

  setModel(agentId: string, model: string): Promise<unknown> {
    return this.request('PATCH', `/agents/${encodeURIComponent(agentId)}/model-config`, { model });
  }

  /** Links (or with `null`, unlinks) a GitHub connection. Sandbox/sprites runtimes only. */
  linkGithubConnection(agentId: string, connectionId: string | null): Promise<ManyfoldAgent> {
    return this.request<ManyfoldAgent>('PATCH', `/agents/${encodeURIComponent(agentId)}`, {
      githubConnectionId: connectionId,
    });
  }

  /** Cascades to installed skills and A2A grants — the compensating transaction for a failed setup. */
  deleteAgent(agentId: string): Promise<void> {
    return this.request<void>('DELETE', `/agents/${encodeURIComponent(agentId)}`);
  }

  /**
   * Copies a skill from a public GitHub URL into the account's own skill library.
   *
   * This step is not optional plumbing: `/skills/install` only accepts skills the platform
   * already knows — a catalog entry or a library id — so installing straight from a GitHub
   * path 404s with "discoverable skill … not found". Import first, install second.
   *
   * `onConflict: 'overwrite'` makes a re-run cheap and keeps the library from filling up
   * with copies as the skill is revised upstream. The key is camelCase — a snake_case
   * `on_conflict` is silently ignored, and the second import then 409s on the name.
   */
  importSkillFromGithub(url: string): Promise<{ skill: { id: string } }> {
    return this.request(
      'POST',
      '/skills/library/import',
      { url, onConflict: 'overwrite' },
      PROVISION_TIMEOUT_MS,
    );
  }

  /** `skillId` is a library id (`skl_…`) or a catalog id — not a raw GitHub path. */
  installSkill(agentId: string, skillId: string): Promise<{ id: string }> {
    return this.request('POST', '/skills/install', { skillId, agentId }, PROVISION_TIMEOUT_MS);
  }

  /* ───────── A2A exposure and callers ─────────
   * Both take the agent through `?agentId=`; see the header note on why the web app's
   * `/a2a/agents/{id}/*` routes are not an option here. Exposure toggles with PUT —
   * POST and DELETE both 404. */

  setExposure(agentId: string, enabled: boolean): Promise<{ enabled: boolean; rpcUrl: string; cardUrl: string }> {
    return this.request('PUT', `/agent-self/a2a/exposure?agentId=${encodeURIComponent(agentId)}`, {
      enabled,
    });
  }

  /** Mints the conversation-plane credential. The token is returned exactly once. */
  mintCallerToken(agentId: string, name: string, expiresInDays: number): Promise<MintedCaller> {
    return this.request<MintedCaller>(
      'POST',
      `/agent-self/a2a/callers?agentId=${encodeURIComponent(agentId)}`,
      { kind: 'external', name, expiresInDays },
    );
  }

  revokeCallerToken(agentId: string, tokenId: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/agent-self/a2a/callers/${encodeURIComponent(tokenId)}?agentId=${encodeURIComponent(agentId)}`,
    );
  }

  /**
   * Deletes an API token — including the one making the call.
   * Requires `api.full`: a narrow-scope token gets 401 here, which is why the wizard's
   * default "finish" path only drops our stored copy. See destroyManagementToken.
   */
  deleteApiToken(tokenId: string): Promise<void> {
    return this.request<void>('DELETE', `/me/api-tokens/${encodeURIComponent(tokenId)}`);
  }
}

/**
 * Which Manyfold environment this deployment talks to, in the two forms the UI needs.
 *
 * Worth surfacing rather than keeping internal: API tokens are per-environment, and a
 * staging token sent to production comes back as a flat "api token not found" — an error
 * that reads like a bad paste when it is really a wrong host. Showing the host in the
 * wizard, and naming it in that error, makes the mismatch self-evident.
 */
export function manyfoldEnvironment(baseUrl?: string): {
  apiHost: string;
  tokenPageUrl: string;
  webBaseUrl: string;
} {
  const raw = (baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let apiHost: string;
  try {
    apiHost = new URL(raw).host;
  } catch {
    return { apiHost: raw, tokenPageUrl: '', webBaseUrl: '' };
  }
  // The web console paired with this API host: api.manyfold.ai → manyfold.ai,
  // api-staging.manyfold.ai → app-staging.manyfold.ai.
  const webHost = apiHost.startsWith('api-')
    ? apiHost.replace(/^api-([a-z0-9]+)\./, 'app-$1.')
    : apiHost.replace(/^api\./, '');
  const webBaseUrl = `https://${webHost}`;
  return { apiHost, tokenPageUrl: `${webBaseUrl}/settings/api-tokens`, webBaseUrl };
}

/** Maps a platform error onto the HTTP status this app should answer with. */
export function toHttpError(error: unknown, context: string): HttpError {
  if (error instanceof ManyfoldError) {
    if (error.isAuth) {
      return new HttpError(401, 'manyfold_unauthorized', `${context}: ${error.message}`);
    }
    if (error.status === 404) {
      return new HttpError(404, 'manyfold_not_found', `${context}: ${error.message}`);
    }
    if (error.status >= 500) {
      return new HttpError(502, 'manyfold_unavailable', `${context}: ${error.message}`);
    }
    return new HttpError(400, error.code, `${context}: ${error.message}`);
  }
  return new HttpError(502, 'manyfold_unreachable', `${context}: ${safeErrorText(error)}`);
}

/**
 * Picks a model provider that the given framework can actually drive, preferring a
 * platform-managed one so the user needs no key of their own.
 */
export function pickProvider(providers: ModelProvider[], framework: Framework): ModelProvider | null {
  const protocol = FRAMEWORK_PROTOCOL[framework];
  const usable = providers.filter((p) => p.lastTestStatus === 'ok' && p.inferenceProtocol === protocol);
  return usable.find((p) => p.source === 'managed') ?? usable[0] ?? null;
}

/** The models a provider advertises, flattened across protocols. */
export function providerModels(provider: ModelProvider): string[] {
  return Object.values(provider.lastTestModels ?? {}).flat();
}
