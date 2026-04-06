import type { PreviewRenderContext } from './types';
import { MermaidDiagramBlock } from './MermaidDiagramBlock';

export default function MermaidPreviewRenderer({
  active,
  fileName,
  layoutMode,
  result,
}: PreviewRenderContext) {
  const source = result.textContent?.trim() ?? '';

  if (!source) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-[var(--text-muted)]">
        This Mermaid file is empty.
      </div>
    );
  }

  return (
    <MermaidDiagramBlock
      source={source}
      active={active}
      layoutMode={layoutMode}
      exportFileName={fileName}
      immersive
      autoOpenFocus
    />
  );
}
