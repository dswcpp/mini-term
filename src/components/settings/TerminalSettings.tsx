import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../store';
import type { ShellConfig } from '../../types';
import { patchAppConfig } from './saveConfig';

function ShellRow({
  shell,
  isDefault,
  onSetDefault,
  onDelete,
  onUpdate,
}: {
  shell: ShellConfig;
  isDefault: boolean;
  onSetDefault: () => void;
  onDelete: () => void;
  onUpdate: (shell: ShellConfig) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(shell.name);
  const [command, setCommand] = useState(shell.command);
  const [args, setArgs] = useState(shell.args?.join(' ') ?? '');

  useEffect(() => {
    setName(shell.name);
    setCommand(shell.command);
    setArgs(shell.args?.join(' ') ?? '');
  }, [shell]);

  const handleSave = () => {
    onUpdate({
      name: name.trim() || shell.name,
      command: command.trim() || shell.command,
      args: args.trim() ? args.trim().split(/\s+/) : undefined,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-base)] p-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="终端名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="flex-[2] rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="命令路径"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="可选启动参数"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
          <button
            className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1 text-base text-[var(--bg-base)] transition-opacity hover:opacity-90"
            onClick={handleSave}
          >
            保存
          </button>
          <button
            className="px-3 py-1 text-base text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setEditing(false)}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5 transition-colors hover:border-[var(--border-default)]">
      <button
        type="button"
        className={`h-3 w-3 flex-shrink-0 rounded-full border-2 transition-colors ${
          isDefault
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--border-strong)] hover:border-[var(--accent)]'
        }`}
        title="设为默认"
        onClick={onSetDefault}
      />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-[var(--text-primary)]">{shell.name}</div>
        <div className="truncate font-mono text-sm text-[var(--text-muted)]">
          {shell.command}
          {shell.args ? ` ${shell.args.join(' ')}` : ''}
        </div>
      </div>
      <div className="hidden items-center gap-1 group-hover:flex">
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={() => setEditing(true)}
        >
          编辑
        </button>
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--color-error)]"
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </div>
  );
}

export function TerminalSettings() {
  const config = useAppStore((s) => s.config);
  const [shells, setShells] = useState<ShellConfig[]>([]);
  const [defaultShell, setDefaultShell] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');

  useEffect(() => {
    setShells([...config.availableShells]);
    setDefaultShell(config.defaultShell);
    setAdding(false);
  }, [config]);

  const persistShells = useCallback((updatedShells: ShellConfig[], updatedDefault: string) => {
    void patchAppConfig((currentConfig) => ({
      ...currentConfig,
      availableShells: updatedShells,
      defaultShell: updatedDefault,
    }));
  }, []);

  const handleAdd = () => {
    if (!newName.trim() || !newCommand.trim()) return;

    const shell: ShellConfig = {
      name: newName.trim(),
      command: newCommand.trim(),
      args: newArgs.trim() ? newArgs.trim().split(/\s+/) : undefined,
    };

    const updatedShells = [...shells, shell];
    const updatedDefault = defaultShell || shell.name;
    setShells(updatedShells);
    setDefaultShell(updatedDefault);
    setAdding(false);
    setNewName('');
    setNewCommand('');
    setNewArgs('');
    persistShells(updatedShells, updatedDefault);
  };

  const handleDelete = (index: number) => {
    const updatedShells = shells.filter((_, shellIndex) => shellIndex !== index);
    const updatedDefault = updatedShells.find((shell) => shell.name === defaultShell)
      ? defaultShell
      : updatedShells[0]?.name ?? '';
    setShells(updatedShells);
    setDefaultShell(updatedDefault);
    persistShells(updatedShells, updatedDefault);
  };

  const handleUpdate = (index: number, shell: ShellConfig) => {
    const updatedShells = shells.map((currentShell, shellIndex) => (shellIndex === index ? shell : currentShell));
    const updatedDefault = shells[index].name === defaultShell ? shell.name : defaultShell;
    setShells(updatedShells);
    setDefaultShell(updatedDefault);
    persistShells(updatedShells, updatedDefault);
  };

  const handleSetDefault = (name: string) => {
    setDefaultShell(name);
    persistShells(shells, name);
  };

  return (
    <div className="space-y-3">
      <div className="mb-2 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
        可用终端
      </div>

      {shells.map((shell, index) => (
        <ShellRow
          key={`${shell.name}-${index}`}
          shell={shell}
          isDefault={shell.name === defaultShell}
          onSetDefault={() => handleSetDefault(shell.name)}
          onDelete={() => handleDelete(index)}
          onUpdate={(nextShell) => handleUpdate(index, nextShell)}
        />
      ))}

      {adding ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--accent)] bg-[var(--bg-base)] p-3">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              placeholder="名称（例如：pwsh）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <input
              className="flex-[2] rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              placeholder="命令路径（例如：pwsh 或 C:\\Tools\\bash.exe）"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-base text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              placeholder="可选启动参数"
              value={newArgs}
              onChange={(e) => setNewArgs(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <button
              className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1 text-base text-[var(--bg-base)] transition-opacity hover:opacity-90"
              onClick={handleAdd}
            >
              添加
            </button>
            <button
              className="px-3 py-1 text-base text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              onClick={() => setAdding(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="w-full rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] py-2.5 text-base text-[var(--text-muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={() => setAdding(true)}
        >
          + 添加终端
        </button>
      )}

      <div className="pt-2 text-sm text-[var(--text-muted)]">
        点击左侧圆点可设为默认终端。新标签页会优先使用这里的默认项，除非你在创建时主动选择其他终端。
      </div>
    </div>
  );
}
