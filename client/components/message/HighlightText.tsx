import React from 'react';
import { useSearchContext } from '../chat/SearchContext';

interface HighlightTextProps {
  text: string;
}

/** Wraps matching substrings in <mark> elements with the search-highlight class */
export function HighlightText({ text }: HighlightTextProps) {
  const { query } = useSearchContext();

  if (!query || query.length === 0) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  while (lastIndex < text.length) {
    const idx = lowerText.indexOf(lowerQuery, lastIndex);
    if (idx === -1) {
      parts.push(text.slice(lastIndex));
      break;
    }
    // Text before match
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx));
    }
    // The match itself
    parts.push(
      <mark key={key++} className="search-highlight">
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    lastIndex = idx + query.length;
  }

  return <>{parts}</>;
}
