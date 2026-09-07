import { describe, expect, it } from 'bun:test';
import { decodeStoredMessage, encodeUserMessage } from './storedMessage';

describe('persisted attachments', () => {
  it('restores text, original filenames, thumbnails and bytes after serialization', () => {
    const files = [
      { id: 'a', name: 'original screenshot.png', type: 'image/png', size: 3, preview: 'data:image/png;base64,YWJj' },
      { id: 'b', name: 'Quarterly report.pdf', type: 'application/pdf', size: 3, preview: 'data:application/pdf;base64,ZGVm' },
    ];
    const stored = JSON.stringify(encodeUserMessage('Please review these.', files));
    const restored = decodeStoredMessage(stored);
    expect(restored.text).toBe('Please review these.');
    expect(restored.attachments.map(({ id: _id, ...file }) => file)).toEqual(files.map(({ id: _id, ...file }) => file));
    expect(decodeStoredMessage(stored, false).attachments.every(file => file.preview === undefined)).toBe(true);
  });

  it('restores old document and unnamed image records without exposing their encoded data', () => {
    const stored = JSON.stringify([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } },
      { type: 'document', name: 'notes.txt', data: 'data:text/plain;base64,YQ==' },
    ]);
    const restored = decodeStoredMessage(stored);
    expect(restored.text).toBe('');
    expect(restored.attachments[0]).toMatchObject({ name: 'Image 1.jpg', size: 3, preview: 'data:image/jpeg;base64,YWJj' });
    expect(restored.attachments[1]).toMatchObject({ name: 'notes.txt', size: 1, type: 'text/plain' });
  });

  it('does not mistake normal plain text or JSON values for attachment records', () => {
    for (const text of ['Hello', '[1, 2, 3]', '{"example": true}', '100% PR #42']) {
      expect(decodeStoredMessage(text)).toEqual({ text, attachments: [] });
    }
  });

  it('handles large image payloads without adding them to searchable text or metadata', () => {
    const restored = decodeStoredMessage(JSON.stringify([
      { type: 'text', text: 'Compare the screenshots.' },
      { type: 'image', name: 'comparison.png', source: { media_type: 'image/png', data: 'YWJj'.repeat(250_000) } },
    ]), false);
    expect(restored.text).toBe('Compare the screenshots.');
    expect(JSON.stringify(restored).length).toBeLessThan(300);
    expect(restored.attachments[0].size).toBe(750_000);
  });
});
