const SHORTCUT_GROUPS: { title: string; items: { keys: string; desc: string }[] }[] = [
  {
    title: '终端操作',
    items: [
      { keys: 'Ctrl + Shift + C', desc: '复制终端选中文本' },
      { keys: 'Ctrl + Shift + V', desc: '粘贴到终端' },
    ],
  },
];

export function ShortcutsSettings() {
  return (
    <div className="space-y-6">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title}>
          <div className="mb-2 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
            {group.title}
          </div>

          <div className="space-y-1">
            {group.items.map((item) => (
              <div
                key={item.keys}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5"
              >
                <span className="text-base text-[var(--text-primary)]">{item.desc}</span>
                <kbd className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-sm text-[var(--text-secondary)]">
                  {item.keys}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="pt-2 text-sm text-[var(--text-muted)]">
        终端快捷键只在终端面板获得焦点时生效。
      </div>
    </div>
  );
}
