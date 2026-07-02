/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect } from 'bun:test';
import { resolveBranchPointId } from './branchPoint';

const db = [
  { id: 'db-1', type: 'user' },
  { id: 'db-2', type: 'assistant' },
  { id: 'db-3', type: 'assistant' }, // one turn can span multiple DB rows
  { id: 'db-4', type: 'user' },
  { id: 'db-5', type: 'assistant' },
];

describe('resolveBranchPointId', () => {
  it('returns the ID directly when it exists in the DB (older chats)', () => {
    const client = db.map(m => ({ ...m, content: 'x' }));
    expect(resolveBranchPointId(client, db, 'db-3')).toBe('db-3');
  });

  it('resolves a live user message by ordinal', () => {
    const client = [
      { id: 'db-1', type: 'user', content: 'hi' },
      { id: 'db-2', type: 'assistant', content: [] },
      { id: 'db-3', type: 'assistant', content: [] },
      { id: 'msg-100-1', type: 'user', content: 'second question' },
      { id: 'msg-100-2', type: 'assistant', content: [] },
    ];
    expect(resolveBranchPointId(client, db, 'msg-100-1')).toBe('db-4');
  });

  it('resolves a live assistant message via the next user message anchor', () => {
    const client = [
      { id: 'msg-1', type: 'user', content: 'hi' },
      { id: 'msg-2', type: 'assistant', content: [] }, // aggregated turn = db-2 + db-3
      { id: 'msg-3', type: 'user', content: 'second' },
      { id: 'msg-4', type: 'assistant', content: [] },
    ];
    expect(resolveBranchPointId(client, db, 'msg-2')).toBe('db-3');
  });

  it('resolves the last live assistant message to the last DB row', () => {
    const client = [
      { id: 'msg-1', type: 'user', content: 'hi' },
      { id: 'msg-2', type: 'assistant', content: [] },
      { id: 'msg-3', type: 'user', content: 'second' },
      { id: 'msg-4', type: 'assistant', content: [] },
    ];
    expect(resolveBranchPointId(client, db, 'msg-4')).toBe('db-5');
  });

  it('returns null for unknown messages', () => {
    expect(resolveBranchPointId([], db, 'nope')).toBeNull();
  });

  it('returns null when DB is missing the ordinal user message', () => {
    const client = [
      { id: 'msg-1', type: 'user', content: 'a' },
      { id: 'msg-2', type: 'user', content: 'b' },
      { id: 'msg-3', type: 'user', content: 'c' },
    ];
    const shortDb = [{ id: 'db-1', type: 'user' }];
    expect(resolveBranchPointId(client, shortDb, 'msg-3')).toBeNull();
  });
});
