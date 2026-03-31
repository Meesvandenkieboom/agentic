import React, { useRef, useEffect } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';

interface ChatSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  currentMatchIndex: number;
  totalMatches: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function ChatSearchBar({
  query,
  onQueryChange,
  currentMatchIndex,
  totalMatches,
  onNext,
  onPrevious,
  onClose,
}: ChatSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (e.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        onPrevious();
      }
    };

    const input = inputRef.current;
    input?.addEventListener('keydown', handleKeyDown);
    return () => input?.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNext, onPrevious]);

  return (
    <div className="chat-search-bar">
      <div className="chat-search-bar-inner">
        <Search className="chat-search-bar-icon" size={14} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search in chat..."
          className="chat-search-bar-input"
          spellCheck={false}
        />
        {query && (
          <span className="chat-search-bar-count">
            {totalMatches > 0
              ? `${currentMatchIndex + 1}/${totalMatches}`
              : 'No results'}
          </span>
        )}
        <div className="chat-search-bar-actions">
          <button
            onClick={onPrevious}
            disabled={totalMatches === 0}
            className="chat-search-bar-nav"
            aria-label="Previous match"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={onNext}
            disabled={totalMatches === 0}
            className="chat-search-bar-nav"
            aria-label="Next match"
            title="Next (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={onClose}
            className="chat-search-bar-close"
            aria-label="Close search"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
