/**
 * Deep links to the three places a launch actually lives: the repository, the Cloudflare
 * dashboard, and (from the console) Manyfold. Pure functions, shared so they can be tested
 * without a browser.
 */

/** `https://github.com/owner/repo`, or null when no repository is linked yet. */
export function githubRepoUrl(repoFullName: string | null): string | null {
  if (!repoFullName) return null;
  const trimmed = repoFullName.trim().replace(/^\/+|\/+$/g, '');
  // Two segments, nothing exotic: this string came from the platform, but it ends up in an
  // href, so it is checked rather than trusted.
  return /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : null;
}

/**
 * The Cloudflare dashboard page for a deployed Worker.
 *
 * The dashboard needs an account id we do not have, so this uses Cloudflare's own
 * placeholder form — `?to=/:account/…` — which the dash resolves after login, asking the
 * user to pick when they belong to several accounts.
 *
 * The Worker's name is the first label of a `*.workers.dev` hostname. A custom domain
 * carries no such hint, so that case falls back to the Workers list, which still saves the
 * user a hunt through the dashboard.
 */
export function cloudflareWorkerUrl(workerUrl: string | null): string | null {
  const list = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';
  if (!workerUrl) return null;

  let host: string;
  try {
    host = new URL(workerUrl).hostname.toLowerCase();
  } catch {
    return list;
  }

  const name = host.endsWith('.workers.dev') ? host.split('.')[0] : null;
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return list;
  return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${name}/production`;
}

/** The agent's chat page on the Manyfold console that matches this deployment. */
export function manyfoldAgentUrl(webBaseUrl: string, agentId: string | null): string | null {
  if (!webBaseUrl || !agentId) return null;
  return `${webBaseUrl}/agents/${encodeURIComponent(agentId)}/chat`;
}
