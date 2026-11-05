import { randomBytes } from 'node:crypto';
import { getReviewService } from './index';
import type { ReviewService } from './service';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: string, status = 400) => json({ error }, status);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(title: string, message: string, extra = '', nonce = ''): Response {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; ${nonce ? `script-src 'nonce-${nonce}'` : ''}`;
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="background:#1a1c1e;color:#e5e7eb;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h2 style="font-weight:600">${escapeHtml(title)}</h2><p style="color:#9ca3af">${escapeHtml(message)}</p>${extra}</div></body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp } });
}

function manifestForm(service: ReviewService, url: URL): Response {
  const owner = url.searchParams.get('owner')?.trim() ?? '';
  const name = (url.searchParams.get('name')?.trim() || 'agentic-review').slice(0, 34);
  if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return page('Invalid organization', 'Use the organization’s GitHub login.');
  const manifest = {
    name, url: `https://github.com/${owner}`, description: 'Pull request reviews by Agentic, run locally with Claude.',
    redirect_url: `${url.origin}/api/review/app/created`, setup_url: `${url.origin}/api/review/app/installed`,
    setup_on_update: true, request_oauth_on_install: false, public: false,
    // No hook_attributes/default_events: Agentic polls; GitHub rejects manifests whose hook has no public URL.
    default_permissions: { pull_requests: 'write', issues: 'write', contents: 'read', metadata: 'read' },
  };
  const action = owner ? `https://github.com/organizations/${owner}/settings/apps/new` : 'https://github.com/settings/apps/new';
  const nonce = randomBytes(16).toString('base64');
  return page('Creating your GitHub App…', 'Continue on GitHub to create the app.',
    `<form id="f" method="post" action="${action}?state=${service.newState()}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">`
    + `<button style="padding:8px 16px;border-radius:8px;border:0;background:#2563eb;color:white">Continue to GitHub</button></form>`
    + `<script nonce="${nonce}">document.getElementById('f').submit()</script>`, nonce);
}

export async function handleReviewRoutes(req: Request, url: URL, getService: () => ReviewService = getReviewService): Promise<Response | undefined> {
  if (!url.pathname.startsWith('/api/review/')) return;
  const route = url.pathname.slice('/api/review/'.length);
  const service = getService();

  // Browser navigations (new tab, GitHub redirects).
  if (req.method === 'GET' && route === 'app/manifest-form') return manifestForm(service, url);
  if (req.method === 'GET' && route === 'app/created') {
    const code = url.searchParams.get('code');
    if (!code || !service.consumeState(url.searchParams.get('state'))) return page('Link expired', 'Start again from Agentic → Settings → GitHub.');
    try {
      const app = await service.completeManifest(code);
      return Response.redirect(`https://github.com/apps/${app.slug}/installations/new?state=${service.newState()}`, 302);
    } catch (error) {
      return page('Couldn’t create the app', error instanceof Error ? error.message : 'GitHub rejected the request.');
    }
  }
  if (req.method === 'GET' && route === 'app/installed') {
    const id = Number(url.searchParams.get('installation_id'));
    if (!Number.isSafeInteger(id) || id <= 0) return page('Nothing to install', 'GitHub didn’t return an installation.');
    try { await service.confirmInstallation(id); }
    catch { return page('Couldn’t verify the installation', 'Open Agentic → Settings → GitHub and press Refresh.'); }
    const nonce = randomBytes(16).toString('base64');
    return page('Agentic Review is installed', 'You can close this tab and choose repositories in Agentic.', `<script nonce="${nonce}">setTimeout(() => window.close(), 1500)</script>`, nonce);
  }

  // JSON API: same-origin only (the app holds a private key).
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return fail('Invalid origin.', 403);
  try {
    if (route === 'app' && req.method === 'GET') { await service.refreshIfPending(); return json(service.state()); }
    if (route === 'app' && req.method === 'DELETE') { service.forgetApp(); return json(service.state()); }
    if (route === 'settings' && req.method === 'PATCH') {
      try { return json(service.updateSettings(await req.json())); } catch (error) { return fail(error instanceof Error ? error.message : 'Invalid settings.'); }
    }
    if (route === 'sync' && req.method === 'POST') { await service.sync(); return json(service.repos()); }
    if (route === 'poll' && req.method === 'POST') { void service.poll(); return json({ success: true }, 202); }
    if (route === 'repos' && req.method === 'GET') return json(service.repos());
    const repoMatch = route.match(/^repos\/(\d+)$/);
    if (repoMatch && req.method === 'PATCH') {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return fail('Invalid body.');
      const patch: { enabled?: boolean; automatic?: boolean; instructions?: string } = {};
      for (const key of ['enabled', 'automatic'] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'boolean') return fail(`${key} must be a boolean.`);
        patch[key] = body[key];
      }
      if (body.instructions !== undefined) {
        if (typeof body.instructions !== 'string' || body.instructions.length > 4000) return fail('Instructions must be at most 4000 characters.');
        patch.instructions = body.instructions;
      }
      const repo = service.updateRepo(Number(repoMatch[1]), patch);
      return repo ? json(repo) : fail('Repository not found.', 404);
    }
    if (route === 'jobs' && req.method === 'GET') return json(service.jobs(Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))));
    const cancelMatch = route.match(/^jobs\/(\d+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') return service.cancelJob(Number(cancelMatch[1])) ? json({ success: true }) : fail('Nothing to cancel.', 409);
    return fail('Not found.', 404);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Agentic Review is unavailable.', 502);
  }
}
