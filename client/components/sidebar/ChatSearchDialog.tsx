import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, Image, Loader2, MessageCircle, Search, X } from 'lucide-react';
import type { ChatSearchFilter, ChatSearchResponse, ChatSearchResult } from '../../../shared/chatSearch';

const filters: { value: ChatSearchFilter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'chats', label: 'Chats' },
  { value: 'images', label: 'Images' }, { value: 'files', label: 'Files' },
];

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let start = 0;
  let match = text.toLowerCase().indexOf(needle);
  while (match !== -1) {
    parts.push(text.slice(start, match), <mark key={match}>{text.slice(match, match + needle.length)}</mark>);
    start = match + needle.length;
    match = text.toLowerCase().indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

function resultDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

function SearchContent({ onSelect }: { onSelect: (result: ChatSearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatSearchFilter>('all');
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [scope, setScope] = useState<'recent' | 'all'>('recent');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, offset: String(offset), filter, scope });
        const response = await fetch(`/api/sessions/search?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Search failed');
        const data: ChatSearchResponse = await response.json();
        if (controller.signal.aborted) return;
        setResults(previous => offset ? [...previous, ...data.results] : data.results);
        setHasMore(data.hasMore);
        setHasOlder(!!data.hasOlder);
      } catch {
        if (!controller.signal.aborted) setError('Couldn’t search your chats. Please try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 200 : 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [query, offset, retry, filter, scope]);

  const changeQuery = (value: string, nextScope: 'recent' | 'all' = scope) => {
    setScope(nextScope);
    setQuery(value);
    setOffset(0);
    setResults([]);
    setHasMore(false);
    setHasOlder(false);
    setError('');
    setLoading(true);
    setActiveIndex(0);
    listRef.current?.scrollTo({ top: 0 });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      setActiveIndex(index);
      document.getElementById(`chat-search-result-${index}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onSelect(results[activeIndex]);
    }
  };

  return (
    <Dialog.Content className="global-chat-search" aria-describedby="chat-search-description">
      <Dialog.Title className="sr-only">Search chats</Dialog.Title>
      <Dialog.Description id="chat-search-description" className="sr-only">
        Search chat titles, messages, and attached filenames. Use the arrow keys to choose a result and Enter to open it.
      </Dialog.Description>
      <div className="global-chat-search-header">
        <input
          ref={inputRef}
          value={query}
          onChange={event => changeQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search chats and files..."
          aria-label="Search chats"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="chat-search-results"
          aria-activedescendant={results.length ? `chat-search-result-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
        />
        <div className="global-chat-search-actions">
          {query && <>
            <button type="button" onClick={() => { changeQuery(''); inputRef.current?.focus(); }}>Clear</button>
            <span className="global-chat-search-divider" aria-hidden="true" />
          </>}
          <Dialog.Close className="global-chat-search-close" aria-label="Close search" title="Close (Esc)">
            <X size={18} />
          </Dialog.Close>
        </div>
      </div>
      <div className="global-chat-search-filter" role="group" aria-label="Result type">
        {filters.map(item => <button
          key={item.value}
          type="button"
          aria-pressed={filter === item.value}
          onClick={() => {
            if (filter === item.value) return;
            setFilter(item.value);
            changeQuery(query);
          }}
        >{item.label}</button>)}
      </div>
      <div className="global-chat-search-range" role="status">
        {scope === 'recent' ? 'Chats active in the last 90 days' : 'Searching all dates'}
        {scope === 'all' && <button type="button" onClick={() => changeQuery(query, 'recent')}>Recent only</button>}
      </div>
      <div ref={listRef} className="global-chat-search-scroll">
        <div id="chat-search-results" role="listbox" aria-label="Search results" aria-busy={loading}>
          {results.map((result, index) => (
            <div
              key={result.id}
              id={`chat-search-result-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={`global-chat-search-result${index === activeIndex ? ' is-active' : ''}`}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onSelect(result)}
              onKeyDown={event => { if (event.key === 'Enter') onSelect(result); }}
            >
              {result.kind === 'image' ? <Image size={19} strokeWidth={1.6} aria-hidden="true" /> :
                result.kind === 'file' ? <FileText size={19} strokeWidth={1.6} aria-hidden="true" /> :
                  <MessageCircle size={19} strokeWidth={1.6} aria-hidden="true" />}
              <div className="global-chat-search-text">
                <div className="global-chat-search-title"><Highlight text={result.title} query={query} /></div>
                <div className="global-chat-search-preview"><Highlight text={result.preview || 'No messages yet'} query={query} /></div>
              </div>
              <time dateTime={result.updatedAt} className="global-chat-search-date">{resultDate(result.updatedAt)}</time>
            </div>
          ))}
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {!loading && !error ? `${results.length}${hasMore ? ' or more' : ''} results found` : ''}
        </div>
        {loading && <div className="global-chat-search-state" role="status"><Loader2 size={18} className="animate-spin" /> Searching chats…</div>}
        {error && <div className="global-chat-search-state" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => { setError(''); setLoading(true); setRetry(value => value + 1); }}>Try again</button>
        </div>}
        {!loading && !error && !results.length && <div className="global-chat-search-state">
          <Search size={24} strokeWidth={1.5} />
          <p>{query.trim() ? scope === 'recent' ? 'No recent results found' : 'No results found' : filter === 'files' || filter === 'images' ? 'No attachments yet' : 'No chats yet'}</p>
          <span>{query.trim() ? 'Try a different word or filename.' : 'Your conversations and attachments will appear here.'}</span>
        </div>}
        {hasMore && !loading && !error && <button type="button" className="global-chat-search-more" onClick={() => {
          setLoading(true); setOffset(results.length);
        }}>Show more results</button>}
        {hasOlder && !loading && !error && <button type="button" className="global-chat-search-more"
          onClick={() => changeQuery(query, 'all')}>Search older chats</button>}
      </div>
    </Dialog.Content>
  );
}

export function ChatSearchDialog({ onChatSelect }: { onChatSelect?: (id: string, messageId?: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button type="button" className="sidebar-search sidebar-search-trigger" title="Search chats (Ctrl/⌘+K)">
        <span className="sidebar-search-icon"><Search size={16} /></span>
        <span className="sidebar-search-input">Search</span>
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="global-chat-search-overlay" />
      <SearchContent onSelect={result => { setOpen(false); onChatSelect?.(result.sessionId, result.messageId); }} />
    </Dialog.Portal>
  </Dialog.Root>;
}
