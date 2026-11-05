import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ReviewRepo } from '../../../shared/review';
import { ReviewRepoRow } from './ReviewRepoRow';

interface ReviewRepoListProps { repos: ReviewRepo[]; setRepos: React.Dispatch<React.SetStateAction<ReviewRepo[]>> }

export function ReviewRepoList({ repos, setRepos }: ReviewRepoListProps) {
  const [query, setQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const search = query.trim().toLowerCase();
  const shown = search ? repos.filter(repo => repo.fullName.toLowerCase().includes(search)) : repos;

  const sync = async () => {
    setSyncing(true); setError('');
    try {
      const response = await fetch('/api/review/sync', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Couldn’t refresh repositories.');
      setRepos(data);
    } catch (error) { setError(error instanceof Error ? error.message : 'Couldn’t reach the server.'); }
    finally { setSyncing(false); }
  };
  const replace = (repo: ReviewRepo) => setRepos(previous => previous.map(item => item.id === repo.id ? repo : item));

  return <section aria-labelledby="review-repos-heading" className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <h4 id="review-repos-heading" className="text-sm font-medium text-gray-100">Repositories</h4>
      <button type="button" aria-label="Refresh repositories" title="Refresh from GitHub" disabled={syncing} onClick={() => void sync()}
        className="p-1.5 rounded-md text-gray-400 hover:bg-white/5 hover:text-gray-200 disabled:opacity-50">
        <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
      </button>
    </div>
    {repos.length > 6 && <input type="search" value={query} onChange={event => setQuery(event.target.value)}
      placeholder="Search repositories" aria-label="Search repositories"
      className="block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600" />}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    {repos.length === 0 ? <p className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-gray-400">
      No repositories yet. Use Repository access to choose which repositories the app can see.
    </p> : <div className="rounded-xl border border-white/10 bg-black/20">
      <div aria-hidden="true" className="flex items-center gap-3 px-3 pt-2 text-[11px] text-gray-500">
        <span className="flex-1" /><span className="w-20 text-center">Review</span><span className="w-20 text-center">Automatic</span><span className="w-7" />
      </div>
      <ul className="divide-y divide-white/5">
        {shown.map(repo => <ReviewRepoRow key={repo.id} repo={repo} onChange={replace} />)}
      </ul>
      {shown.length === 0 && <p className="px-3 py-3 text-sm text-gray-400">No repositories match “{query.trim()}”.</p>}
    </div>}
  </section>;
}
