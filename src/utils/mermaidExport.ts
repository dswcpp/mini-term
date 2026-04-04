import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

export type MermaidExportFormat = 'svg' | 'png';

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '');
}

function ensureFileExtension(path: string, extension: MermaidExportFormat) {
  const normalized = path.toLowerCase();
  return normalized.endsWith(`.${extension}`) ? path : `${path}.${extension}`;
}

function buildDefaultFileName(baseName: string, extension: MermaidExportFormat) {
  return `${stripExtension(baseName)}.${extension}`;
}

function normalizeSvgMarkup(svgMarkup: string) {
  const hasXmlNs = /\sxmlns=/.test(svgMarkup);
  const hasXlinkNs = /\sxmlns:xlink=/.test(svgMarkup);

  let normalized = svgMarkup;
  if (!hasXmlNs) {
    normalized = normalized.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!hasXlinkNs) {
    normalized = normalized.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }

  return normalized;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode Mermaid SVG.'));
    image.src = url;
  });
}

async function svgMarkupToPngBytes(svgMarkup: string) {
  const normalizedSvg = normalizeSvgMarkup(svgMarkup);
  const svgBlob = new Blob([normalizedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(svgBlob);

  try {
    const image = await loadImage(objectUrl);
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(normalizedSvg, 'image/svg+xml');
    const svgElement = documentNode.documentElement;
    const viewBox = svgElement.getAttribute('viewBox')?.split(/[\s,]+/).map(Number) ?? [];
    const widthAttr = Number(svgElement.getAttribute('width')?.replace(/[^\d.]/g, '') ?? 0);
    const heightAttr = Number(svgElement.getAttribute('height')?.replace(/[^\d.]/g, '') ?? 0);
    const width = Math.max(Math.ceil(viewBox[2] || widthAttr || image.width || 1), 1);
    const height = Math.max(Math.ceil(viewBox[3] || heightAttr || image.height || 1), 1);
    const scale = Math.max(window.devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas rendering is unavailable.');
    }

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png');
    });
    if (!blob) {
      throw new Error('Failed to encode PNG export.');
    }

    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function exportMermaidDiagram(options: {
  svgMarkup: string;
  format: MermaidExportFormat;
  baseName: string;
}) {
  const { svgMarkup, format, baseName } = options;
  const targetPath = await save({
    title: format === 'svg' ? '导出 Mermaid SVG' : '导出 Mermaid PNG',
    defaultPath: buildDefaultFileName(baseName, format),
    filters: [
      {
        name: format.toUpperCase(),
        extensions: [format],
      },
    ],
  });

  if (!targetPath) {
    return null;
  }

  const finalPath = ensureFileExtension(targetPath, format);
  if (format === 'svg') {
    await invoke('write_text_file', {
      path: finalPath,
      content: normalizeSvgMarkup(svgMarkup),
    });
    return finalPath;
  }

  const pngBytes = await svgMarkupToPngBytes(svgMarkup);
  await invoke('write_binary_file', {
    path: finalPath,
    bytes: Array.from(pngBytes),
  });
  return finalPath;
}
