/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Capture calls made to sonner's toast.error without rendering anything.
interface ToastCall {
  message: string;
  options?: { description?: string };
}
const errorCalls: ToastCall[] = [];

mock.module('sonner', () => ({
  toast: {
    error: (message: string, options?: { description?: string }) => {
      errorCalls.push({ message, options });
      return 'toast-id';
    },
    success: () => 'toast-id',
    info: () => 'toast-id',
    warning: () => 'toast-id',
  },
}));

// Import after the mock is registered so toast.ts picks up the stub.
const { ErrorMessages, showError, showGenericError } = await import('./errorMessages');

describe('ErrorMessages catalogue', () => {
  it('uses unique error codes', () => {
    const codes = Object.values(ErrorMessages).map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every entry a title, description and code', () => {
    for (const entry of Object.values(ErrorMessages)) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.code).toMatch(/^E\d{3}$/);
    }
  });
});

describe('showError', () => {
  let consoleErrorSpy: ReturnType<typeof mock>;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    errorCalls.length = 0;
    originalConsoleError = console.error;
    consoleErrorSpy = mock(() => {});
    console.error = consoleErrorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('shows a toast using the catalogue title and description', () => {
    showError('LOAD_CHATS');
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toBe(ErrorMessages.LOAD_CHATS.title);
    expect(errorCalls[0].options?.description).toBe(ErrorMessages.LOAD_CHATS.description);
  });

  it('logs the code with technical details when provided', () => {
    showError('CREATE_CHAT', 'stack trace here');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [firstArg, secondArg] = consoleErrorSpy.mock.calls[0];
    expect(String(firstArg)).toContain('E003');
    expect(secondArg).toBe('stack trace here');
  });

  it('logs the code without details when omitted', () => {
    showError('DELETE_CHAT');
    const [firstArg] = consoleErrorSpy.mock.calls[0];
    expect(String(firstArg)).toContain('E004');
  });
});

describe('showGenericError', () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    errorCalls.length = 0;
    originalConsoleError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('shows a toast with the custom title and description', () => {
    showGenericError('Boom', 'something broke');
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toBe('Boom');
    expect(errorCalls[0].options?.description).toBe('something broke');
  });

  it('does not throw when description and code are omitted', () => {
    expect(() => showGenericError('Just a title')).not.toThrow();
    expect(errorCalls[0].message).toBe('Just a title');
  });
});
