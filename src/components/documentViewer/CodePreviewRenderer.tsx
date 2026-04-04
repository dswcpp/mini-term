import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store';
import type { ThemePresetId } from '../../types';
import { highlightCodeToHtml } from './shiki';
import { TextPreviewRenderer } from './TextPreviewRenderer';
import type { PreviewRenderContext } from './types';

function getShikiTheme(themePreset: ThemePresetId) {
  return themePreset === 'ghostty-light' ? 'github-light' : 'github-dark';
}

export default function CodePreviewRenderer(context: PreviewRenderContext) {
  const { active, fileName, language, result } = context;
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [highlightedHtml, setHighlightedHtml] = useState('');
  const [highlightError, setHighlightError] = useState('');
  const highlightedHostRef = useRef<HTMLDivElement | null>(null);
  const canHighlight = language.highlighterKey !== 'text';

  const shikiTheme = getShikiTheme(themePreset);
  const viewerScopeId = useMemo(
    () => `code-viewer-${fileName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${language.languageId}`,
    [fileName, language.languageId],
  );

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;

    setHighlightedHtml('');
    setHighlightError('');

    if (!canHighlight) {
      return () => {
        cancelled = true;
      };
    }

    void highlightCodeToHtml(result.content, language.highlighterKey, shikiTheme)
      .then((html) => {
        if (!cancelled) {
          setHighlightedHtml(html);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setHighlightError(String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, canHighlight, language.highlighterKey, result.content, shikiTheme]);

  useEffect(() => {
    if (!highlightedHtml || !highlightedHostRef.current) {
      return;
    }

    highlightedHostRef.current.querySelectorAll('.line').forEach((line, index) => {
      line.setAttribute('data-source-line', String(index + 1));
    });
  }, [highlightedHtml, viewerScopeId]);

  const scopedCss = `
[data-shiki-viewer="${viewerScopeId}"] .shiki {
  margin: 0 !important;
  padding: 1px 0 !important;
  background: transparent !important;
  color: inherit !important;
  counter-reset: code-line;
  font-family: var(--viewer-code-font) !important;
  font-size: 12px;
  line-height: 1.05 !important;
  min-width: max-content;
}
[data-shiki-viewer="${viewerScopeId}"] .shiki code {
  display: block;
  min-width: max-content;
  line-height: inherit !important;
}
[data-shiki-viewer="${viewerScopeId}"] .shiki .line {
  display: block;
  position: relative;
  min-width: max-content;
  padding: 0 4px 0 34px;
  line-height: inherit !important;
}
[data-shiki-viewer="${viewerScopeId}"] .shiki .line::before {
  counter-increment: code-line;
  content: counter(code-line);
  position: absolute;
  inset: 0 auto 0 0;
  width: 24px;
  padding-right: 4px;
  color: var(--viewer-gutter-text);
  background: var(--viewer-gutter);
  border-right: 1px solid var(--viewer-border);
  text-align: right;
  user-select: none;
}
[data-shiki-viewer="${viewerScopeId}"] .shiki .line:hover {
  background: var(--viewer-line-hover);
}
`;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {highlightError ? (
        <div
          className="mx-2 mt-2 border px-2 py-1.5 text-[10px]"
          style={{ borderColor: 'var(--viewer-border)', color: 'var(--text-secondary)' }}
        >
          Highlighter fallback active: {highlightError}
        </div>
      ) : null}

      {highlightedHtml ? (
        <div
          data-testid="code-preview-renderer"
          className="min-h-0 flex-1 overflow-auto border"
          style={{
            borderColor: 'var(--viewer-border)',
            backgroundColor: 'var(--viewer-panel)',
          }}
        >
          <style>{scopedCss}</style>
          <div
            ref={highlightedHostRef}
            data-shiki-viewer={viewerScopeId}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </div>
      ) : (
        <TextPreviewRenderer {...context} testId="code-preview-fallback" />
      )}
    </div>
  );
}
