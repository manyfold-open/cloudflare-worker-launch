/**
 * Sessions and tenants.
 *
 * The browser holds one opaque, HttpOnly cookie. Everything else — which Manyfold account
 * this is, and that account's management token — lives server-side, keyed by that cookie.
 *
 * A session starts anonymous (`userId: null`) so the wizard can render step 1 before the
 * user has authorized anything, and is bound to a Manyfold account the moment a pasted
 * token verifies. Binding is what makes `user_id` available for the row-level scoping that
 * every project query depends on.
 */

import type { Env } from './types';
import { HttpError } from './types';
import { now, randomId, setSetting } from './db';
import { seal, unseal } from './crypto';
import { ManyfoldClient, ManyfoldError, manyfoldEnvironment, toHttpError } from './manyfold';

const COOKIE_NAME = 'mfl_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  user_id: string | null;
  expires_at: string;
}

export interface Tenant {
  sessionId: string;
  /**
   * The row-scoping key for every project query. For a session that has authorized an
   * account this is the Manyfold user id; before that it is the session id itself.
   *
   * Anonymous sessions are their own tenant so that step 1 of the wizard — deploy the app,
   * which needs no Manyfold credential — works before the user has handed us anything.
   * `connectAccount` re-keys those rows to the real user id at the moment of binding, so
   * the invariant "every project query is scoped by user_id" holds throughout, with no
   * nullable owner and no second code path.
   */
  userId: string;
  /** Has an account been authorized, or is this still an anonymous session? */
  bound: boolean;
}

export function sessionCookie(id: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}

export async function createSession(env: Env): Promise<string> {
  const id = randomId('ses');
  const created = now();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .bind(id, created, expires)
    .run();
  return id;
}

export async function loadSession(env: Env, sessionId: string | null): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    'SELECT id, user_id, expires_at FROM sessions WHERE id = ? AND expires_at > ?',
  )
    .bind(sessionId, now())
    .first<SessionRow>();
  return row ?? null;
}

/**
 * The tenant guard every project route runs through. Throws rather than returning null:
 * a route that forgets to check cannot accidentally operate unscoped.
 */
export function requireTenant(session: SessionRow | null): Tenant {
  if (!session) {
    throw new HttpError(401, 'no_session', 'No session. Reload the page.');
  }
  return {
    sessionId: session.id,
    userId: session.user_id ?? session.id,
    bound: Boolean(session.user_id),
  };
}

/** For routes that genuinely need the account behind the session, not just a tenant. */
export function requireBoundTenant(session: SessionRow | null): Tenant {
  const tenant = requireTenant(session);
  if (!tenant.bound) {
    throw new HttpError(401, 'not_connected', 'Authorize your Manyfold account first.');
  }
  return tenant;
}

/* ───────── management token ───────── */

/**
 * Verifies a pasted account token, binds the session to its owner, and seals it.
 *
 * Identity comes from `GET /agents` rather than `/auth/me`, which requires an api.full
 * token — a narrow-scope token (what this app asks for) gets 401 there. An account with no
 * agents yet returns an empty list and therefore no userId; that is a real, if unusual,
 * dead end, so it gets its own message rather than a generic failure.
 */
export async function connectAccount(
  env: Env,
  sessionId: string,
  token: string,
): Promise<{ userId: string; agentCount: number }> {
  const client = new ManyfoldClient(token, env.MANYFOLD_API_BASE_URL);

  let agents;
  try {
    agents = await client.listAgents();
  } catch (error) {
    if (error instanceof ManyfoldError && error.isAuth) {
      const { apiHost } = manyfoldEnvironment(env.MANYFOLD_API_BASE_URL);
      throw new HttpError(
        401,
        'token_rejected',
        `${apiHost} rejected that token — ${error.message}. Tokens belong to one Manyfold environment: a token created anywhere other than ${apiHost} will not work here.`,
      );
    }
    throw toHttpError(error, 'Could not reach Manyfold');
  }

  const userId = agents.find((agent) => agent.userId)?.userId;
  if (!userId) {
    throw new HttpError(
      400,
      'no_agents',
      'That token works, but the account has no agents yet, so we cannot identify it. Create one agent in Manyfold and paste the token again.',
    );
  }

  const sealed = await seal(env, token);
  const stamp = now();
  await env.DB.prepare(
    `INSERT INTO users (id, token_ct, token_iv, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       token_ct = excluded.token_ct,
       token_iv = excluded.token_iv,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, sealed.ciphertext, sealed.iv, stamp, stamp)
    .run();

  // Re-key anything this browser started while anonymous, then bind the session. Order
  // matters: if the re-key fails the session stays anonymous and the work is still
  // reachable, whereas binding first would orphan those rows under the old key.
  await env.DB.prepare('UPDATE projects SET user_id = ?, updated_at = ? WHERE user_id = ?')
    .bind(userId, now(), sessionId)
    .run();
  await env.DB.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').bind(userId, sessionId).run();

  return { userId, agentCount: agents.length };
}

/** Returns a client on the stored management token, or null once the token has been dropped. */
export async function managementClient(env: Env, userId: string): Promise<ManyfoldClient | null> {
  const row = await env.DB.prepare('SELECT token_ct, token_iv FROM users WHERE id = ?')
    .bind(userId)
    .first<{ token_ct: string | null; token_iv: string | null }>();
  if (!row?.token_ct || !row.token_iv) return null;
  const token = await unseal(env, row.token_ct, row.token_iv);
  return new ManyfoldClient(token, env.MANYFOLD_API_BASE_URL);
}

/**
 * The same, but insisting — setup steps cannot proceed without it. Two distinct causes get
 * two distinct messages, because the fix differs: an unbound session needs to authorize,
 * while a bound one whose token we dropped needs to paste it again.
 */
export async function requireManagementClient(env: Env, tenant: Tenant): Promise<ManyfoldClient> {
  if (!tenant.bound) {
    throw new HttpError(401, 'not_connected', 'Authorize your Manyfold account to continue.');
  }
  const client = await managementClient(env, tenant.userId);
  if (!client) {
    throw new HttpError(
      401,
      'token_discarded',
      'This app no longer holds your Manyfold account token. Paste it again to change this project.',
    );
  }
  return client;
}

/**
 * Drops our copy of the management token.
 *
 * This is *not* revocation, and the UI must not imply that it is. Manyfold has no
 * "delete the token I am calling with" endpoint, and a pasted token cannot be matched
 * against `/me/api-tokens` (that route needs api.full, and even with it there is no way to
 * tell which row is the one in our hands). So the honest contract is: we forget it, and
 * the user revokes it on Manyfold if they want it dead.
 */
export async function discardManagementToken(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET token_ct = NULL, token_iv = NULL, updated_at = ? WHERE id = ?')
    .bind(now(), userId)
    .run();
}

/** Records that the deployment has been seen at least once — used only for diagnostics. */
export async function markSeen(env: Env): Promise<void> {
  await setSetting(env, 'last_seen_at', now());
}
