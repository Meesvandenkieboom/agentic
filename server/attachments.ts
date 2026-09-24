import * as path from 'node:path';
import { saveImageToSessionPictures, saveFileToSessionFiles } from './imageUtils';
import type { ContentBlock, ImageBlock } from './sessionStreamManager';

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
  const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

  for (const block of contentBlocks) {
    if (block.type === 'image' && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
        if (supportedImageTypes.has(mediaType)) {
          const base64Data = `data:${mediaType};base64,${source.data}`;
          const imagePath = saveImageToSessionPictures(base64Data, sessionId, metadataDir);
          imagePaths.push(path.resolve(metadataDir, imagePath));
          imageBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as ImageBlock['source']['media_type'],
              data: source.data,
            },
          });
        } else {
          const name = typeof block.name === 'string' ? path.basename(block.name) : 'unsupported-image';
          const filePath = saveFileToSessionFiles(source.data, name, sessionId, metadataDir);
          filePaths.push(path.resolve(metadataDir, filePath));
        }
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

