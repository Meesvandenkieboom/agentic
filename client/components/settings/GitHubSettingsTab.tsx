import React, { useEffect, useState } from 'react';
import { Github, Loader2, ScanSearch } from 'lucide-react';
import { AgenticReviewTab } from './AgenticReviewTab';

type Section = 'review' | 'account';
const SECTIONS: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'review', label: 'Agentic Review', icon: ScanSearch },
  { id: 'account', label: 'Account', icon: Github },
];

export function GitHubSettingsTab() {
  const [section, setSection] = useState<Section>('review');
  return <div className="p-6 space-y-6">
    <div role="tablist" aria-label="GitHub settings" className="inline-flex rounded-lg border border-white/10 bg-black/20 p-1">
      {SECTIONS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id)}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${section === id ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
        <Icon size={15} className={section === id ? 'text-blue-400' : ''} />{label}
      </button>)}
    </div>
    {section === 'review' ? <AgenticReviewTab /> : <AccountSection />}
  </div>;
}

interface GitHubStatus { connected: boolean; configured: boolean; user?: { login: string; name: string | null; avatar_url: string }; message?: string }

function AccountSection() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => fetch('/api/github/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ connected: false, configured: false, message: 'Couldn’t reach the server.' }));
  useEffect(() => { void load(); }, []);

  const connect = async () => {
    setBusy(true);
    const data = await fetch('/api/github/auth').then(r => r.json()).catch(() => null) as { authUrl?: string } | null;
    if (data?.authUrl) window.location.href = data.authUrl;
    else setBusy(false);
  };
  const disconnect = async () => {
    setBusy(true);
    await fetch('/api/github/disconnect', { method: 'POST' }).catch(() => undefined);
    await load();
    setBusy(false);
  };

  if (!status) return <p role="status" className="text-sm text-gray-400">Loading…</p>;
  return <div className="space-y-4">
    <div>
      <h3 className="text-lg font-semibold text-gray-100">GitHub account</h3>
      <p className="text-sm text-gray-400 mt-1">Used by chats to clone repositories and push changes. Agentic Review uses its own GitHub App instead.</p>
    </div>
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/20 p-4">
      {status.connected && status.user ? <div className="flex items-center gap-3 min-w-0">
        <img src={status.user.avatar_url} alt="" className="h-9 w-9 rounded-full" />
        <div className="min-w-0"><p className="text-sm text-gray-100 truncate">{status.user.name || status.user.login}</p><p className="text-xs text-gray-400">@{status.user.login}</p></div>
      </div> : <p className="text-sm text-gray-400">{status.configured ? 'Not connected.' : 'GitHub sign-in isn’t set up yet. Use “Connect to GitHub” in the sidebar to configure it.'}</p>}
      {status.configured && <button disabled={busy} onClick={() => void (status.connected ? disconnect() : connect())}
        className="flex items-center gap-2 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 px-3 py-1.5 text-sm text-gray-100">
        {busy && <Loader2 size={14} className="animate-spin" />}{status.connected ? 'Disconnect' : 'Connect'}
      </button>}
    </div>
  </div>;
}
