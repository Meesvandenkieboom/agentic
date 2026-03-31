import { createContext, useContext } from 'react';

export interface SearchMatchInfo {
  messageId: string;
  messageIndex: number;
  matchStart: number;
}

interface SearchContextValue {
  query: string;
  currentMatchMessageIndex: number | null;
  /** Global match index (0-based) — used as scroll trigger */
  currentMatchIndex: number;
  /** Metadata for the active match — used to find the correct DOM range */
  currentMatch: SearchMatchInfo | null;
  /** All matches — used to compute per-message occurrence indices */
  allMatches: SearchMatchInfo[];
}

export const SearchContext = createContext<SearchContextValue>({
  query: '',
  currentMatchMessageIndex: null,
  currentMatchIndex: 0,
  currentMatch: null,
  allMatches: [],
});

export function useSearchContext() {
  return useContext(SearchContext);
}
