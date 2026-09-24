import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAttachments } from './attachments';

describe('Claude image attachments', () => {
  it('sends supported images to the SDK and keeps unsupported images as files', () => {
    const metadataDir = mkdtempSync(join(tmpdir(), 'agentic-attachments-'));
    try {
      const { imageBlocks, imagePaths, filePaths } = processAttachments([
        { type: 'image', name: 'photo.png', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
        { type: 'image', name: 'diagram.svg', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
      ], 'session-1', metadataDir);

      expect(imageBlocks).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }]);
      expect(readFileSync(imagePaths[0], 'utf8')).toBe('abc');
      expect(filePaths[0]).toBe(join(metadataDir, 'files', 'diagram.svg'));
      expect(readFileSync(filePaths[0], 'utf8')).toBe('<svg>');
    } finally {
      rmSync(metadataDir, { recursive: true, force: true });
    }
  });
});
