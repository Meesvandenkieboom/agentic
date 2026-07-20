/**
 * Agentic - Modern chat interface for Claude Agent SDK
 * Copyright (C) 2025 KenKai
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import React, { useState } from 'react';
import { X, Settings as SettingsIcon, Bot, Plug2, Sparkles } from 'lucide-react';
import { AgentSettingsTab } from './AgentSettingsTab';
import { MCPServersTab } from './MCPServersTab';
import { SkillsSettingsTab } from './SkillsSettingsTab';

type SettingsTab = 'agents' | 'skills' | 'mcp-servers';

interface Tab {
  id: SettingsTab;
  label: string;
  icon: React.ElementType;
}

const TABS: Tab[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp-servers', label: 'Integrations', icon: Plug2 },
];

interface SettingsProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

export function Settings({ onClose, initialTab = 'agents' }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-4xl max-h-[85vh] bg-[#1a1c1e] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <SettingsIcon size={24} className="text-gray-300" />
            <h2 className="text-lg font-semibold text-gray-100">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* Content with Sidebar */}
        <div className="flex flex-1 overflow-hidden">
          {/* Tab Sidebar */}
          <div className="w-56 border-r border-white/10 p-3 flex flex-col gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                    isActive
                      ? 'bg-white/10 text-white'
                      : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                  }`}
                >
                  <Icon size={18} className={isActive ? 'text-blue-400' : ''} />
                  <span className="font-medium">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'agents' && <AgentSettingsTab />}
            {activeTab === 'skills' && <SkillsSettingsTab />}
            {activeTab === 'mcp-servers' && <MCPServersTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
