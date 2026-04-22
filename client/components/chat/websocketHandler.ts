/**
 * WebSocket message handler - extracted from ChatContainer
 * Pure function that processes incoming WebSocket messages and routes them
 * to the appropriate state updaters (current session or background cache).
 */

import { flushSync } from 'react-dom';
import type { Message, ArtifactBlock, ArtifactBlockType } from '../message/types';
import type { BackgroundProcess } from '../process/BackgroundProcessMonitor';
import { generateMessageId } from '../../hooks/useChatMessages';
import { toast } from '../../utils/toast';
import { showError } from '../../utils/errorMessages';
import { areNotificationsEnabled, showClaudeResponseNotification } from '../../utils/notifications';
import type { ContextUsageData } from '../../hooks/useChatSessions';
import type { Session } from '../../hooks/useSessionAPI';
import type { PendingQuestionData } from '../question/QuestionInput';
import { useArtifactPanel } from '../../hooks/useArtifactPanel';
import { isArtifactType } from '../artifact/types';

export interface WebSocketHandlerDeps {
  currentSessionIdRef: React.RefObject<string | null>;
  createMessageUpdater: (activeSessionId: string | null) => {
    updateMsgs: (msgSessionId: string | null, isBackground: boolean, updater: (prev: Message[]) => Message[]) => void;
    updateMsgsSync: (msgSessionId: string | null, isBackground: boolean, updater: (prev: Message[]) => Message[]) => void;
  };
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setSessionLoading: (sessionId: string, loading: boolean) => void;
  setLiveTokenCount: React.Dispatch<React.SetStateAction<number>>;
  setContextUsage: React.Dispatch<React.SetStateAction<Map<string, ContextUsageData>>>;
  setIsPlanMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingPlan: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingQuestion: React.Dispatch<React.SetStateAction<PendingQuestionData | null>>;
  setBackgroundProcesses: React.Dispatch<React.SetStateAction<Map<string, BackgroundProcess[]>>>;
  clearCache: (sessionId: string) => void;
  lastAssistantContentRef: React.MutableRefObject<string>;
  activeLongRunningCommandRef: React.MutableRefObject<string | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleWebSocketMessage(message: Record<string, any>, deps: WebSocketHandlerDeps): void {
  const {
    currentSessionIdRef,
    createMessageUpdater,
    setMessages,
    setSessions,
    setSessionLoading,
    setLiveTokenCount,
    setContextUsage,
    setIsPlanMode,
    setPendingPlan,
    setPendingQuestion,
    setBackgroundProcesses,
    clearCache,
    lastAssistantContentRef,
    activeLongRunningCommandRef,
  } = deps;

  const activeSessionId = currentSessionIdRef.current;
  const msgSessionId = (message.sessionId as string | undefined) || activeSessionId;
  const isBackgroundSession = msgSessionId !== activeSessionId;

  const { updateMsgs, updateMsgsSync } = createMessageUpdater(activeSessionId);

  // Helper to route updates correctly
  const applyUpdate = (updater: (prev: Message[]) => Message[]) => {
    updateMsgs(msgSessionId, isBackgroundSession, updater);
  };

  const applyUpdateSync = (updater: (prev: Message[]) => Message[]) => {
    updateMsgsSync(msgSessionId, isBackgroundSession, updater);
  };

  // --- Background session filtering ---
  if (isBackgroundSession) {
    if (message.type === 'context_usage') {
      handleContextUsage(message, msgSessionId, activeSessionId, setContextUsage, setLiveTokenCount);
      return;
    }
    if (message.type === 'result' && msgSessionId) {
      setSessionLoading(msgSessionId, false);
      clearCache(msgSessionId);
      return;
    }
    if (message.type === 'error' && msgSessionId) {
      setSessionLoading(msgSessionId, false);
    }
    const bgContentTypes = ['assistant_message', 'thinking_start', 'thinking_delta', 'tool_use', 'error'];
    if (!bgContentTypes.includes(message.type as string)) return;
  }

  // --- Message type handlers ---
  switch (message.type) {
    case 'assistant_message':
      handleAssistantMessage(message, isBackgroundSession, lastAssistantContentRef, applyUpdate);
      break;

    case 'thinking_start':
      handleThinkingStart(applyUpdate);
      break;

    case 'thinking_delta':
      handleThinkingDelta(message, applyUpdate);
      break;

    case 'tool_use':
      handleToolUse(message, applyUpdateSync);
      break;

    case 'token_update':
      if ('outputTokens' in message) {
        setLiveTokenCount((message as { outputTokens: number }).outputTokens);
      }
      break;

    case 'result':
      handleResult(msgSessionId, activeSessionId, isBackgroundSession, setSessionLoading, clearCache, lastAssistantContentRef);
      break;

    case 'timeout_warning':
      handleTimeoutWarning(message);
      break;

    case 'retry_attempt':
      handleRetryAttempt(message);
      break;

    case 'error':
      handleError(message, msgSessionId, activeSessionId, isBackgroundSession, setSessionLoading, applyUpdate);
      break;

    case 'exit_plan_mode':
      setPendingPlan(('plan' in message ? message.plan : 'No plan provided') as string);
      break;

    case 'permission_mode_changed':
      setIsPlanMode(('mode' in message ? message.mode : undefined) === 'plan');
      break;

    case 'background_process_started':
      handleBgProcessStarted(message, activeSessionId, setBackgroundProcesses);
      break;

    case 'background_process_killed':
    case 'background_process_exited':
      handleBgProcessRemoved(message, activeSessionId, setBackgroundProcesses);
      break;

    case 'long_running_command_started':
      handleLongRunningStart(message, activeLongRunningCommandRef, applyUpdate);
      break;

    case 'command_output_chunk':
      handleCommandOutputChunk(message, applyUpdate);
      break;

    case 'long_running_command_completed':
      handleLongRunningCompleted(message, isBackgroundSession, activeLongRunningCommandRef, applyUpdate);
      break;

    case 'long_running_command_failed':
      handleLongRunningFailed(message, isBackgroundSession, activeLongRunningCommandRef, applyUpdate);
      break;

    case 'compact_start':
      handleCompactStart(message);
      break;

    case 'compact_loading':
      if ((message.sessionId || activeSessionId) === activeSessionId) {
        setMessages(prev => [...prev, {
          id: 'compact-loading', type: 'assistant',
          content: [{ type: 'text', text: 'Compacting conversation...' }],
          timestamp: new Date().toISOString(),
        } as Message]);
      }
      break;

    case 'compact_complete':
      handleCompactComplete(message, activeSessionId, setMessages);
      break;

    case 'context_usage':
      handleContextUsage(message, msgSessionId, activeSessionId, setContextUsage, setLiveTokenCount);
      break;

    case 'reconnect_ack':
      handleReconnectAck(message, setSessionLoading);
      break;

    case 'generation_stopped':
      if (message.sessionId) {
        setSessionLoading(message.sessionId as string, false);
        clearCache(message.sessionId as string);
      }
      break;

    case 'session_title_updated':
      handleSessionTitleUpdated(message, setSessions);
      break;

    case 'ask_user_question':
      if ('toolId' in message && 'questions' in message) {
        setPendingQuestion({
          toolId: message.toolId as string,
          questions: message.questions as PendingQuestionData['questions'],
        });
      }
      break;

    case 'artifact_start':
      handleArtifactStart(message, msgSessionId, applyUpdate);
      break;

    case 'artifact_delta':
      handleArtifactDelta(message, applyUpdate);
      break;

    case 'artifact_end':
      handleArtifactEnd(message, applyUpdate);
      break;

    case 'keepalive':
    case 'user_message':
    case 'slash_commands_available':
      // No-op
      break;
  }
}

// --- Individual handlers (pure functions) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleAssistantMessage(message: Record<string, any>, isBackground: boolean, lastRef: React.MutableRefObject<string>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const content = message.content as string;
  if (!isBackground) lastRef.current += content;

  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (!isBackground && (!last || last.type !== 'assistant')) {
      lastRef.current = content;
    }
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'text') {
        return [...prev.slice(0, -1), { ...last, content: [...blocks.slice(0, -1), { type: 'text' as const, text: lastBlock.text + content }] }];
      }
      return [...prev.slice(0, -1), { ...last, content: [...blocks, { type: 'text' as const, text: content }] }];
    }
    return [...prev, { id: generateMessageId(), type: 'assistant' as const, content: [{ type: 'text' as const, text: content }], timestamp: new Date().toISOString() }];
  });
}

function handleThinkingStart(applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      return [...prev.slice(0, -1), { ...last, content: [...blocks, { type: 'thinking' as const, thinking: '' }] }];
    }
    return [...prev, { id: generateMessageId(), type: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: '' }], timestamp: new Date().toISOString() }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleThinkingDelta(message: Record<string, any>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const content = message.content as string;
  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'thinking') {
        return [...prev.slice(0, -1), { ...last, content: [...blocks.slice(0, -1), { type: 'thinking' as const, thinking: lastBlock.thinking + content }] }];
      }
    }
    return prev;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleToolUse(message: Record<string, any>, applyUpdateSync: (u: (p: Message[]) => Message[]) => void) {
  if (!('toolId' in message && 'toolName' in message && 'toolInput' in message)) return;

  const toolId = message.toolId as string;
  const toolName = message.toolName as string;
  const toolInput = message.toolInput as Record<string, unknown>;

  applyUpdateSync(prev => {
    const last = prev[prev.length - 1];
    const toolBlock = {
      type: 'tool_use' as const, id: toolId, name: toolName, input: toolInput,
      ...(toolName === 'Task' ? { nestedTools: [] } : {}),
    };

    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      if (blocks.some(b => b.type === 'tool_use' && b.id === toolId)) return prev;

      const activeTaskIndices: number[] = [];
      let foundText = false;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.type === 'text') foundText = true;
        if (b.type === 'tool_use' && b.name === 'Task') {
          if (!foundText) activeTaskIndices.unshift(i);
          else break;
        }
      }

      if (toolName === 'Task' || activeTaskIndices.length === 0) {
        return [...prev.slice(0, -1), { ...last, content: [...blocks, toolBlock] }];
      }

      const totalNested = activeTaskIndices.reduce((sum, idx) => {
        const b = blocks[idx];
        return sum + (b.type === 'tool_use' ? (b.nestedTools?.length || 0) : 0);
      }, 0);
      const targetIdx = activeTaskIndices[totalNested % activeTaskIndices.length];

      const updated = blocks.map((b, i) => {
        if (i === targetIdx && b.type === 'tool_use') {
          if ((b.nestedTools || []).some(n => n.id === toolId)) return b;
          return { ...b, nestedTools: [...(b.nestedTools || []), toolBlock] };
        }
        return b;
      });
      return [...prev.slice(0, -1), { ...last, content: updated }];
    }

    return [...prev, { id: generateMessageId(), type: 'assistant' as const, content: [toolBlock], timestamp: new Date().toISOString() }];
  });
}

function handleResult(
  msgSessionId: string | null, activeSessionId: string | null, isBackground: boolean,
  setSessionLoading: (id: string, l: boolean) => void,
  clearCache: (id: string) => void,
  lastRef: React.MutableRefObject<string>,
) {
  const sid = msgSessionId || activeSessionId;
  if (sid) {
    setSessionLoading(sid, false);
    clearCache(sid);
  }
  if (!isBackground && lastRef.current && areNotificationsEnabled()) {
    showClaudeResponseNotification({ message: lastRef.current, title: 'Agentic' });
  }
  lastRef.current = '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleTimeoutWarning(message: Record<string, any>) {
  const msg = message as { message?: string };
  toast.warning('Still thinking...', { description: msg.message || 'The AI is taking longer than usual', duration: 5000 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleRetryAttempt(message: Record<string, any>) {
  const m = message as { attempt: number; maxAttempts: number; message?: string; errorType?: string };
  toast.info(`Retrying (${m.attempt}/${m.maxAttempts})`, { description: m.message || `Attempting to recover from ${m.errorType}...`, duration: 3000 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(message: Record<string, any>, msgSid: string | null, activeSid: string | null, isBg: boolean, setLoading: (id: string, l: boolean) => void, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const sid = msgSid || activeSid;
  if (sid) setLoading(sid, false);

  const errorType = message.errorType as string | undefined;
  const errorMsg = (message.message || message.error || 'An error occurred') as string;

  const codeMap: Record<string, string> = {
    'timeout_error': 'API_TIMEOUT', 'rate_limit_error': 'API_RATE_LIMIT',
    'overloaded_error': 'API_OVERLOADED', 'authentication_error': 'API_AUTHENTICATION',
    'permission_error': 'API_PERMISSION', 'invalid_request_error': 'API_INVALID_REQUEST',
    'request_too_large': 'API_REQUEST_TOO_LARGE', 'network_error': 'API_NETWORK',
  };

  if (!isBg) {
    if (errorType && codeMap[errorType]) {
      showError(codeMap[errorType] as keyof typeof import('../../utils/errorMessages').ErrorMessages, errorMsg);
    } else {
      toast.error('Error', { description: errorMsg });
    }
  }

  const icon = errorType === 'timeout_error' ? '⏱️' : errorType === 'rate_limit_error' ? '🚦' :
    errorType === 'authentication_error' ? '🔑' : errorType === 'network_error' ? '🌐' : '❌';

  applyUpdate(prev => [...prev, {
    id: generateMessageId(), type: 'assistant' as const,
    content: [{ type: 'text' as const, text: `${icon} Error: ${errorMsg}` }],
    timestamp: new Date().toISOString(),
  }]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleBgProcessStarted(message: Record<string, any>, activeSid: string | null, setBgProcesses: React.Dispatch<React.SetStateAction<Map<string, BackgroundProcess[]>>>) {
  if (!('bashId' in message && 'command' in message && 'description' in message)) return;
  const sid = (message.sessionId || activeSid) as string;
  if (!sid) return;
  setBgProcesses(prev => {
    const m = new Map(prev);
    m.set(sid, [...(m.get(sid) || []), { bashId: message.bashId as string, command: message.command as string, description: message.description as string, startedAt: Date.now() }]);
    return m;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleBgProcessRemoved(message: Record<string, any>, activeSid: string | null, setBgProcesses: React.Dispatch<React.SetStateAction<Map<string, BackgroundProcess[]>>>) {
  if (!('bashId' in message)) return;
  const sid = (message.sessionId || activeSid) as string;
  if (!sid) return;
  setBgProcesses(prev => {
    const m = new Map(prev);
    m.set(sid, (m.get(sid) || []).filter(p => p.bashId !== message.bashId));
    return m;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleLongRunningStart(message: Record<string, any>, activeRef: React.MutableRefObject<string | null>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  if (!('bashId' in message && 'command' in message && 'commandType' in message)) return;
  activeRef.current = message.bashId as string;
  applyUpdate(prev => [...prev, {
    id: generateMessageId(), type: 'assistant' as const, timestamp: new Date().toISOString(),
    content: [{
      type: 'long_running_command' as const,
      bashId: message.bashId as string, command: message.command as string,
      commandType: message.commandType as 'install' | 'build' | 'test',
      output: '', status: 'running' as const, startedAt: message.startedAt as number,
    }],
  }]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleCommandOutputChunk(message: Record<string, any>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  if (!('bashId' in message && 'output' in message)) return;
  const bashId = message.bashId as string;
  const output = message.output as string;
  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last?.type === 'assistant' && last.content.length > 0) {
      const lb = last.content[last.content.length - 1];
      if (lb.type === 'long_running_command' && lb.bashId === bashId) {
        return [...prev.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...lb, output: lb.output + output }] }];
      }
    }
    return prev;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleLongRunningCompleted(message: Record<string, any>, isBg: boolean, activeRef: React.MutableRefObject<string | null>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  if (!('bashId' in message)) return;
  const bashId = message.bashId as string;
  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last?.type === 'assistant' && last.content.length > 0) {
      const lb = last.content[last.content.length - 1];
      if (lb.type === 'long_running_command' && lb.bashId === bashId) {
        if (!isBg) toast.success('Command completed', { description: 'Installation finished successfully', duration: 3000 });
        activeRef.current = null;
        return [...prev.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...lb, status: 'completed' as const }] }];
      }
    }
    return prev;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleLongRunningFailed(message: Record<string, any>, isBg: boolean, activeRef: React.MutableRefObject<string | null>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  if (!('bashId' in message && 'error' in message)) return;
  const bashId = message.bashId as string;
  const error = message.error as string;
  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last?.type === 'assistant' && last.content.length > 0) {
      const lb = last.content[last.content.length - 1];
      if (lb.type === 'long_running_command' && lb.bashId === bashId) {
        if (!isBg) toast.error('Command failed', { description: error, duration: 5000 });
        activeRef.current = null;
        return [...prev.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...lb, status: 'failed' as const, output: lb.output + '\n\nError: ' + error }] }];
      }
    }
    return prev;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleCompactStart(message: Record<string, any>) {
  if (!('trigger' in message && 'preTokens' in message)) return;
  if ((message as { trigger: string }).trigger === 'auto') {
    toast.info('Auto-compacting conversation...', {
      description: `Context reached limit (${(message.preTokens as number).toLocaleString()} tokens). Summarizing history...`,
      duration: 10000,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleCompactComplete(message: Record<string, any>, activeSid: string | null, setMessages: React.Dispatch<React.SetStateAction<Message[]>>) {
  if (!('preTokens' in message)) return;
  const target = (message.sessionId || activeSid) as string;
  if (target !== activeSid) return;
  const tokens = (message.preTokens as number).toLocaleString();
  setMessages(prev => prev.filter(m => m.id !== 'compact-loading'));
  setMessages(prev => [...prev, {
    id: generateMessageId(), type: 'assistant' as const,
    content: [{ type: 'text' as const, text: `--- History compacted. Previous messages were summarized to reduce token usage (${tokens} tokens before compact) ---` }],
    timestamp: new Date().toISOString(),
  }]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleContextUsage(message: Record<string, any>, msgSid: string | null, activeSid: string | null, setCtx: React.Dispatch<React.SetStateAction<Map<string, ContextUsageData>>>, setTokens: React.Dispatch<React.SetStateAction<number>>) {
  const m = message as { inputTokens: number; outputTokens: number; contextWindow: number; contextPercentage: number; sessionId?: string };
  const target = m.sessionId || msgSid || activeSid;
  if (!target) return;
  setCtx(prev => {
    const nm = new Map(prev);
    nm.set(target, { inputTokens: m.inputTokens, contextWindow: m.contextWindow, contextPercentage: m.contextPercentage, outputTokens: m.outputTokens || prev.get(target)?.outputTokens || 0 });
    return nm;
  });
  if (m.outputTokens && target === activeSid) setTokens(m.outputTokens);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleReconnectAck(message: Record<string, any>, setLoading: (id: string, l: boolean) => void) {
  const ack = message as { sessionId?: string; isGenerating?: boolean };
  if (ack.sessionId) {
    // Set loading to true if generating, clear it if idle
    setLoading(ack.sessionId, ack.isGenerating === true);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleSessionTitleUpdated(message: Record<string, any>, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) {
  const { sessionId, title } = message as { sessionId?: string; title?: string };
  if (!sessionId || !title) return;
  setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
}

// --- Artifact handlers ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleArtifactStart(message: Record<string, any>, msgSessionId: string | null, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const artifact = message.artifact as
    | { id: string; artifactType: string; title?: string; language?: string }
    | undefined;
  if (!artifact || !artifact.id || !isArtifactType(artifact.artifactType)) return;

  const artifactType = artifact.artifactType as ArtifactBlockType;

  // Update store first so the panel opens immediately.
  useArtifactPanel.getState().upsertMeta(
    { id: artifact.id, artifactType, title: artifact.title, language: artifact.language },
    msgSessionId,
  );

  const newBlock: ArtifactBlock = {
    type: 'artifact',
    artifactId: artifact.id,
    artifactType,
    title: artifact.title,
    language: artifact.language,
    content: '',
    status: 'streaming',
  };

  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      if (blocks.some(b => b.type === 'artifact' && b.artifactId === artifact.id)) return prev;
      return [...prev.slice(0, -1), { ...last, content: [...blocks, newBlock] }];
    }
    return [...prev, {
      id: generateMessageId(), type: 'assistant' as const,
      content: [newBlock], timestamp: new Date().toISOString(),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleArtifactDelta(message: Record<string, any>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const artifactId = message.artifactId as string | undefined;
  const content = message.content as string | undefined;
  if (!artifactId || typeof content !== 'string') return;

  useArtifactPanel.getState().appendDelta(artifactId, content);

  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      // Find matching artifact block and append content
      let changed = false;
      const updated = blocks.map(b => {
        if (b.type === 'artifact' && b.artifactId === artifactId) {
          changed = true;
          return { ...b, content: b.content + content };
        }
        return b;
      });
      if (!changed) return prev;
      return [...prev.slice(0, -1), { ...last, content: updated }];
    }
    return prev;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleArtifactEnd(message: Record<string, any>, applyUpdate: (u: (p: Message[]) => Message[]) => void) {
  const artifactId = message.artifactId as string | undefined;
  if (!artifactId) return;

  useArtifactPanel.getState().finalize(artifactId);

  applyUpdate(prev => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      let changed = false;
      const updated = blocks.map(b => {
        if (b.type === 'artifact' && b.artifactId === artifactId) {
          changed = true;
          return { ...b, status: 'complete' as const };
        }
        return b;
      });
      if (!changed) return prev;
      return [...prev.slice(0, -1), { ...last, content: updated }];
    }
    return prev;
  });
}
