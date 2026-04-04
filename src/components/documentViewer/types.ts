import type { ReactNode } from 'react';
import type { FileContentResult, PreviewMode } from '../../types';
import type { DocumentLanguageInfo } from './language';
import type { ViewerSkinTokens } from './viewerSkin';

export type ViewerLayoutMode = 'windowed' | 'maximized' | 'fullscreen';
export type MermaidViewportMode = ViewerLayoutMode | 'focus';

export interface PreviewRenderContext {
  filePath: string;
  fileName: string;
  mode: PreviewMode;
  layoutMode: ViewerLayoutMode;
  active: boolean;
  result: FileContentResult;
  language: DocumentLanguageInfo;
  skin: ViewerSkinTokens;
}

export interface PreviewRenderer {
  id: 'code' | 'markdown';
  supports: (filePath: string, result: FileContentResult) => boolean;
  render: (context: PreviewRenderContext) => ReactNode;
}
