import { createContext, useContext } from 'react';

interface SearchContextValue {
  query: string;
  currentMatchMessageIndex: number | null;
  /** Global match index (0-based across all messages) — used for active highlight + scroll trigger */
  currentMatchIndex: number;
}

export const SearchContext = createContext<SearchContextValue>({
  query: '',
  currentMatchMessageIndex: null,
  currentMatchIndex: 0,
});

export function useSearchContext() {
  return useContext(SearchContext);
}
