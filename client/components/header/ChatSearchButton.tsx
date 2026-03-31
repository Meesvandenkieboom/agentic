import React from 'react';
import { Search } from 'lucide-react';

interface ChatSearchButtonProps {
  onClick: () => void;
}

export function ChatSearchButton({ onClick }: ChatSearchButtonProps) {
  return (
    <button
      onClick={onClick}
      className="p-2 hover:bg-white/10 rounded-lg transition-colors"
      aria-label="Search in chat"
      title="Search in chat (Ctrl+F)"
    >
      <Search className="w-4 h-4" style={{ color: 'rgb(var(--text-secondary))' }} />
    </button>
  );
}
