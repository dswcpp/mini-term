import type { PreviewMode } from '../types';

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').trim().toLowerCase();
}

function getExtension(filePath: string) {
  const normalized = normalizePath(filePath);
  const extensionMatch = /\.[^.\\/]+$/.exec(normalized);
  return extensionMatch?.[0] ?? '';
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const MERMAID_EXTENSIONS = new Set(['.mmd', '.mermaid']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const SVG_EXTENSIONS = new Set(['.svg']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.docx']);
const DOC_EXTENSIONS = new Set(['.doc']);

export function isMarkdownPreviewFilePath(filePath: string) {
  return MARKDOWN_EXTENSIONS.has(getExtension(filePath));
}

export function isImagePreviewFilePath(filePath: string) {
  return IMAGE_EXTENSIONS.has(getExtension(filePath));
}

export function isMermaidPreviewFilePath(filePath: string) {
  return MERMAID_EXTENSIONS.has(getExtension(filePath));
}

export function isSvgPreviewFilePath(filePath: string) {
  return SVG_EXTENSIONS.has(getExtension(filePath));
}

export function isPdfPreviewFilePath(filePath: string) {
  return PDF_EXTENSIONS.has(getExtension(filePath));
}

export function isDocxPreviewFilePath(filePath: string) {
  return DOCX_EXTENSIONS.has(getExtension(filePath));
}

export function isDocPreviewFilePath(filePath: string) {
  return DOC_EXTENSIONS.has(getExtension(filePath));
}

export function supportsRichPreview(filePath: string) {
  return (
    isMarkdownPreviewFilePath(filePath)
    || isMermaidPreviewFilePath(filePath)
    || isSvgPreviewFilePath(filePath)
    || isImagePreviewFilePath(filePath)
    || isPdfPreviewFilePath(filePath)
    || isDocxPreviewFilePath(filePath)
    || isDocPreviewFilePath(filePath)
  );
}

export function supportsSourceMode(filePath: string) {
  return (
    isMarkdownPreviewFilePath(filePath)
    || isMermaidPreviewFilePath(filePath)
    || isSvgPreviewFilePath(filePath)
    || !supportsRichPreview(filePath)
  );
}

export function prefersPreviewMode(filePath: string) {
  return (
    isMermaidPreviewFilePath(filePath)
    || isSvgPreviewFilePath(filePath)
    || isImagePreviewFilePath(filePath)
    || isPdfPreviewFilePath(filePath)
    || isDocxPreviewFilePath(filePath)
    || isDocPreviewFilePath(filePath)
  );
}

export function supportsModeToggle(filePath: string) {
  return isMarkdownPreviewFilePath(filePath) || isMermaidPreviewFilePath(filePath) || isSvgPreviewFilePath(filePath);
}

export function getDefaultPreviewMode(filePath: string): PreviewMode {
  return prefersPreviewMode(filePath) ? 'preview' : 'source';
}

export function normalizePreviewModeForFile(filePath: string, mode?: PreviewMode): PreviewMode {
  if (mode === 'preview') {
    return supportsRichPreview(filePath) ? 'preview' : 'source';
  }

  if (mode === 'source') {
    return supportsSourceMode(filePath) ? 'source' : getDefaultPreviewMode(filePath);
  }

  return getDefaultPreviewMode(filePath);
}
