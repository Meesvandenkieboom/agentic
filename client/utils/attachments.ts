/**
 * Shared attachment helpers for chat inputs (ChatInput, NewChatWelcome).
 */

import type { FileAttachment } from '../components/message/types';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a file as a base64 data-URL attachment. Any file type is allowed. */
export async function fileToAttachment(file: File, nameOverride?: string): Promise<FileAttachment> {
  const preview = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.readAsDataURL(file);
  });

  return {
    id: `${Date.now()}-${Math.random()}`,
    name: nameOverride ?? file.name,
    size: file.size,
    type: file.type,
    preview,
  };
}

export function filesToAttachments(files: File[]): Promise<FileAttachment[]> {
  return Promise.all(
    files.map((file, i) =>
      fileToAttachment(
        file,
        // Pasted screenshots come in as a generic "image.png" — give them a unique name
        file.type.startsWith('image/') && file.name === 'image.png'
          ? `pasted-image-${Date.now()}-${i}.${file.type.split('/')[1]}`
          : undefined,
      )
    )
  );
}

/**
 * True when the draft starts with a known slash command — the only case
 * where the command-pill overlay should replace the textarea's own text.
 * A loose "/word anywhere" regex here previously matched pasted prose
 * (e.g. "the /poll endpoint") and turned the typed text invisible.
 */
export function isCommandDraft(value: string, commands: Array<{ name: string }>): boolean {
  const m = value.match(/^\/([a-z0-9-]+)(\s|$)/);
  if (!m) return false;
  return commands.some((c) => c.name === m[1]);
}
