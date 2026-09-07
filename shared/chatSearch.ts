export interface ChatSearchResult {
  id: string;
  kind: 'chat' | 'file' | 'image';
  sessionId: string;
  messageId?: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export type ChatSearchFilter = 'all' | 'chats' | 'files' | 'images';

export interface ChatSearchResponse {
  results: ChatSearchResult[];
  hasMore: boolean;
}
