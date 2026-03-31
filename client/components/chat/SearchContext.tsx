import { createContext, useContext } from 'react';

interface SearchContextValue {
  query: string;
  currentMatchMessageIndex: number | null;
}

export const SearchContext = createContext<SearchContextValue>({
  query: '',
  currentMatchMessageIndex: null,
});

export function useSearchContext() {
  return useContext(SearchContext);
}
