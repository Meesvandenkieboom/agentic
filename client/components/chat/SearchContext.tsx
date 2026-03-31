import { createContext, useContext } from 'react';

interface SearchContextValue {
  query: string;
  activeMessageId: string | null;
}

export const SearchContext = createContext<SearchContextValue>({
  query: '',
  activeMessageId: null,
});

export function useSearchContext() {
  return useContext(SearchContext);
}
