import type { PreviewRenderContext } from './types';

interface TextPreviewRendererProps extends PreviewRenderContext {
  testId?: string;
}

export function TextPreviewRenderer({ result, testId }: TextPreviewRendererProps) {
  return (
    <div
      data-testid={testId}
      className="overflow-auto border"
      style={{
        borderColor: 'var(--viewer-border)',
        backgroundColor: 'var(--viewer-panel)',
      }}
    >
      <div
        className="font-mono text-[12px] leading-[1.05]"
        style={{
          fontFamily: 'var(--viewer-code-font)',
        }}
      >
        {result.content.split('\n').map((line, index) => (
          <div
            key={index}
            className="flex"
            style={{
              backgroundColor: 'transparent',
            }}
          >
            <span
              className="w-6 flex-shrink-0 select-none pr-0.5 text-right opacity-75"
              style={{
                color: 'var(--viewer-gutter-text)',
                backgroundColor: 'var(--viewer-gutter)',
                borderRight: '1px solid var(--viewer-border)',
              }}
            >
              {index + 1}
            </span>
            <span
              className="flex-1 whitespace-pre px-0.5"
              style={{
                color: 'var(--text-primary)',
              }}
            >
              {line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
