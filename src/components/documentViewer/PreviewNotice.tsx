import { openPath } from '@tauri-apps/plugin-opener';
import { ToolbarTextButton } from './controls';

interface PreviewNoticeProps {
  title: string;
  message: string;
  filePath?: string;
  warning?: string;
  testId?: string;
}

export function PreviewNotice({
  title,
  message,
  filePath,
  warning,
  testId,
}: PreviewNoticeProps) {
  return (
    <div
      data-testid={testId}
      className="flex h-full items-center justify-center px-6 py-8"
      style={{ backgroundColor: 'var(--viewer-panel)' }}
    >
      <div
        className="flex w-full max-w-[560px] flex-col gap-3 border px-5 py-5"
        style={{
          borderColor: 'var(--viewer-border)',
          backgroundColor: 'var(--viewer-panel-elevated)',
        }}
      >
        <div className="text-sm font-semibold tracking-[0.02em]" style={{ color: 'var(--viewer-accent)' }}>
          {title}
        </div>
        <div className="text-sm leading-6" style={{ color: 'var(--text-primary)' }}>
          {message}
        </div>
        {warning ? (
          <div className="border-l-2 pl-3 text-xs leading-5" style={{ color: 'var(--text-secondary)', borderColor: 'var(--viewer-border)' }}>
            {warning}
          </div>
        ) : null}
        {filePath ? (
          <div className="pt-1">
            <ToolbarTextButton
              label="Open with default app"
              onClick={() => {
                void openPath(filePath);
              }}
              testId="document-preview-open-external"
            >
              OPEN EXTERNALLY
            </ToolbarTextButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
