import React, { useState } from 'react';
import { CheckCircle2, Clock, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { triggerLabel, type ReviewFindingCounts, type ReviewJob, type ReviewJobStatus } from '../../../shared/review';

const statusIcons: Record<ReviewJobStatus, { icon: React.ElementType; className: string }> = {
  queued: { icon: Clock, className: 'text-gray-400' },
  running: { icon: Loader2, className: 'text-blue-400 animate-spin' },
  done: { icon: CheckCircle2, className: 'text-green-400' },
  failed: { icon: XCircle, className: 'text-red-400' },
  cancelled: { icon: MinusCircle, className: 'text-gray-500' },
  skipped: { icon: MinusCircle, className: 'text-gray-500' },
};
const chip = 'rounded border border-white/10 px-1.5 text-[11px] text-gray-300';

function Findings({ counts }: { counts: ReviewFindingCounts }) {
  return <span className="flex flex-wrap items-center gap-1">
    {counts.P0 + counts.P1 + counts.P2 === 0 ? <span className={chip}>no issues</span> : <>
      <span className={chip} title="P0 findings">🔴 {counts.P0}</span>
      <span className={chip} title="P1 findings">🟠 {counts.P1}</span>
      <span className={chip} title="P2 findings">🟡 {counts.P2}</span>
    </>}
    {counts.fixed > 0 && <span className={chip}>✅ {counts.fixed} fixed</span>}
  </span>;
}

export function ReviewJobList({ jobs, onRefresh }: { jobs: ReviewJob[]; onRefresh: () => void }) {
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [error, setError] = useState('');

  const cancel = async (id: number) => {
    setCancelling(id); setError('');
    try {
      const response = await fetch(`/api/review/jobs/${id}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Couldn’t cancel this review.');
      onRefresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Couldn’t reach the server.'); }
    finally { setCancelling(null); }
  };

  if (!jobs.length) return <p className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-gray-400">No reviews yet.</p>;
  return <div className="space-y-2">
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    <ul className="rounded-xl border border-white/10 bg-black/20 divide-y divide-white/5">
      {jobs.map(job => {
        const { icon: Icon, className } = statusIcons[job.status];
        const active = job.status === 'queued' || job.status === 'running';
        return <li key={job.id} className="flex items-start gap-3 px-3 py-2.5">
          <Icon size={15} aria-label={job.status} className={`mt-0.5 shrink-0 ${className}`} />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a href={job.prUrl} target="_blank" rel="noreferrer" className="text-sm text-gray-100 hover:underline break-all">{job.repo}#{job.pr}</a>
              <span className="text-xs text-gray-400">{job.trigger || triggerLabel(job.kind, job.actor)}</span>
              {job.status === 'done' && job.findings && <Findings counts={job.findings} />}
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {formatDistanceToNowStrict(job.finishedAt ?? job.startedAt ?? job.createdAt, { addSuffix: true })}
              {job.reviewUrl && <> · <a href={job.reviewUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">View review</a></>}
            </p>
            {job.error && <p className={`mt-1 text-xs break-words ${job.status === 'failed' ? 'text-red-300' : job.status === 'done' ? 'text-amber-300' : 'text-gray-400'}`}>{job.error}</p>}
          </div>
          {active && <button type="button" disabled={cancelling === job.id} onClick={() => void cancel(job.id)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-white/5 hover:text-gray-100 disabled:opacity-50">Cancel</button>}
        </li>;
      })}
    </ul>
  </div>;
}
