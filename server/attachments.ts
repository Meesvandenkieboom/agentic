import * as path from 'node:path';
import { saveImageToSessionPictures, saveFileToSessionFiles } from './imageUtils';
import type { ContentBlock } from './sessionStreamManager';

export function processAttachments(
  content: unknown,
  sessionId: string,
  metadataDir: string,
): { imageBlocks: ContentBlock[]; imagePaths: string[]; filePaths: string[] } {
  const imageBlocks: ContentBlock[] = [];
  const imagePaths: string[] = [];
  const filePaths: string[] = [];

  if (!Array.isArray(content)) return { imageBlocks, imagePaths, filePaths };

  const contentBlocks = content as Array<Record<string, unknown>>;

  for (const block of contentBlocks) {
    if (block.type === 'image' && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const base64Data = `data:${source.media_type || 'image/png'};base64,${source.data}`;
        const imagePath = saveImageToSessionPictures(base64Data, sessionId, metadataDir);
        imagePaths.push(path.resolve(metadataDir, imagePath));
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (source.media_type as string) || 'image/png',
            data: source.data as string,
          },
        });
      }
    }

    if (block.type === 'document' && typeof block.data === 'string' && typeof block.name === 'string') {
      const filePath = saveFileToSessionFiles(block.data as string, block.name as string, sessionId, metadataDir);
      filePaths.push(path.resolve(metadataDir, filePath));
    }
  }

  if (imageBlocks.length > 0 || filePaths.length > 0) {
    console.log(`📎 Attachments: ${imageBlocks.length} image(s), ${filePaths.length} file(s)`);
  }

  return { imageBlocks, imagePaths, filePaths };
}

