/** Agentic-specific selection of user-installed Codex skills. */

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Info, Loader2, Power, PowerOff } from 'lucide-react';
import { toast } from '../../utils/toast';

type SkillPolicyMode = 'inherit' | 'custom';

interface Skill {
  name: string;
  description: string;
  path: string;
  enabled: boolean | null;
}

export function SkillsSettingsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mode, setMode] = useState<SkillPolicyMode>('inherit');
  const [savedMode, setSavedMode] = useState<SkillPolicyMode>('inherit');
  const [enabledPaths, setEnabledPaths] = useState<Set<string>>(new Set());
  const [savedEnabledPaths, setSavedEnabledPaths] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const loadSkills = async () => {
      try {
        const response = await fetch('/api/skills');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load skills');

        const loadedSkills = data.skills as Skill[];
        const loadedMode = data.mode as SkillPolicyMode;
        const selected = new Set(
          loadedMode === 'custom'
            ? loadedSkills.filter((skill) => skill.enabled).map((skill) => skill.path)
            : loadedSkills.map((skill) => skill.path),
        );

        setSkills(loadedSkills);
        setMode(loadedMode);
        setSavedMode(loadedMode);
        setEnabledPaths(selected);
        setSavedEnabledPaths(new Set(selected));
      } catch (error) {
        console.error('Failed to load skills:', error);
        toast.error('Failed to load skills');
      } finally {
        setIsLoading(false);
      }
    };

    void loadSkills();
  }, []);

  const isDirty = useMemo(() => {
    if (mode !== savedMode) return true;
    if (mode === 'inherit') return false;
    if (enabledPaths.size !== savedEnabledPaths.size) return true;
    return [...enabledPaths].some((skillPath) => !savedEnabledPaths.has(skillPath));
  }, [enabledPaths, mode, savedEnabledPaths, savedMode]);

  const selectMode = (nextMode: SkillPolicyMode) => {
    if (nextMode === 'custom' && mode === 'inherit' && savedMode === 'inherit') {
      setEnabledPaths(new Set(skills.map((skill) => skill.path)));
    }
    setMode(nextMode);
  };

  const toggleSkill = (skillPath: string) => {
    if (mode !== 'custom') return;
    setEnabledPaths((current) => {
      const next = new Set(current);
      if (next.has(skillPath)) next.delete(skillPath);
      else next.add(skillPath);
      return next;
    });
  };

  const save = async () => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/skills/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          enabledPaths: mode === 'custom' ? [...enabledPaths] : [],
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save skill settings');

      setSavedMode(mode);
      setSavedEnabledPaths(new Set(enabledPaths));
      toast.success('Skill settings saved', { description: 'Applies to the next Codex message' });
    } catch (error) {
      console.error('Failed to save skill settings:', error);
      toast.error('Failed to save skill settings', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg flex gap-3">
        <Info size={20} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-gray-300">
          <p className="font-medium text-blue-300 mb-1">Codex user skills</p>
          <p>
            Control skills installed in <code className="text-gray-200">~/.agents/skills</code> for Agentic&apos;s
            Codex sessions. Built-in, administrator, and repository skills remain managed by Codex.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <button
          type="button"
          onClick={() => selectMode('inherit')}
          className={`p-4 rounded-lg border text-left transition-colors ${
            mode === 'inherit'
              ? 'border-blue-500/50 bg-blue-500/10'
              : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-gray-100">Use global settings</span>
            {mode === 'inherit' && <Check size={18} className="text-blue-400" />}
          </div>
          <p className="text-sm text-gray-400">Do not override native Codex skill discovery or configuration.</p>
        </button>

        <button
          type="button"
          onClick={() => selectMode('custom')}
          className={`p-4 rounded-lg border text-left transition-colors ${
            mode === 'custom'
              ? 'border-blue-500/50 bg-blue-500/10'
              : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-gray-100">Choose for Agentic</span>
            {mode === 'custom' && <Check size={18} className="text-blue-400" />}
          </div>
          <p className="text-sm text-gray-400">Use only the user-installed skills selected below.</p>
        </button>
      </div>

      <div className="space-y-2 mb-5">
        {skills.length === 0 ? (
          <div className="p-5 text-center text-sm text-gray-400 border border-dashed border-white/15 rounded-lg">
            No user-installed skills found.
          </div>
        ) : skills.map((skill) => {
          const inherited = mode === 'inherit';
          const enabled = enabledPaths.has(skill.path);
          return (
            <div key={skill.path} className="flex items-start gap-3 p-3 bg-white/5 rounded-lg border border-white/10">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-gray-100">{skill.name}</span>
                  {mode === 'inherit' && (
                    <span className="text-xs px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded-full">Inherited</span>
                  )}
                </div>
                {skill.description && <p className="text-sm text-gray-400 mb-1">{skill.description}</p>}
                <p className="text-xs text-gray-600 truncate" title={skill.path}>{skill.path}</p>
              </div>
              <button
                type="button"
                onClick={() => toggleSkill(skill.path)}
                disabled={mode !== 'custom'}
                title={mode === 'custom' ? (enabled ? 'Disable skill' : 'Enable skill') : 'Controlled by global Codex settings'}
                className={`p-2 rounded-lg transition-colors ${
                  inherited
                    ? 'bg-gray-500/20 text-gray-400'
                    : enabled
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-gray-500/20 text-gray-400'
                } ${mode !== 'custom' ? 'cursor-not-allowed opacity-60' : 'hover:brightness-125'}`}
              >
                {inherited || enabled ? <Power size={18} /> : <PowerOff size={18} />}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-gray-500">
          {mode === 'custom' ? `${enabledPaths.size} of ${skills.length} selected` : 'No Agentic override'}
        </p>
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || isSaving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {isSaving && <Loader2 size={16} className="animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}
