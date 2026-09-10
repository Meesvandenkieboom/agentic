import React, { useEffect, useId, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';

export interface MCPServer {
  id: string;
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  builtin: boolean;
  hasApiKey?: boolean;
  headerKeys?: string[];
  envKeys?: string[];
}

type ValuesDraft = { rows: [string, string][]; json?: string };
type CredentialAction = 'keep' | 'replace' | 'remove';
const inputClass =
  'w-full px-3 py-2 bg-white/5 border border-white/15 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-400';
const buttonClass =
  'px-3 py-2 rounded-lg text-sm bg-white/5 hover:bg-white/10 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-200 disabled:opacity-40 disabled:cursor-not-allowed';

function parseValues(draft: ValuesDraft): Record<string, string> {
  if (draft.json !== undefined) {
    const parsed = JSON.parse(draft.json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.entries(parsed).some(
        ([key, value]) => !key.trim() || typeof value !== 'string'
      )
    ) {
      throw new Error(
        'Use a JSON object with non-empty keys and string values.'
      );
    }
    return parsed;
  }
  const rows = draft.rows.filter(([key, value]) => key !== '' || value !== '');
  if (rows.some(([key]) => !key.trim()))
    throw new Error('Give each value a name.');
  const keys = rows.map(([key]) => key.trim());
  if (new Set(keys).size !== keys.length)
    throw new Error('Each name must be unique.');
  return Object.fromEntries(rows.map(([key, value]) => [key.trim(), value]));
}

function ValuesEditor({
  label,
  value,
  onChange,
  onCancel,
}: {
  label: string;
  value: ValuesDraft;
  onChange: (next: ValuesDraft) => void;
  onCancel?: () => void;
}) {
  const [error, setError] = useState('');
  const toggleJSON = () => {
    try {
      const parsed = parseValues(value);
      onChange(
        value.json === undefined
          ? { ...value, json: JSON.stringify(parsed, null, 2) }
          : { rows: Object.entries(parsed) }
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-gray-300">{label}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleJSON}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            {value.json === undefined ? 'Edit JSON' : 'Use fields'}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {value.json !== undefined ? (
        <label className="block">
          <span className="sr-only">{label} JSON</span>
          <textarea
            aria-label={`${label} JSON`}
            className={`${inputClass} font-mono text-sm min-h-28`}
            value={value.json}
            onChange={(e) => {
              onChange({ ...value, json: e.target.value });
              setError('');
            }}
            spellCheck={false}
          />
        </label>
      ) : (
        <>
          {value.rows.map(([key, val], index) => (
            <div key={index} className="flex gap-2">
              <input
                aria-label={`${label} name ${index + 1}`}
                className={inputClass}
                placeholder="Name"
                value={key}
                onChange={(e) =>
                  onChange({
                    rows: value.rows.map((row, i) =>
                      i === index ? [e.target.value, val] : row
                    ),
                  })
                }
                autoComplete="off"
              />
              <input
                aria-label={`${label} value ${index + 1}`}
                className={inputClass}
                placeholder="Value"
                type="password"
                value={val}
                onChange={(e) =>
                  onChange({
                    rows: value.rows.map((row, i) =>
                      i === index ? [key, e.target.value] : row
                    ),
                  })
                }
                autoComplete="new-password"
              />
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} row ${index + 1}`}
                className={buttonClass}
                onClick={() =>
                  onChange({ rows: value.rows.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
            onClick={() => onChange({ rows: [...value.rows, ['', '']] })}
          >
            <Plus size={14} />
            {label === 'Headers' ? 'Add header' : 'Add variable'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function MCPServerForm({
  server,
  isNew = false,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  server: MCPServer;
  isNew?: boolean;
  onSave: (
    id: string,
    config: Record<string, unknown>,
    reconnect: boolean
  ) => Promise<void>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const connectionTypeId = useId();
  const [draft, setDraft] = useState(() => ({
    id: server.id,
    name: server.name,
    type: server.type,
    url: server.url || '',
    command: server.command || '',
    args: server.args || [],
  }));
  const [initial] = useState(() => JSON.stringify(draft));
  const [headers, setHeaders] = useState<ValuesDraft>({ rows: [] });
  const [env, setEnv] = useState<ValuesDraft>({ rows: [] });
  const [headerAction, setHeaderAction] = useState<CredentialAction>('keep');
  const [envAction, setEnvAction] = useState<CredentialAction>('keep');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty =
    JSON.stringify(draft) !== initial ||
    headerAction !== 'keep' ||
    envAction !== 'keep';
  const typeChanged = draft.type !== server.type;
  const connectionChanged =
    typeChanged ||
    draft.url !== (server.url || '') ||
    draft.command !== (server.command || '') ||
    JSON.stringify(draft.args) !== JSON.stringify(server.args || []) ||
    headerAction !== 'keep' ||
    envAction !== 'keep';
  const canReconnect =
    !isNew &&
    server.enabled &&
    draft.type === 'stdio' &&
    draft.args.includes('mcp-remote');

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (reconnect: boolean) => {
    setError('');
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: draft.name,
        type: draft.type,
      };
      if (draft.type === 'http') {
        body.url = draft.url;
        if (headerAction === 'replace') body.headers = parseValues(headers);
        if (headerAction === 'remove') body.headers = null;
      } else {
        body.command = draft.command;
        body.args = draft.args;
        if (envAction === 'replace') body.env = parseValues(env);
        if (envAction === 'remove') body.env = null;
      }
      await onSave(draft.id, body, reconnect);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const credentials = (
    label: string,
    keys: string[],
    action: CredentialAction,
    setAction: (v: CredentialAction) => void,
    values: ValuesDraft,
    setValues: (v: ValuesDraft) => void
  ) => {
    if (action === 'replace' || keys.length === 0) {
      return (
        <div className="space-y-2">
          <ValuesEditor
            label={label}
            value={values}
            onChange={(next) => {
              setValues(next);
              setAction('replace');
            }}
            onCancel={
              keys.length
                ? () => {
                    setAction('keep');
                    setValues({ rows: [] });
                  }
                : undefined
            }
          />
          {keys.length > 0 && (
            <p className="text-xs text-gray-500">
              Enter all values to replace the saved {label.toLowerCase()}.
            </p>
          )}
        </div>
      );
    }
    if (action === 'remove') {
      return (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-gray-400">
            {label} will be removed on save.
          </span>
          <button
            type="button"
            className="text-gray-300 hover:text-white"
            onClick={() => setAction('keep')}
          >
            Undo
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-300">{label}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-xs text-gray-400 hover:text-gray-200"
              aria-label={`Edit ${label.toLowerCase()}`}
              onClick={() => {
                if (values.rows.length === 0)
                  setValues({ rows: keys.map((key) => [key, '']) });
                setAction('replace');
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-xs text-gray-400 hover:text-red-300"
              aria-label={`Remove all ${label.toLowerCase()}`}
              onClick={() => setAction('remove')}
            >
              Remove
            </button>
          </div>
        </div>
        {keys.map((key) => (
          <div key={key} className="grid grid-cols-2 gap-2">
            <input
              aria-label={`Saved ${label.toLowerCase()} name`}
              className={`${inputClass} text-gray-400`}
              value={key}
              readOnly
            />
            <input
              aria-label={`Saved value for ${key}`}
              className={`${inputClass} text-gray-500`}
              type="password"
              value="saved-value"
              readOnly
            />
          </div>
        ))}
      </div>
    );
  };

  const connectionTypeField = (
    <div className="space-y-1 text-sm text-gray-300">
      <label htmlFor={connectionTypeId} className="block">
        Connection type
      </label>
      <Select.Root
        value={draft.type}
        disabled={saving}
        onValueChange={(type) =>
          setDraft({ ...draft, type: type as MCPServer['type'] })
        }
      >
        <Select.Trigger
          id={connectionTypeId}
          aria-label="Connection type"
          className={`${inputClass} flex items-center justify-between gap-2 text-left`}
        >
          <Select.Value />
          <Select.Icon>
            <ChevronDown size={14} className="text-gray-400" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            align="start"
            sideOffset={4}
            className="z-[100] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-white/15 bg-gray-900 p-1 text-gray-200 shadow-xl"
          >
            <Select.Viewport>
              {[
                ['http', 'HTTP'],
                ['stdio', 'Stdio'],
              ].map(([value, label]) => (
                <Select.Item
                  key={value}
                  value={value}
                  className="relative flex cursor-pointer select-none items-center rounded px-3 py-2 pr-8 text-sm text-gray-200 outline-none data-[highlighted]:bg-white/10 data-[state=checked]:bg-white/5"
                >
                  <Select.ItemText>{label}</Select.ItemText>
                  <Select.ItemIndicator className="absolute right-2">
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      className="space-y-4 border-t border-white/10 pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-gray-100">
            {isNew ? 'Add integration' : 'Edit integration'}
          </h3>
          {!isNew && (
            <code className="text-xs text-gray-500" title="Server ID">
              {server.id}
            </code>
          )}
        </div>
        {dirty && (
          <span className="text-xs text-amber-300">Unsaved changes</span>
        )}
      </div>
      <fieldset disabled={saving} className="space-y-4 disabled:opacity-60">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1 text-sm text-gray-300 block">
            <span className="block">Display name</span>
            <input
              className={inputClass}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="My integration"
            />
          </label>
          {isNew ? (
            <label className="space-y-1 text-sm text-gray-300 block">
              <span className="block">Server ID</span>
              <input
                aria-label="Server ID"
                className={inputClass}
                required
                pattern="[a-z0-9-]+"
                value={draft.id}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                  })
                }
                placeholder="my-integration"
              />
            </label>
          ) : (
            connectionTypeField
          )}
        </div>
        {isNew && connectionTypeField}
        {typeChanged && !isNew && (
          <p className="text-xs text-amber-300">
            Switching type clears the previous connection settings.
          </p>
        )}
        {draft.type === 'http' ? (
          <>
            <label className="space-y-1 text-sm text-gray-300 block">
              <span className="block">Server URL</span>
              <input
                type="url"
                required
                className={inputClass}
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://example.com/mcp"
              />
            </label>
            {credentials(
              'Headers',
              server.headerKeys || [],
              headerAction,
              setHeaderAction,
              headers,
              setHeaders
            )}
          </>
        ) : (
          <>
            <label className="space-y-1 text-sm text-gray-300 block">
              <span className="block">Command</span>
              <input
                required
                className={inputClass}
                value={draft.command}
                onChange={(e) =>
                  setDraft({ ...draft, command: e.target.value })
                }
                placeholder="npx"
              />
            </label>
            <div className="space-y-2">
              <span className="block text-sm text-gray-300">Arguments</span>
              {draft.args.map((arg, index) => (
                <div className="flex gap-2" key={index}>
                  <input
                    aria-label={`Argument ${index + 1}`}
                    className={`${inputClass} font-mono text-sm`}
                    value={arg}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        args: draft.args.map((value, i) =>
                          i === index ? e.target.value : value
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Remove argument ${index + 1}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        args: draft.args.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
                onClick={() =>
                  setDraft({ ...draft, args: [...draft.args, ''] })
                }
              >
                <Plus size={14} />
                Add argument
              </button>
            </div>
            {credentials(
              'Environment variables',
              server.envKeys || [],
              envAction,
              setEnvAction,
              env,
              setEnv
            )}
          </>
        )}
        {!isNew && connectionChanged && (
          <p className="text-xs text-gray-500">
            Saving disconnects this integration. Changes apply to new chats.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
          <button type="button" className={buttonClass} onClick={onCancel}>
            Cancel
          </button>
          {canReconnect && (
            <button
              type="submit"
              disabled={!dirty}
              onClick={(e) => {
                if (e.currentTarget.form?.reportValidity()) {
                  e.preventDefault();
                  void save(true);
                }
              }}
              className={buttonClass}
            >
              Save and reconnect
            </button>
          )}
          <button
            type="submit"
            disabled={!isNew && !dirty}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-40"
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            {saving ? 'Saving…' : isNew ? 'Add integration' : 'Save changes'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
