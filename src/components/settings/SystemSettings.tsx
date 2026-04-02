import { useCallback } from 'react';
import { useAppStore } from '../../store';
import { patchAppConfig } from './saveConfig';

function FontSizeSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-base text-[var(--text-primary)]">{label}</span>
        <span className="font-mono text-base text-[var(--accent)]">{value}px</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--text-muted)]">{min}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-1.5 flex-1 cursor-pointer accent-[var(--accent)]"
        />
        <span className="text-sm text-[var(--text-muted)]">{max}</span>
      </div>
    </div>
  );
}

export function SystemSettings() {
  const config = useAppStore((state) => state.config);

  const handleUiFontSizeChange = useCallback((uiFontSize: number) => {
    document.documentElement.style.fontSize = `${uiFontSize}px`;
    void patchAppConfig((currentConfig) => ({
      ...currentConfig,
      uiFontSize,
    }));
  }, []);

  const handleTerminalFontSizeChange = useCallback((terminalFontSize: number) => {
    void patchAppConfig((currentConfig) => ({
      ...currentConfig,
      terminalFontSize,
    }));
  }, []);

  return (
    <div className="space-y-6">
      <div className="mb-2 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
        字体大小
      </div>

      <FontSizeSlider
        label="界面字体大小"
        value={config.uiFontSize ?? 13}
        min={10}
        max={20}
        onChange={handleUiFontSizeChange}
      />

      <FontSizeSlider
        label="终端字体大小"
        value={config.terminalFontSize ?? 14}
        min={10}
        max={24}
        onChange={handleTerminalFontSizeChange}
      />

      <div className="pt-2 text-sm text-[var(--text-muted)]">
        界面字体会影响侧栏、标签页和设置面板；终端字体会影响终端内容区的文本显示。
      </div>
    </div>
  );
}
