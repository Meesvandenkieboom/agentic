/**
 * Agent Smith - Modern chat interface for Claude Agent SDK
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

import React from 'react';
import { Github } from 'lucide-react';

interface GitHubRepoIndicatorProps {
  repoName: string;
}

export function GitHubRepoIndicator({ repoName }: GitHubRepoIndicatorProps) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border"
      style={{
        background: 'linear-gradient(135deg, rgba(218, 238, 255, 0.1) 0%, rgba(218, 238, 255, 0.05) 100%)',
        borderColor: 'rgba(218, 238, 255, 0.15)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 0 0 1px rgba(218, 238, 255, 0.1), 0 2px 8px rgba(218, 238, 255, 0.08)',
      }}
    >
      <Github size={14} className="text-blue-400" />
      <span className="text-xs font-medium text-gray-300" title={`GitHub repository: ${repoName}`}>
        {repoName}
      </span>
    </div>
  );
}
