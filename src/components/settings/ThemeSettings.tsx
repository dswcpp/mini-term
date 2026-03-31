import { useCallback } from 'react';
import { useAppStore } from '../../store';
import { THEME_PRESET_LIST, WINDOW_EFFECT_OPTIONS, resolveTheme } from '../../theme';
import type { ThemePresetId, ThemeWindowEffect } from '../../types';
import { patchAppConfig } from './saveConfig';

export function ThemeSettings() {
  const themeConfig = useAppStore((s) => s.config.theme);
  const resolvedTheme = resolveTheme(themeConfig);

  const handlePresetChange = useCallback((preset: ThemePresetId) => {
    void patchAppConfig((config) => ({
      ...config,
      theme: { ...config.theme, preset },
    }));
  }, []);

  const handleWindowEffectChange = useCallback((windowEffect: ThemeWindowEffect) => {
    void patchAppConfig((config) => ({
      ...config,
      theme: { ...config.theme, windowEffect },
    }));
  }, []);

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
          主题预设
        </div>
        <div className="grid grid-cols-1 gap-3">
          {THEME_PRESET_LIST.map((preset) => {
            const active = preset.id === themeConfig.preset;

            return (
              <button
                key={preset.id}
                type="button"
                className={`rounded-[var(--radius-md)] border p-4 text-left transition-all duration-150 ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-default)]'
                }`}
                onClick={() => handlePresetChange(preset.id)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-base font-medium text-[var(--text-primary)]">{preset.name}</div>
                    <div className="mt-1 text-sm text-[var(--text-secondary)]">{preset.description}</div>
                  </div>
                  {active && (
                    <div className="text-xs uppercase tracking-[0.16em] text-[var(--accent)]">当前使用</div>
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  {preset.preview.map((color) => (
                    <span
                      key={color}
                      className="h-8 flex-1 rounded-[var(--radius-sm)] border border-white/10"
                      style={{ background: color }}
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-3 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
          窗口材质
        </div>
        <div className="space-y-2">
          {WINDOW_EFFECT_OPTIONS.map((option) => {
            const active = option.value === themeConfig.windowEffect;

            return (
              <button
                key={option.value}
                type="button"
                className={`w-full rounded-[var(--radius-md)] border px-3 py-3 text-left transition-all duration-150 ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-default)]'
                }`}
                onClick={() => handleWindowEffectChange(option.value)}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex h-3 w-3 rounded-full border-2 ${
                      active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block text-base text-[var(--text-primary)]">{option.label}</span>
                    <span className="mt-1 block text-sm text-[var(--text-secondary)]">{option.description}</span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="text-sm uppercase tracking-[0.12em] text-[var(--text-muted)]">当前主题配置</div>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-sm text-[var(--text-secondary)]">
{JSON.stringify(
  {
    preset: themeConfig.preset,
    windowEffect: themeConfig.windowEffect,
    resolvedPreset: resolvedTheme.preset.name,
    resolvedWindowEffect:
      themeConfig.windowEffect === 'auto' ? resolvedTheme.preset.windowEffect : themeConfig.windowEffect,
  },
  null,
  2,
)}
        </pre>
      </section>
    </div>
  );
}
