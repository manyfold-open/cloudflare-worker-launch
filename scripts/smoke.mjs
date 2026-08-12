#!/usr/bin/env node
/**
 * Smoke test against a running deployment (or local dev server):
 *   npm run smoke -- https://your-app.workers.dev
 *
 * Retries for a while, because a fresh deploy can take a moment to propagate.
 */

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/+$/, '');
const ATTEMPTS = 12;
const DELAY_MS = 5_000;

const checks = [
  {
    name: 'GET /api/health returns ok',
    run: async () => {
      const response = await fetch(`${base}/api/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.status !== 'ok') throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'GET /api/state bootstraps a session for an anonymous visitor',
    run: async () => {
      const response = await fetch(`${base}/api/state`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.projects) || typeof body.connected !== 'boolean') {
        throw new Error(`unexpected body: ${JSON.stringify(body).slice(0, 200)}`);
      }
      if (!Array.isArray(body.requiredScopes) || body.requiredScopes.length === 0) {
        throw new Error('requiredScopes is empty — the wizard would ask for nothing');
      }
      // A first visit must hand back a session, or nothing downstream can own a project.
      if (!/(^|;\s*)mfl_session=/.test(response.headers.get('set-cookie') ?? '')) {
        throw new Error('no session cookie on a fresh visit');
      }
    },
  },
  {
    name: 'account-scoped routes refuse an unauthorized session',
    run: async () => {
      const response = await fetch(`${base}/api/projects/prj_nope/agent-options`);
      if (response.status !== 401) throw new Error(`HTTP ${response.status}, expected 401`);
    },
  },
  {
    name: 'mutations without an Origin header are rejected',
    run: async () => {
      const response = await fetch(`${base}/api/projects`, { method: 'POST' });
      if (response.status !== 403) throw new Error(`HTTP ${response.status}, expected 403`);
    },
  },
  {
    name: 'GET / serves the app shell',
    run: async () => {
      const response = await fetch(`${base}/`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!html.includes('<div id="root">')) throw new Error('no #root element in HTML');
    },
  },
  {
    name: 'unknown /api/* routes return JSON 404',
    run: async () => {
      const response = await fetch(`${base}/api/definitely-not-a-route`);
      if (response.status !== 404) throw new Error(`HTTP ${response.status}, expected 404`);
      const body = await response.json();
      if (body?.error?.code !== 'not_found') throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    },
  },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ready = false;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  try {
    const response = await fetch(`${base}/api/health`);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  console.log(`waiting for ${base} (${attempt}/${ATTEMPTS})…`);
  await wait(DELAY_MS);
}
if (!ready) {
  console.error(`✗ ${base} never became reachable`);
  process.exit(1);
}

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`✓ ${check.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${check.name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
