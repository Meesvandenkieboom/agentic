/**
 * Attachment chip list shown above the chat input.
 * Collapses to the first VISIBLE_LIMIT chips with a "+N more" card.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import type { FileAttachment } from '../message/types';
import { formatFileSize } from '../../utils/attachments';

const VISIBLE_LIMIT = 3;

interface AttachmentChipsProps {
  files: FileAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ files, onRemove }: AttachmentChipsProps) {
  const [expanded, setExpanded] = useState(false);

  if (files.length === 0) return null;

  const visible = expanded ? files : files.slice(0, VISIBLE_LIMIT);
  const hidden = files.length - visible.length;

  return (
    <div className="flex flex-wrap gap-2 items-center mx-2 mt-2.5 -mb-1">
      {visible.map((file) => (
        <div
          key={file.id}
          className="flex relative gap-1 items-center p-1.5 w-60 max-w-60 text-left bg-gray-800 rounded-2xl border border-gray-700 group"
        >
          {/* Preview thumbnail */}
          <div className="flex justify-center items-center">
            <div className="overflow-hidden relative flex-shrink-0 w-12 h-12 rounded-lg border border-gray-700">
              {file.preview && file.type.startsWith('image/') ? (
                <img
                  src={file.preview}
                  alt={file.name}
                  className="rounded-lg w-full h-full object-cover object-center"
                  draggable="false"
                />
              ) : (
                <div className="flex items-center justify-center w-full h-full bg-gray-800 text-gray-400 text-xs font-medium">
                  {file.name.split('.').pop()?.toUpperCase()}
                </div>
              )}
            </div>
          </div>

          {/* File info */}
          <div className="flex flex-col justify-center px-2.5 -space-y-0.5 flex-1 min-w-0 overflow-hidden">
            <div className="mb-1 text-sm font-medium text-gray-100 truncate w-full">
              {file.name}
            </div>
            <div className="flex justify-between text-xs text-gray-500 line-clamp-1">
              <span>File</span>
              <span className="capitalize">{formatFileSize(file.size)}</span>
            </div>
          </div>

          {/* Remove button */}
          <div className="absolute -top-1 -right-1">
            <button
              onClick={() => onRemove(file.id)}
              className="invisible text-black bg-white rounded-full border border-white transition group-hover:visible"
              type="button"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center justify-center px-4 h-[62px] text-sm text-gray-300 bg-gray-800 rounded-2xl border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          +{hidden} more
        </button>
      )}
      {expanded && files.length > VISIBLE_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center justify-center px-4 h-[62px] text-sm text-gray-400 bg-gray-800 rounded-2xl border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
}
