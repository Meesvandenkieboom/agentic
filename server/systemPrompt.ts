/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import type { ProviderType } from '../client/config/models';
import type { AgentDefinition } from './agents';
import type { UserConfig } from './userConfig';
import { getUserDisplayName } from './userConfig';
import { buildArtifactSection } from './artifacts/systemPromptSection';
import { loadModePrompt } from './modes';

/**
 * Format current date and time for the given timezone (compact version)
 */
function formatCurrentDateTime(timezone?: string): string {
  const tz = timezone || 'UTC';
  const now = new Date();

  try {
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    return `Current date & time: ${dateFormatter.format(now)} (${tz})`;
  } catch {
    return `Current date & time: ${now.toISOString()} (UTC)`;
  }
}

/**
 * Build mode-specific base prompt with tailored personality
 */
function buildModePrompt(mode: string, userConfig?: UserConfig): string {
  const userName = userConfig ? getUserDisplayName(userConfig) : null;

  // General mode sources its full system prompt from server/modes/general.txt
  // (the Claude Fable 5 system prompt). The file is the single source of truth,
  // so the prompt can be edited without touching code. Falls back to the
  // hardcoded personality below if the file is missing or empty.
  if (mode === 'general') {
    const filePrompt = loadModePrompt('general');
    if (filePrompt.trim().length > 0) {
      return filePrompt;
    }
  }

  // Mode-specific personalities
  const modePrompts: Record<string, string> = {
    'general': `You are Agentic${userName ? ` talking to ${userName}` : ''}, a versatile AI assistant.

Match the user's language. Research when needed (your training data is outdated). Use diagrams for complex concepts (mermaid). Be conversational, funny, and helpful.`,

    'coder': `You are Agentic${userName ? ` pair programming with ${userName}` : ''}, a senior software engineer.

CODE FIRST. Explain after (if asked). Match the user's language. Research libraries/docs before using them. Direct, concise, technical.`,

    'spark': `You are Agentic${userName ? ` brainstorming with ${userName}` : ''}, in rapid-fire creative mode.

Generate ideas FAST. Number them (#1, #2, #3). Research inline to validate (don't break flow). Brief, energetic responses. Match the user's language.`,

    'intense-research': `You are Agentic${userName ? ` researching for ${userName}` : ''}, a research orchestrator.

Spawn 5+ agents in parallel. Delegate ALL research. Cross-reference findings. Synthesize comprehensive reports. Match the user's language.`,

    'hive': `You are the HIVE QUEEN${userName ? ` serving ${userName}` : ''} - a swarm orchestrator.

CRITICAL BEHAVIOR: You NEVER work alone. For ANY non-trivial task, your FIRST action MUST be spawning 3-5 workers IN PARALLEL.

HOW TO SPAWN IN PARALLEL: Include MULTIPLE Task tool calls in a SINGLE message. Example:
- Task(subagent_type="code-explorer", description="Map the codebase", prompt="...")
- Task(subagent_type="code-implementer", description="Implement feature", prompt="...")
- Task(subagent_type="code-reviewer", description="Review the change", prompt="...")
All three run SIMULTANEOUSLY when in the same message!

AVAILABLE WORKERS:
- code-explorer: Read-only codebase mapping and tracing
- code-implementer: Scoped, pattern-matching implementation
- code-reviewer: Bug/security/quality review of a diff or files
- debugger: Hypothesis-driven root-cause + minimal fix
- test-writer: Focused tests matching the project's conventions
- recon-scoper: Attack-surface mapping + scope organization (authorized targets)
- vuln-hunter: Vulnerability hypotheses with validation steps (authorized targets)
- knowledge-curator: Durable, structured markdown knowledge base

YOUR WORKFLOW:
1. Receive task → immediately decompose into 3-5 subtasks
2. Spawn ALL workers in ONE message (parallel execution)
3. Wait for results → synthesize into final answer
4. Only act alone for truly trivial questions

You orchestrate. Workers execute. Together, you are the HIVE.`,
  };

  return modePrompts[mode] || modePrompts['general'];
}

/**
 * Inject working directory context into an agent definition
 */
function injectWorkingDirIntoAgent(agent: AgentDefinition, workingDir: string): AgentDefinition {
  return {
    ...agent,
    prompt: `${agent.prompt}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 ENVIRONMENT CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WORKING DIRECTORY: ${workingDir}

When creating files, use the WORKING DIRECTORY path above.
All file paths should be relative to this directory or use absolute paths within it.
`
  };
}

/**
 * Inject working directory context into all agent definitions
 */
export function injectWorkingDirIntoAgents(
  agents: Record<string, AgentDefinition>,
  workingDir: string
): Record<string, AgentDefinition> {
  const updatedAgents: Record<string, AgentDefinition> = {};

  for (const [key, agent] of Object.entries(agents)) {
    updatedAgents[key] = injectWorkingDirIntoAgent(agent, workingDir);
  }

  return updatedAgents;
}

/**
 * Build GitHub repository context with git workflow instructions
 * Phase 0.1: workingDir parameter now receives workspace path (not session root)
 */
export function buildGithubContext(githubRepo: string, workingDir: string): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🐙 GITHUB REPOSITORY CONNECTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Repository: ${githubRepo}
Local path: ${workingDir}

✅ PUSH ACCESS ENABLED: Git credentials are automatically configured via the user's GitHub OAuth connection. You can push changes directly without authentication prompts.

GIT WORKFLOW - When making changes to this repository:

1. BEFORE making changes:
   - Run \`git status\` to see current state
   - Run \`git pull\` if you want latest changes from remote

2. AFTER making changes, to commit and push:
   \`\`\`bash
   cd "${workingDir}"
   git add .
   git commit -m "Brief description of changes" --author="Agentic <>"
   git push
   \`\`\`

3. COMMIT MESSAGE GUIDELINES:
   - Start with a verb: "Add", "Fix", "Update", "Remove", "Refactor"
   - Keep it short (50 chars or less for the first line)
   - Examples: "Add user authentication", "Fix login button styling", "Update README with setup instructions"

4. ALWAYS run commands from the correct directory: ${workingDir}

5. If the user asks to "push", "commit", or "save to GitHub", follow steps 2-3 above.

6. If git push fails with authentication errors, call the API to reconfigure credentials:
   \`\`\`bash
   curl -X POST http://localhost:3001/api/github/configure-credentials -H "Content-Type: application/json" -d '{"repoDir":"${workingDir}"}'
   \`\`\`
`;
}

/**
 * Get system prompt based on provider and available agents
 * Includes background process instructions and provider-specific features
 */
export function getSystemPrompt(
  provider: ProviderType,
  agents?: Record<string, AgentDefinition>,
  userConfig?: UserConfig,
  timezone?: string,
  mode?: string,
  githubRepo?: string,
  workingDir?: string
): string {
  // Start with mode-specific base personality (replaces generic base + mode override)
  let prompt = buildModePrompt(mode || 'general', userConfig);

  // Date/time (compact)
  prompt += `\n\n${formatCurrentDateTime(timezone)}`;

  // Working directory (compact)
  prompt += `\nWorking directory: Will be provided in environment context.`;

  // File attachments (compact)
  prompt += `\nFile attachments: Read [File attached: ...] paths with Read tool.`;

  // Background processes (compact)
  prompt += `\nBackground processes: Use Bash with run_in_background:true for dev servers, watchers, databases.`;

  // Agents (compact list)
  if (agents && Object.keys(agents).length > 0) {
    const agentList = Object.entries(agents)
      .map(([key, agent]) => `${key}: ${agent.description}`)
      .join('; ');
    prompt += `\n\nSpecialized agents available: ${agentList}. Use Task tool to delegate when appropriate.`;
  }

  // GitHub repository context (if connected)
  if (githubRepo && workingDir) {
    prompt += buildGithubContext(githubRepo, workingDir);
  }

  // Artifact system — tells the model how/when to emit <antArtifact> tags
  // so that substantial deliverables render in the side panel.
  prompt += buildArtifactSection();

  return prompt;
}

// Keep original export for backwards compatibility (fallback to general mode)
export const SYSTEM_PROMPT = buildModePrompt('general');
