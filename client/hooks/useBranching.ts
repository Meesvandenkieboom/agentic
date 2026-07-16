/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useState, useCallback } from 'react';
import { toast } from '../utils/toast';

export interface BranchInfo {
  sessionId: string;
  title: string;
  created_at: string;
  message_count: number;
  branch_point_message_id: string;
  model?: string;
}

export interface Session {
  id: string;
  title: string;
  parent_session_id?: string;
  branch_point_message_id?: string;
  model?: string;
  workspace_status?: 'ready' | 'preparing' | 'failed';
  // ... other session fields
}

interface BranchTree {
  parent: Session | null;
  current: Session | null;
  siblings: BranchInfo[];
  children: BranchInfo[];
}

interface BranchConfig {
  messageId?: string;
  model?: string;
  title?: string;
}

export function useBranching() {
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);

  /**
   * Create a branch from a specific message in a session
   */
  const createBranch = useCallback(async (
    sessionId: string,
    config: BranchConfig
  ): Promise<Session | null> => {
    setIsCreatingBranch(true);

    try {
      const response = await fetch(`/api/sessions/${sessionId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      const data = await response.json();

      if (data.success && data.session) {
        toast.success('Branch created', {
          description: `Created "${data.session.title}"`,
        });
        return data.session;
      } else {
        toast.error('Failed to create branch', {
          description: data.error || 'Unknown error',
        });
        return null;
      }
    } catch (error) {
      console.error('Branch creation error:', error);
      toast.error('Failed to create branch', {
        description: error instanceof Error ? error.message : 'Network error',
      });
      return null;
    } finally {
      setIsCreatingBranch(false);
    }
  }, []);

  /**
   * Get all child branches of a session
   */
  const getBranches = useCallback(async (sessionId: string): Promise<BranchInfo[]> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/branches`);
      const data = await response.json();
      return data.branches || [];
    } catch (error) {
      console.error('Failed to fetch branches:', error);
      return [];
    }
  }, []);

  /**
   * Get the branch tree for a session
   */
  const getBranchTree = useCallback(async (sessionId: string): Promise<BranchTree> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/tree`);
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to fetch branch tree:', error);
      return { parent: null, current: null, siblings: [], children: [] };
    }
  }, []);

  /**
   * Get parent session of a branched session
   */
  const getParentSession = useCallback(async (sessionId: string): Promise<Session | null> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/parent`);
      const data = await response.json();
      return data.parent || null;
    } catch (error) {
      console.error('Failed to fetch parent session:', error);
      return null;
    }
  }, []);

  /**
   * Update model for a session
   */
  const updateSessionModel = useCallback(async (
    sessionId: string,
    model: string
  ): Promise<boolean> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('Model updated', {
          description: `Switched to ${model}`,
        });
        return true;
      } else {
        toast.error('Failed to update model', {
          description: data.error || 'Unknown error',
        });
        return false;
      }
    } catch (error) {
      console.error('Model update error:', error);
      toast.error('Failed to update model');
      return false;
    }
  }, []);

  return {
    createBranch,
    getBranches,
    getBranchTree,
    getParentSession,
    updateSessionModel,
    isCreatingBranch,
  };
}
