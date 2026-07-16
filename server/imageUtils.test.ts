/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectImageFormat,
  extractBase64Data,
  ensurePicturesDirectory,
  saveImageToSessionPictures,
  saveFileToSessionFiles,
} from './imageUtils';

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-img-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectImageFormat', () => {
  it('detects png from a data URL', () => {
    expect(detectImageFormat(`data:image/png;base64,${PNG_BASE64}`)).toBe('png');
  });

  it('detects jpeg from a data URL', () => {
    expect(detectImageFormat('data:image/jpeg;base64,/9j/abc')).toBe('jpeg');
  });

  it('detects webp from a data URL', () => {
    expect(detectImageFormat('data:image/webp;base64,UklGR')).toBe('webp');
  });

  it('falls back to png for raw base64 without a prefix', () => {
    expect(detectImageFormat(PNG_BASE64)).toBe('png');
  });

  it('falls back to png for a malformed data URL', () => {
    expect(detectImageFormat('data:application/octet-stream;base64,xxx')).toBe('png');
  });
});

describe('extractBase64Data', () => {
  it('strips the data URL prefix', () => {
    expect(extractBase64Data(`data:image/png;base64,${PNG_BASE64}`)).toBe(PNG_BASE64);
  });

  it('returns raw base64 unchanged', () => {
    expect(extractBase64Data(PNG_BASE64)).toBe(PNG_BASE64);
  });
});

describe('ensurePicturesDirectory', () => {
  it('creates the pictures directory if missing', () => {
    const dir = ensurePicturesDirectory(tmpDir);
    expect(dir).toBe(path.join(tmpDir, 'pictures'));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('is idempotent when called twice', () => {
    const first = ensurePicturesDirectory(tmpDir);
    const second = ensurePicturesDirectory(tmpDir);
    expect(first).toBe(second);
    expect(fs.existsSync(second)).toBe(true);
  });
});

describe('saveImageToSessionPictures', () => {
  it('writes the image and returns a relative ./pictures path', () => {
    const rel = saveImageToSessionPictures(
      `data:image/png;base64,${PNG_BASE64}`,
      'session-1',
      tmpDir
    );
    expect(rel.startsWith('./pictures/image-')).toBe(true);
    expect(rel.endsWith('.png')).toBe(true);

    const abs = path.join(tmpDir, rel.replace('./', ''));
    expect(fs.existsSync(abs)).toBe(true);
    // The file content should be the decoded base64 bytes.
    expect(fs.readFileSync(abs).length).toBe(Buffer.from(PNG_BASE64, 'base64').length);
  });
});

describe('saveFileToSessionFiles', () => {
  it('writes the file under ./files using its original name', () => {
    const rel = saveFileToSessionFiles(
      'data:text/plain;base64,aGVsbG8=', // "hello"
      'note.txt',
      'session-1',
      tmpDir
    );
    expect(rel).toBe('./files/note.txt');

    const abs = path.join(tmpDir, 'files', 'note.txt');
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('hello');
  });

  it('handles raw base64 without a data URL prefix', () => {
    saveFileToSessionFiles('aGk=', 'raw.txt', 'session-1', tmpDir); // "hi"
    expect(fs.readFileSync(path.join(tmpDir, 'files', 'raw.txt'), 'utf-8')).toBe('hi');
  });
});
