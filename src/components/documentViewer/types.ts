import type { ReactNode } from 'react';
import type { DocumentPreviewResult, PreviewMode } from '../../types';
import type { DocumentLanguageInfo } from './language';
import type { ViewerSkinTokens } from './viewerSkin';

export type ViewerLayoutMode = 'windowed' | 'maximized' | 'fullscreen';
export type MermaidViewportMode = ViewerLayoutMode | 'focus';

export interface PreviewRenderContext {
  filePath: string;
  projectPath?: string;
  fileName: string;
  mode: PreviewMode;
  layoutMode: ViewerLayoutMode;
  active: boolean;
  contentVersion: number;
  result: DocumentPreviewResult;
  language: DocumentLanguageInfo;
  skin: ViewerSkinTokens;
}

export interface PreviewRenderer {
  id: 'code' | 'markdown' | 'mermaid' | 'svg' | 'image' | 'pdf' | 'docx' | 'doc' | 'unsupported';
  supports: (filePath: string, result: DocumentPreviewResult) => boolean;
  render: (context: PreviewRenderContext) => ReactNode;
}
