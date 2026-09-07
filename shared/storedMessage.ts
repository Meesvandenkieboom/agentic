export interface StoredAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  preview?: string;
}

/** Keep attachment names alongside the provider content so they survive a restart/export. */
export function encodeUserMessage(text: string, files: StoredAttachment[] = []): string | Array<Record<string, unknown>> {
  if (!files.length) return text;
  const blocks: Array<Record<string, unknown>> = text.trim() ? [{ type: 'text', text }] : [];
  for (const file of files) {
    if (!file.preview) continue;
    if (file.type.startsWith('image/')) {
      const prefix = file.preview.match(/^data:([^;]+);base64,/);
      if (prefix) blocks.push({
        type: 'image', name: file.name, size: file.size,
        source: { type: 'base64', media_type: prefix[1], data: file.preview.slice(prefix[0].length) },
      });
    } else {
      blocks.push({ type: 'document', name: file.name, size: file.size, media_type: file.type, data: file.preview });
    }
  }
  return blocks;
}

/** Decode the stored wire format for display and search, never rendering its JSON as prose. */
export function decodeStoredMessage(content: string, includePreviews = true): {
  text: string;
  attachments: StoredAttachment[];
} {
  let blocks: unknown;
  try { blocks = JSON.parse(content); } catch { /* Ordinary plain text. */ }
  if (!Array.isArray(blocks) || !blocks.some(block => block && typeof block === 'object' && typeof block.type === 'string')) {
    return { text: content, attachments: [] };
  }

  const text: string[] = [];
  const attachments: StoredAttachment[] = [];
  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type !== 'image' && block.type !== 'document') continue;

    const source = block.source && typeof block.source === 'object' ? block.source : {};
    const data = typeof block.data === 'string' ? block.data : typeof source.data === 'string' ? source.data : '';
    const dataPrefix = data.match(/^data:([^;,]+);base64,/);
    const type = dataPrefix?.[1] || (typeof source.media_type === 'string' ? source.media_type :
      typeof block.media_type === 'string' ? block.media_type : block.type === 'image' ? 'image/png' : 'application/octet-stream');
    const extension = type.startsWith('image/') ? type.slice(6).replace('jpeg', 'jpg').replace('svg+xml', 'svg') : '';
    const fallback = block.type === 'image' ? `Image ${attachments.length + 1}.${extension || 'png'}` : `File ${attachments.length + 1}`;
    const originalName = typeof block.name === 'string' ? block.name : typeof block.title === 'string' ? block.title : fallback;
    const name = originalName.split(/[\\/]/).pop() || fallback;
    const payloadLength = data.length - (dataPrefix?.[0].length || 0);
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const size = typeof block.size === 'number' && Number.isFinite(block.size) && block.size >= 0
      ? block.size : Math.max(0, Math.floor(payloadLength * 3 / 4) - padding);
    attachments.push({
      id: `attachment-${index}`,
      name,
      type,
      size,
      ...(includePreviews && data ? { preview: dataPrefix ? data : `data:${type};base64,${data}` } : {}),
    });
  }
  return { text: text.join('\n'), attachments };
}
