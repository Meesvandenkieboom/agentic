import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { TelegramNotifications, type TelegramFetch } from './telegram';
import { TurnNotifications } from './turns';
import { formatNotification } from './format';
import { handleTelegramRoutes } from './routes';

const token = '123456:' + 'a'.repeat(32);
function setup(fetcher: TelegramFetch = async () => Response.json({ ok: true })) {
  const db = new Database(':memory:');
  let now = 1_000_000;
  const service = new TelegramNotifications(db, fetcher, () => now);
  service.update({ token, userId: '123456789' });
  return { db, service, advance: (ms: number) => { now += ms; }, close: () => { service.stop(); db.close(); } };
}
const enqueue = (service: TelegramNotifications, id = 'event', kind: 'finished' | 'error' | 'question' = 'finished') => service.enqueue(id, 'chat', 'turn', kind, '<b>Hello</b>');

describe('Telegram notification delivery', () => {
  it('skips missing configuration, disabled notifications and disabled event types', async () => {
    let calls = 0;
    const { service, db, close } = setup(async () => { calls++; return Response.json({ ok: true }); });
    try {
      for (const config of [{ userId: '' }, { userId: '123', token: '' }, { token, enabled: false }, { enabled: true, finished: false }]) {
        service.update(config); enqueue(service); await service.drain();
      }
      expect(calls).toBe(0);
      expect(db.query('SELECT * FROM telegram_outbox').all()).toHaveLength(0);
    } finally { close(); }
  });

  it('sends only to the configured ID and deduplicates terminal and question events', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { service, close } = setup(async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); });
    try {
      enqueue(service); enqueue(service); await service.drain(); enqueue(service); await service.drain();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ chat_id: '123456789', parse_mode: 'HTML', text: '<b>Hello</b>' });
      expect(JSON.stringify(bodies)).not.toContain(token);
      expect(JSON.stringify(service.settings())).not.toContain(token);
    } finally { close(); }
  });

  it('retries temporary errors with backoff and Telegram retry_after, up to five sends', async () => {
    let calls = 0;
    const { service, advance, close } = setup(async () => { calls++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 10 } }, { status: 429 }); });
    try {
      enqueue(service); await service.drain(); await service.drain();
      expect(calls).toBe(1);
      advance(9999); await service.drain(); expect(calls).toBe(1);
      advance(1); await service.drain(); expect(calls).toBe(2);
      for (let i = 0; i < 8; i++) { advance(60_000); await service.drain(); }
      expect(calls).toBe(5);
    } finally { close(); }
  });

  it('does not retry permanent failures or expose bot tokens from network errors', async () => {
    let calls = 0;
    const { service, advance, close } = setup(async () => { calls++; return Response.json({ ok: false, error_code: 403 }, { status: 403 }); });
    try {
      enqueue(service); await service.drain(); advance(60_000); await service.drain();
      expect(calls).toBe(1); expect(service.settings().lastError).toContain('press Start');
    } finally { close(); }
    const failure = setup(async url => { throw new Error('Failed ' + url); });
    try {
      enqueue(failure.service); await failure.service.drain();
      expect(failure.service.settings().lastError).toBe('Telegram is temporarily unreachable.');
      await expect(failure.service.test()).rejects.toThrow('temporarily unreachable');
      expect(JSON.stringify(failure.service.settings())).not.toContain(token);
    } finally { failure.close(); }
  });

  it('drops answered/ended questions, expired events and old-recipient backlog', async () => {
    let calls = 0;
    const { service, advance, close } = setup(async () => { calls++; return Response.json({ ok: true }); });
    try {
      enqueue(service, 'q1', 'question'); service.resolveQuestion('q1'); await service.drain();
      enqueue(service, 'q2', 'question'); service.endTurn('turn'); await service.drain();
      enqueue(service, 'expired'); advance(3_600_001); await service.drain();
      enqueue(service, 'old-recipient'); service.update({ userId: '456' }); await service.drain();
      expect(calls).toBe(0);
    } finally { close(); }
  });

  it('restores terminal deliveries after restart but discards stale questions', async () => {
    let calls = 0;
    const { db, service, close } = setup();
    try {
      enqueue(service, 'complete'); enqueue(service, 'question', 'question');
      service.stop();
      const restarted = new TelegramNotifications(db, async () => { calls++; return Response.json({ ok: true }); }, () => 1_000_000);
      expect(restarted.settings()).toMatchObject({ hasToken: true, userId: '123456789' });
      await restarted.drain(); await restarted.drain(); expect(calls).toBe(1);
      restarted.stop();
    } finally { close(); }
  });

  it('serializes overlapping sends and prevents retries after settings change', async () => {
    let release!: (value: Response) => void; let calls = 0;
    const { service, close } = setup(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
    try {
      enqueue(service, 'one'); enqueue(service, 'two');
      const pending = service.drain(); await service.drain(); expect(calls).toBe(1);
      service.update({ enabled: false }); release(Response.json({ ok: false }, { status: 500 })); await pending;
      await service.drain(); expect(calls).toBe(1); expect(service.settings().lastError).toBeNull();
    } finally { close(); }
  });

  it('validates settings and keeps tokens out of API responses', async () => {
    const { service, close } = setup();
    const request = (body: unknown) => handleTelegramRoutes(new Request('http://localhost/api/notifications/telegram', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), new URL('http://localhost/api/notifications/telegram'), () => service);
    try {
      for (const userId of ['@someone', '-100123', '0', '9007199254740992']) expect((await request({ userId }))?.status).toBe(400);
      expect((await request({ enabled: 'true' }))?.status).toBe(400);
      const response = await request({ userId: '456', token });
      expect(response?.status).toBe(200);
      expect(await response?.text()).not.toContain(token);
      const get = await handleTelegramRoutes(new Request('http://localhost/api/notifications/telegram'), new URL('http://localhost/api/notifications/telegram'), () => service);
      expect(get?.headers.get('cache-control')).toBe('no-store');
      expect(await get?.text()).not.toContain(token);
    } finally { close(); }
  });
});

describe('chat notification lifecycle and format', () => {
  it('isolates three chats, emits one terminal event, and suppresses Stop', async () => {
    const sent: string[] = [];
    const { service, close } = setup(async (_url, init) => { sent.push(JSON.parse(String(init.body)).text); return Response.json({ ok: true }); });
    try {
      const turns = new TurnNotifications(() => service);
      turns.begin('a', 'Chat A'); turns.begin('b', 'Chat B'); turns.begin('c', 'Chat C');
      turns.question('a', 'q', [{ question: 'Which color?' }], false);
      turns.resolveQuestion('a', 'q');
      turns.finish('b', 'error'); turns.finish('b', 'finished');
      turns.cancel('c'); turns.finish('c', 'finished');
      turns.rename('a', 'Renamed A'); turns.finish('a', 'finished');
      for (let i = 0; i < 5; i++) await service.drain();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('Chat error'); expect(sent[0]).toContain('Chat B');
      expect(sent[1]).toContain('Turn finished'); expect(sent[1]).toContain('Renamed A');
    } finally { close(); }
  });

  it('keeps notification failure out of chat lifecycle', () => {
    const turns = new TurnNotifications(() => { throw new Error('database unavailable'); });
    turns.begin('chat', 'Title');
    expect(() => turns.question('chat', 'q', [{ question: 'Continue?' }], true)).not.toThrow();
    expect(() => turns.finish('chat', 'finished')).not.toThrow();
  });

  it('escapes HTML, truncates by characters and hides private question text', () => {
    const text = formatNotification('question', '<Chat & title>', [{ question: '😀'.repeat(300) }], true);
    expect(text).toContain('&lt;Chat &amp; title&gt;'); expect(text).toContain('…');
    expect(text).toContain('Waiting for your answer.'); expect(text).not.toContain('\uFFFD');
    expect(Array.from(text.split('\n')[2])).toHaveLength(180);
    expect(formatNotification('question', 'Chat', [{ question: 'private details', isSecret: true }])).not.toContain('private details');
    expect(formatNotification('question', 'Chat', [{ question: 'Continue?' }])).not.toContain('Waiting');
  });
});
