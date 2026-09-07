import { getTelegramNotifications } from './index';
import type { TelegramNotifications } from './telegram';

export async function handleTelegramRoutes(req: Request, url: URL, getService: () => TelegramNotifications = getTelegramNotifications): Promise<Response | undefined> {
  if (url.pathname !== '/api/notifications/telegram' && url.pathname !== '/api/notifications/telegram/test') return;
  const headers = { 'Cache-Control': 'no-store' };
  // Settings contain credentials; same-origin browser requests only.
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return Response.json({ error: 'Invalid origin.' }, { status: 403, headers });
  try {
    const service = getService();
    if (url.pathname.endsWith('/test')) {
      if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers });
      try { await service.test(); return Response.json({ success: true }, { headers }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Could not send test notification.' }, { status: 502, headers }); }
    }
    if (req.method === 'GET') return Response.json(service.settings(), { headers });
    if (req.method === 'PATCH') {
      try {
        const settings = service.update(await req.json());
        return Response.json(settings, { headers });
      } catch { return Response.json({ error: 'Check your settings: use a positive numeric user ID and a valid bot token.' }, { status: 400, headers }); }
    }
    return Response.json({ error: 'Method not allowed.' }, { status: 405, headers });
  } catch { return Response.json({ error: 'Telegram settings are unavailable.' }, { status: 503, headers }); }
}
