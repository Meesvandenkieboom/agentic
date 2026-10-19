import { Clock } from 'lucide-react';
import type { QueuedInput } from '../../hooks/useQueuedInputs';

export function QueuedMessages({ items }: { items: QueuedInput[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2 w-full flex flex-col gap-1.5">
      {items.map(item => (
        <div key={item.id} className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70">
          <Clock size={14} className="mt-0.5 shrink-0 text-white/40" />
          <div className="min-w-0 flex-1">
            <p className="truncate">{item.text.trim() || `${item.files?.length ?? 0} attachment(s)`}</p>
            <p className="text-xs text-white/40">Queued · Claude reads this after its current step</p>
          </div>
        </div>
      ))}
    </div>
  );
}
