/**
 * Agent Girl - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState, useEffect } from 'react';
import { X, Github, Search, Loader2, Lock, Globe, Plus, ExternalLink } from 'lucide-react';
import { toast } from '../../utils/toast';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface GitHubRepoSelectorProps {
  sessionId?: string | null;
  onSelect: (repoUrl: string, repoName: string) => void;
  onClose: () => void;
}

export function GitHubRepoSelector({ sessionId, onSelect, onClose }: GitHubRepoSelectorProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCloning, setIsCloning] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Check GitHub connection and fetch repos on mount
  useEffect(() => {
    checkGitHubStatus();
  }, []);

  const checkGitHubStatus = async () => {
    try {
      const response = await fetch('/api/github/status');
      const data = await response.json();

      if (data.connected) {
        setIsConnected(true);
        fetchRepos();
      } else {
        setIsConnected(false);
        setIsLoading(false);
      }
    } catch (error) {
      console.error('Failed to check GitHub status:', error);
      setIsLoading(false);
    }
  };

  const fetchRepos = async () => {
    try {
      const response = await fetch('/api/github/repos?per_page=100&sort=updated');
      const data = await response.json();

      if (data.success) {
        setRepos(data.repos);
      } else {
        toast.error('Failed to fetch repositories');
      }
    } catch (error) {
      console.error('Failed to fetch repos:', error);
      toast.error('Failed to fetch repositories');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/github/auth');
      const data = await response.json();

      if (data.success && data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast.error('GitHub OAuth not configured');
        setIsLoading(false);
      }
    } catch (error) {
      console.error('Failed to start GitHub connection:', error);
      toast.error('Failed to connect to GitHub');
      setIsLoading(false);
    }
  };

  const handleSelectRepo = async (repo: GitHubRepo) => {
    if (!sessionId) {
      // No session yet - just pass the repo info
      onSelect(repo.clone_url, repo.full_name);
      return;
    }

    // Clone to session directory
    setSelectedRepo(repo);
    setIsCloning(true);

    try {
      const response = await fetch('/api/github/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: repo.clone_url,
          sessionId
        })
      });

      const data = await response.json();

      if (data.success) {
        toast.success(`Cloned ${repo.name}`, {
          description: `Repository ready in ${data.path}`
        });
        onSelect(repo.clone_url, repo.full_name);
      } else {
        toast.error('Failed to clone repository', {
          description: data.error
        });
      }
    } catch (error) {
      console.error('Clone error:', error);
      toast.error('Failed to clone repository');
    } finally {
      setIsCloning(false);
      setSelectedRepo(null);
    }
  };

  const filteredRepos = repos.filter(repo =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-[#1a1c1e] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Github size={24} className="text-gray-300" />
            <h2 className="text-lg font-semibold text-gray-100">Select GitHub Repository</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 size={32} className="animate-spin text-gray-400" />
            </div>
          ) : !isConnected ? (
            /* Not connected state */
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <Github size={48} className="text-gray-500 mb-4" />
              <h3 className="text-lg font-medium text-gray-200 mb-2">Connect to GitHub</h3>
              <p className="text-gray-400 mb-6 max-w-md">
                Connect your GitHub account to select repositories for your chat sessions.
              </p>
              <button
                onClick={handleConnect}
                className="flex items-center gap-2 px-6 py-3 bg-white text-black rounded-lg font-medium hover:bg-gray-200 transition-colors"
              >
                <Github size={20} />
                Connect GitHub
              </button>
            </div>
          ) : (
            /* Connected - show repo list */
            <>
              {/* Search */}
              <div className="p-4 border-b border-white/5">
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search repositories..."
                    className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-white/20"
                  />
                </div>
              </div>

              {/* Repo list */}
              <div className="flex-1 overflow-y-auto p-2">
                {filteredRepos.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    {searchQuery ? 'No repositories match your search' : 'No repositories found'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredRepos.map((repo) => (
                      <button
                        key={repo.id}
                        onClick={() => handleSelectRepo(repo)}
                        disabled={isCloning}
                        className={`w-full flex items-start gap-3 p-3 rounded-lg text-left transition-colors ${
                          isCloning && selectedRepo?.id === repo.id
                            ? 'bg-blue-500/10 border border-blue-500/20'
                            : 'hover:bg-white/5'
                        }`}
                      >
                        <img
                          src={repo.owner.avatar_url}
                          alt={repo.owner.login}
                          className="w-10 h-10 rounded-lg"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-100 truncate">
                              {repo.full_name}
                            </span>
                            {repo.private ? (
                              <Lock size={14} className="text-yellow-500 flex-shrink-0" />
                            ) : (
                              <Globe size={14} className="text-gray-500 flex-shrink-0" />
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-sm text-gray-400 truncate mt-0.5">
                              {repo.description}
                            </p>
                          )}
                        </div>
                        {isCloning && selectedRepo?.id === repo.id ? (
                          <Loader2 size={18} className="animate-spin text-blue-400 flex-shrink-0" />
                        ) : (
                          <ExternalLink size={18} className="text-gray-500 flex-shrink-0 opacity-0 group-hover:opacity-100" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer - Create new repo option */}
              <div className="p-4 border-t border-white/5">
                <a
                  href="https://github.com/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <Plus size={16} />
                  Create a new repository on GitHub
                  <ExternalLink size={14} />
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
