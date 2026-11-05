import { useState } from 'react';
import { ChevronDown, Globe, Loader2, Lock } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import type { ReviewRepo } from '../../../shared/review';

type RepoPatch = Partial<Pick<ReviewRepo, 'enabled' | 'automatic' | 'instructions'>>;

interface SwitchProps { checked: boolean; label: string; title?: string; disabled?: boolean; onChange: (checked: boolean) => void }

function Switch({ checked, label, title, disabled, onChange }: SwitchProps) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled}
    onClick={() => onChange(!checked)} className="flex items-center disabled:opacity-40">
    <span className={`flex items-center w-8 h-5 rounded-full p-0.5 ${checked ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-3' : ''}`} />
    </span>
  </button>;
}

export function ReviewRepoRow({ repo, onChange }: { repo: ReviewRepo; onChange: (repo: ReviewRepo) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const instructions = draft ?? repo.instructions;
  const dirty = draft !== null && draft !== repo.instructions;
  const RepoIcon = repo.private ? Lock : Globe;

  const update = async (patch: RepoPatch) => {
    if (saving) return false;
    setSaving(true); setError('');
    onChange({ ...repo, ...patch });
    try {
      const response = await fetch(`/api/review/repos/${repo.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Couldn’t update this repository.');
      onChange(data);
      return true;
    } catch (error) {
      onChange(repo);
      setError(error instanceof Error ? error.message : 'Couldn’t reach the server.');
      return false;
    } finally { setSaving(false); }
  };
  const save = async () => { if (await update({ instructions })) setDraft(null); };

  return <li className="px-3 py-2.5">
    <div className="flex items-center gap-3">
      <RepoIcon size={14} className="shrink-0 text-gray-500" aria-label={repo.private ? 'Private repository' : 'Public repository'} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-100 truncate">{repo.fullName}</p>
        <p className="text-xs text-gray-500 truncate">
          {repo.lastReview ? <a href={repo.lastReview.url} target="_blank" rel="noreferrer" className="hover:text-gray-300 hover:underline">
            Last review #{repo.lastReview.pr} · {formatDistanceToNowStrict(repo.lastReview.at, { addSuffix: true })} · {repo.lastReview.status}
          </a> : 'No reviews yet'}
        </p>
      </div>
      <div className="w-20 flex justify-center">
        <Switch checked={repo.enabled} label={`Review ${repo.fullName}`} onChange={enabled => void update({ enabled })} />
      </div>
      <div className="w-20 flex justify-center">
        <Switch checked={repo.automatic} label={`Automatic reviews for ${repo.fullName}`} disabled={!repo.enabled}
          title="Review every new pull request and drafts marked ready, without a comment" onChange={automatic => void update({ automatic })} />
      </div>
      <button type="button" aria-expanded={open} aria-label={`Review instructions for ${repo.fullName}`} title="Review instructions"
        onClick={() => setOpen(value => !value)} className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:bg-white/5 hover:text-gray-200">
        <ChevronDown size={15} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
    {error && <p role="alert" className="mt-1 ml-[26px] text-xs text-red-300">{error}</p>}
    {open && <div className="mt-3 ml-[26px] space-y-2">
      <label className="block text-xs text-gray-300">Review instructions
        <textarea value={instructions} maxLength={4000} rows={5} onChange={event => setDraft(event.target.value)}
          placeholder="e.g. src/engine/** is the hot path: no RPC calls, allocations or locks there."
          className="mt-1.5 block w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600" />
      </label>
      <div className="flex items-center gap-3">
        <button type="button" disabled={!dirty || saving} onClick={() => void save()}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-1.5 text-xs text-white">
          {saving && <Loader2 size={12} className="animate-spin" />}Save
        </button>
        <p className="text-xs text-gray-500">Added to every review of this repository. For rules your team shares, commit a REVIEW.md instead.</p>
      </div>
    </div>}
  </li>;
}
