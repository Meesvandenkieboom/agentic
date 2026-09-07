import React, { useEffect, useState } from 'react';
import { Bell, Check, Loader2, Send } from 'lucide-react';
import { defaultTelegramPreferences, type TelegramSettings } from '../../../shared/telegram';

const endpoint = '/api/notifications/telegram';
const eventOptions = [
  ['finished', 'Turn finished', 'When a chat finishes its response.'],
  ['errors', 'Chat errors', 'When a turn fails or cannot start.'],
  ['questions', 'Questions for you', 'A short preview when a chat asks for input.'],
] as const;

export function NotificationsSettingsTab() {
  const [settings, setSettings] = useState<TelegramSettings>({ ...defaultTelegramPreferences, hasToken: false, lastError: null });
  const [token, setToken] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Couldn’t load Telegram settings.');
      const data: TelegramSettings = await response.json();
      if (!controller.signal.aborted) { setSettings(data); setLoaded(true); setError(''); }
    }).catch(() => { if (!controller.signal.aborted) setError('Couldn’t load Telegram settings.'); });
    return () => controller.abort();
  }, [retry]);

  const change = (value: Partial<TelegramSettings>) => {
    setSettings(previous => ({ ...previous, ...value }));
    setDirty(true); setNotice(''); setError('');
  };
  const request = async (action: 'save' | 'test' | 'disconnect') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = action === 'disconnect' ? { enabled: false, userId: '', token: '' } : {
        enabled: settings.enabled, userId: settings.userId,
        finished: settings.finished, errors: settings.errors, questions: settings.questions,
        ...(token.trim() ? { token: token.trim() } : {}),
      };
      const response = await fetch(action === 'test' ? `${endpoint}/test` : endpoint, {
        method: action === 'test' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'test' ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Couldn’t update Telegram notifications.');
      if (action !== 'test') { setSettings(data); setToken(''); setDirty(false); }
      setNotice(action === 'test' ? 'Test notification sent.' : action === 'disconnect' ? 'Telegram disconnected.' : 'Settings saved.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Couldn’t reach the server.'); }
    finally { setBusy(false); }
  };

  return <div className="p-6 space-y-6">
    <div>
      <h3 className="text-lg font-semibold text-gray-100 flex items-center gap-2"><Send size={20} /> Telegram</h3>
      <p className="text-sm text-gray-400 mt-2">Get notified about your chats while you’re away, even with the browser closed.</p>
    </div>
    {!loaded ? <div role="status" className="text-sm text-gray-400">
      {error ? <><p role="alert">{error}</p><button type="button" className="mt-2 underline" onClick={() => setRetry(value => value + 1)}>Try again</button></> : 'Loading settings…'}
    </div> : <form onSubmit={event => { event.preventDefault(); void request('save'); }} className="space-y-5">
      <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
        <label className="flex items-center justify-between gap-4 text-sm text-gray-100 cursor-pointer">
          <span className="flex items-center gap-2"><Bell size={16} /> Telegram notifications</span>
          <input type="checkbox" role="switch" checked={settings.enabled} onChange={event => change({ enabled: event.target.checked })} className="h-4 w-4 accent-blue-500" />
        </label>
        <label className="block text-sm text-gray-300">Bot token
          <input type="password" autoComplete="new-password" value={token} maxLength={125}
            placeholder={settings.hasToken ? 'Token saved — enter a new token to replace it' : 'Paste your bot token'}
            onChange={event => { setToken(event.target.value); setDirty(true); setNotice(''); }}
            className="mt-2 block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-gray-100" />
        </label>
        <label className="block text-sm text-gray-300">Telegram user ID
          <input type="text" inputMode="numeric" autoComplete="off" value={settings.userId} maxLength={16} placeholder="123456789"
            onChange={event => change({ userId: event.target.value })}
            className="mt-2 block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-gray-100" />
        </label>
        <p className="text-xs text-gray-400">Use your numeric user ID. Open your bot in Telegram and press Start once so it can message you. Notifications are skipped when the token or user ID is missing.</p>
        <div className="border-t border-white/10 pt-4 space-y-4">
          {eventOptions.map(([key, label, description]) => <label key={key} className="flex items-center justify-between gap-4 cursor-pointer">
            <span><span className="block text-sm text-gray-200">{label}</span><span className="block text-xs text-gray-400 mt-1">{description}</span></span>
            <input type="checkbox" checked={settings[key]} onChange={event => change({ [key]: event.target.checked })} className="h-4 w-4 accent-blue-500" />
          </label>)}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!dirty} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 text-sm text-white">Save</button>
          <button type="button" disabled={dirty || !settings.enabled || !settings.hasToken || !settings.userId}
            onClick={() => void request('test')} className="rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 px-4 py-2 text-sm text-gray-100">Send test</button>
          {(settings.hasToken || settings.userId) && <button type="button" onClick={() => void request('disconnect')} className="px-2 py-2 text-sm text-gray-400 hover:text-gray-100">Disconnect</button>}
        </div>
      </fieldset>
      {busy && <p role="status" className="text-sm text-gray-400 flex gap-2 items-center"><Loader2 size={15} className="animate-spin" /> Please wait…</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-400 flex gap-2 items-center"><Check size={15} />{notice}</p>}
      {settings.lastError && !error && <p className="text-sm text-amber-400">Last delivery: {settings.lastError}</p>}
    </form>}
    <div className="border-t border-white/10 pt-5 space-y-3">
      <p className="text-sm text-gray-300">Notification previews</p>
      {[
        ['✅ Turn finished', 'Chat search optimization', 'Your response is ready.'],
        ['⚠️ Chat error', 'Telegram integration', 'This turn stopped because of an error. Check Agentic for details.'],
        ['💬 Question for you', 'Sidebar redesign', 'Should pinned chats stay visible when the chat list is collapsed?'],
      ].map(([heading, title, body]) => <div key={heading} className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
        <div className="font-semibold text-gray-100">{heading}</div><div className="font-semibold text-gray-200 mt-1">{title}</div><div className="text-gray-400 mt-1">{body}</div>
      </div>)}
      <p className="text-xs text-gray-500">Notifications only. Answer questions and manage chats in Agentic.</p>
    </div>
  </div>;
}
