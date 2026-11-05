import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { reviewModels, type ReviewAppState, type ReviewJob, type ReviewRepo, type ReviewSettings } from '../../../shared/review';
import { ReviewRepoList } from './ReviewRepoList';
import { ReviewJobList } from './ReviewJobList';
import { reviewTemplate } from './reviewTemplate';

const STEPS = ['Create the GitHub App', 'Install it on repositories', 'Choose which repositories get reviewed'];
const OWNERS = [['user', 'Personal account'], ['org', 'Organization']] as const;
const card = 'rounded-xl border border-white/10 bg-black/20 p-4';
const primary = 'flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-1.5 text-sm text-white';
const secondary = 'flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 px-2.5 py-1.5 text-xs text-gray-100';
const input = 'mt-1.5 block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600';
const openTab = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function Steps({ active }: { active: number }) {
  return <ol className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
    {STEPS.map((label, index) => {
      const step = index + 1;
      return <li key={label} aria-current={step === active ? 'step' : undefined} className={`flex items-center gap-2 ${step > active ? 'text-gray-500' : 'text-gray-200'}`}>
        <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === active ? 'bg-blue-600 text-white' : step < active ? 'bg-blue-600/20 text-blue-300' : 'border border-white/15'}`}>
          {step < active ? <Check size={12} /> : step}
        </span>{label}
      </li>;
    })}
  </ol>;
}

export function AgenticReviewTab() {
  const [app, setApp] = useState<ReviewAppState | null>(null);
  const [repos, setRepos] = useState<ReviewRepo[]>([]);
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'poll' | 'disconnect' | 'model' | null>(null);
  const [copied, setCopied] = useState<'trigger' | 'template' | null>(null);
  const [ownerKind, setOwnerKind] = useState<'user' | 'org'>('user');
  const [org, setOrg] = useState('');
  const [name, setName] = useState('agentic-review');

  const loadJobs = useCallback(() => api<ReviewJob[]>('/api/review/jobs?limit=20').then(setJobs), []);
  const refresh = useCallback(async () => {
    try {
      const state = await api<ReviewAppState>('/api/review/app');
      if (state.status === 'installed') {
        const [nextRepos, nextJobs] = await Promise.all([api<ReviewRepo[]>('/api/review/repos'), api<ReviewJob[]>('/api/review/jobs?limit=20')]);
        setRepos(nextRepos); setJobs(nextJobs);
      }
      setApp(state); setLoadError('');
    } catch { setLoadError('Couldn’t load Agentic Review.'); }
  }, []);

  useEffect(() => {
    void refresh();
    // The GitHub setup flow happens in another tab, so pick up its result when the user comes back.
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const working = jobs.some(job => job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void loadJobs().catch(() => undefined); }, 10_000);
    return () => window.clearInterval(timer);
  }, [working, loadJobs]);

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : 'Couldn’t reach the server.'); }
    finally { setBusy(null); }
  };
  const checkNow = () => run('poll', async () => {
    await api('/api/review/poll', { method: 'POST' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await refresh();
  });
  const forget = (message: string) => {
    if (!window.confirm(message)) return;
    void run('disconnect', async () => {
      setApp(await api<ReviewAppState>('/api/review/app', { method: 'DELETE' }));
      setRepos([]); setJobs([]);
    });
  };
  const changeModel = (model: string) => {
    if (!app) return;
    const previous = app.settings;
    setApp({ ...app, settings: { ...previous, model } });
    void run('model', async () => {
      try {
        const settings = await api<ReviewSettings>('/api/review/settings', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
        });
        setApp(current => current && { ...current, settings });
      } catch (error) {
        setApp(current => current && { ...current, settings: previous });
        throw error;
      }
    });
  };
  const copy = async (key: 'trigger' | 'template', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(current => current === key ? null : current), 1500);
    } catch { setError('Couldn’t copy to the clipboard.'); }
  };
  const createApp = () => {
    const params = new URLSearchParams({ name: name.trim() });
    if (ownerKind === 'org') params.set('owner', org.trim());
    openTab(`/api/review/app/manifest-form?${params}`);
  };

  if (!app) return <div role="status" className="text-sm text-gray-400">
    {loadError ? <><p role="alert">{loadError}</p><button type="button" className="mt-2 underline" onClick={() => void refresh()}>Try again</button></> : 'Loading…'}
  </div>;

  const alerts = <>
    {loadError && <p role="alert" className="text-sm text-red-400">{loadError} <button type="button" className="underline" onClick={() => void refresh()}>Try again</button></p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </>;

  if (app.status === 'none' || !app.app) return <div className="space-y-4">
    {alerts}
    <div className={`${card} space-y-4`}>
      <div>
        <h3 className="text-base font-semibold text-gray-100">Set up Agentic Review</h3>
        <p className="mt-1 text-sm text-gray-400">Agentic Review posts pull request reviews from your own GitHub App and runs them on this machine with Claude — like Codex Review, but you own the bot.</p>
      </div>
      <Steps active={1} />
      <form onSubmit={event => { event.preventDefault(); createApp(); }} className="space-y-4 border-t border-white/10 pt-4">
        <div className="space-y-1.5">
          <span id="review-owner-label" className="block text-xs text-gray-300">Owner</span>
          <div role="radiogroup" aria-labelledby="review-owner-label" className="inline-flex rounded-lg border border-white/10 bg-black/20 p-1">
            {OWNERS.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={ownerKind === id} onClick={() => setOwnerKind(id)}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${ownerKind === id ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>)}
          </div>
        </div>
        {ownerKind === 'org' && <label className="block text-xs text-gray-300">Organization login
          <input value={org} onChange={event => setOrg(event.target.value)} required autoComplete="off" spellCheck={false} placeholder="your-org" className={input} />
        </label>}
        <label className="block text-xs text-gray-300">App name
          <input value={name} onChange={event => setName(event.target.value)} required maxLength={34} autoComplete="off" spellCheck={false} className={input} />
          <span className="mt-1.5 block text-gray-500">{'Must be unique on GitHub, e.g. agentic-review-yourname. It becomes the bot handle: @<name> review.'}</span>
        </label>
        <p className="text-xs text-gray-500">Private apps can only be installed on the account that owns them — pick the organization that owns your repositories.</p>
        <button type="submit" disabled={!name.trim() || (ownerKind === 'org' && !org.trim())} className={primary}>Create GitHub App <ExternalLink size={14} /></button>
      </form>
    </div>
  </div>;

  const { slug, owner, htmlUrl } = app.app;
  const installUrl = app.installUrl;
  if (app.status === 'created') return <div className="space-y-4">
    {alerts}
    <div className={`${card} space-y-4`}>
      <h3 className="text-base font-semibold text-gray-100">Install @{slug} on your repositories</h3>
      <Steps active={2} />
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
        <button type="button" disabled={!installUrl} onClick={() => installUrl && openTab(installUrl)} className={primary}>Install on GitHub <ExternalLink size={14} /></button>
        <button type="button" disabled={busy === 'disconnect'} className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:bg-white/5 hover:text-gray-100 disabled:opacity-50"
          onClick={() => forget('Start over? Agentic forgets this GitHub App. Delete it on GitHub too if you won’t reuse it.')}>Start over</button>
      </div>
    </div>
  </div>;

  const trigger = app.trigger ?? `@${slug} review`;
  return <div className="space-y-6">
    {alerts}
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-500/15 text-blue-300"><Bot size={18} /></div>
        <div className="flex-1 min-w-40">
          <h3 className="font-medium text-gray-100">{slug}[bot]</h3>
          <p className="text-xs text-gray-400">Owned by {owner} · {app.lastPollAt ? `checked ${formatDistanceToNowStrict(app.lastPollAt)} ago` : 'waiting for first check'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy === 'poll'} onClick={() => void checkNow()} className={secondary}>
            {busy === 'poll' && <Loader2 size={12} className="animate-spin" />}Check now
          </button>
          {installUrl && <button type="button" onClick={() => openTab(installUrl)} className={secondary}>Repository access <ExternalLink size={12} /></button>}
          <button type="button" onClick={() => openTab(htmlUrl)} className={secondary}>Manage app <ExternalLink size={12} /></button>
        </div>
      </div>
      {app.lastError && <p className="text-xs text-amber-400">{app.lastError}</p>}
    </div>

    <div className={`${card} space-y-2`}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
        Comment on a pull request to request a review:
        <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/30 py-0.5 pl-2 pr-0.5">
          <code className="font-mono text-xs text-gray-100">{trigger}</code>
          <button type="button" aria-label="Copy trigger comment" title="Copy" onClick={() => void copy('trigger', trigger)} className="p-1 rounded text-gray-400 hover:text-gray-100">
            {copied === 'trigger' ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </div>
      <p className="text-xs text-gray-400">Add a focus after it: <code className="font-mono text-gray-300">{trigger} check the hot path</code>. Only collaborators with write access can trigger reviews.</p>
    </div>

    <ReviewRepoList repos={repos} setRepos={setRepos} />

    <div className={`${card} space-y-1.5`}>
      <label className="flex items-center justify-between gap-4 text-sm text-gray-100">Review model
        <select value={app.settings.model} disabled={busy === 'model'} onChange={event => changeModel(event.target.value)}
          className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-gray-100 disabled:opacity-50">
          {reviewModels.map(model => <option key={model.id} value={model.id} className="bg-[#1a1c1e]">{model.label}</option>)}
        </select>
      </label>
      <p className="text-xs text-gray-400">Reviews run on your Claude account. Each review uses several agent passes plus verification.</p>
    </div>

    <section aria-labelledby="review-jobs-heading" className="space-y-3">
      <h4 id="review-jobs-heading" className="text-sm font-medium text-gray-100">Recent reviews</h4>
      <ReviewJobList jobs={jobs} onRefresh={() => { void loadJobs().catch(() => undefined); }} />
    </section>

    <details className={card}>
      <summary className="cursor-pointer select-none text-sm text-gray-100">Write a REVIEW.md for sharper reviews</summary>
      <div className="mt-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-gray-400">Agentic Review reads REVIEW.md, AGENTS.md and CLAUDE.md from the base branch. REVIEW.md front matter marks hot paths and files to ignore.</p>
          <button type="button" onClick={() => void copy('template', reviewTemplate)} className={`${secondary} shrink-0`}>
            {copied === 'template' ? <Check size={12} /> : <Copy size={12} />}Copy template
          </button>
        </div>
        <pre className="max-h-64 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-300">{reviewTemplate}</pre>
      </div>
    </details>

    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4 text-xs text-gray-500">
      <p>Reviews run only while Agentic is open; requests made while it’s closed are picked up when it starts.</p>
      <button type="button" disabled={busy === 'disconnect'} className="text-gray-400 hover:text-red-300 disabled:opacity-50"
        onClick={() => forget(`Disconnect @${slug}? Agentic stops reviewing pull requests on this machine. The app stays on GitHub until you delete it there.`)}>Disconnect app</button>
    </div>
  </div>;
}
