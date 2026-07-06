import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { openExternalUrl } from '../utils/externalLink';
import { useT } from '../i18n';

interface MarkdownPreviewProps {
  content: string;
  currentPath: string;
  onNavigateLocal: (path: string) => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
}

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerAliases(['c', 'cc', 'cxx', 'hpp', 'hxx', 'h++'], { languageName: 'cpp' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' });

/** 把 Markdown 里的相对/绝对本地链接解析成规范化的绝对路径（正斜杠、去掉 ./ 与 ..） */
function resolveLocalHref(currentFile: string, href: string): string | null {
  let raw = href.split('#')[0].split('?')[0].trim();
  if (!raw) return null;
  try { raw = decodeURI(raw); } catch { /* 保留原值 */ }
  raw = raw.replace(/\\/g, '/');
  const curr = currentFile.replace(/\\/g, '/');
  const dir = curr.slice(0, curr.lastIndexOf('/'));
  const isWinAbs = /^[a-zA-Z]:\//.test(raw);
  const isPosixAbs = raw.startsWith('/');
  const base = isWinAbs || isPosixAbs ? raw : `${dir}/${raw}`;
  const out: string[] = [];
  for (const seg of base.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  if (isPosixAbs && !/^[a-zA-Z]:$/.test(out[0] ?? '')) return '/' + out.join('/');
  return out.join('/');
}

function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '-');
}

function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode }) {
    return <Tag id={slugify(nodeText(children))} {...props}>{children}</Tag>;
  };
}

const headingComponents = {
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
};

function normalizeCodeLanguage(language?: string): string {
  const normalized = (language ?? '').trim().toLowerCase();
  if (!normalized) return 'text';
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'h++': 'cpp',
    cxx: 'cpp',
    hxx: 'cpp',
    hpp: 'cpp',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    pwsh: 'powershell',
    rs: 'rust',
  };
  return aliases[normalized] ?? normalized;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightLine(line: string, language: string): string {
  if (!line) return '';
  if (language !== 'text' && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(line, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(line);
    }
  }
  return escapeHtml(line);
}

function HighlightedCodeBlock({ code, language }: { code: string; language?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayLanguage = language?.trim() || 'text';
  const highlightLanguage = normalizeCodeLanguage(language);
  const lines = useMemo(() => {
    const normalized = code.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return (normalized || '').split('\n');
  }, [code]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void writeText(code).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
    });
  }, [code]);

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span>{displayLanguage}</span>
        <button
          type="button"
          className="md-code-copy-button"
          title={t('fileViewer.copyCode')}
          onClick={handleCopy}
        >
          {copied ? t('fileViewer.copied') : t('fileViewer.copy')}
        </button>
      </div>
      <code className={`language-${highlightLanguage}`}>
        {lines.map((line, index) => (
          <span className="md-code-line" key={index}>
            <span className="md-code-line-number">{index + 1}</span>
            <span
              className="md-code-line-code"
              dangerouslySetInnerHTML={{ __html: highlightLine(line, highlightLanguage) }}
            />
          </span>
        ))}
      </code>
    </div>
  );
}

let mermaidIdCounter = 0;

type MermaidApi = typeof import('mermaid').default;
const MERMAID_MIN_SCALE = 0.2;
const MERMAID_MAX_SCALE = 5;

function configureMermaid(mermaidApi: MermaidApi) {
  const isLight = document.documentElement.dataset.theme === 'light';
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isLight ? 'default' : 'dark',
  });
}

async function renderMermaidSvg(id: string, chart: string): Promise<string> {
  const { default: mermaidApi } = await import('mermaid');
  configureMermaid(mermaidApi);
  const { svg } = await mermaidApi.render(id, chart);
  return svg;
}

function MermaidFullscreen({ svg, onClose }: { svg: string; onClose: () => void }) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const fitView = useCallback(() => {
    const stage = stageRef.current;
    const svgEl = canvasRef.current?.querySelector('svg');
    if (!stage || !svgEl) return;
    const stageRect = stage.getBoundingClientRect();
    const box = svgEl.getBBox();
    if (box.width <= 0 || box.height <= 0) return;
    const nextScale = Math.min(
      MERMAID_MAX_SCALE,
      Math.max(MERMAID_MIN_SCALE, Math.min(stageRect.width / box.width, stageRect.height / box.height) * 0.88),
    );
    setScale(nextScale);
    setOffset({ x: 0, y: 0 });
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(frame);
  }, [svg, fitView]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    setScale((current) => {
      const next = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, current * factor));
      if (!rect || clientX == null || clientY == null || next === current) return next;
      const stageX = clientX - rect.left - rect.width / 2;
      const stageY = clientY - rect.top - rect.height / 2;
      setOffset((currentOffset) => {
        const contentX = (stageX - currentOffset.x) / current;
        const contentY = (stageY - currentOffset.y) / current;
        return {
          x: stageX - contentX * next,
          y: stageY - contentY * next,
        };
      });
      return next;
    });
  }, []);

  const zoomFromCenter = useCallback((factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      zoomAt(factor);
      return;
    }
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAt]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomFromCenter(1.18);
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomFromCenter(1 / 1.18);
      }
      if (e.key === '0') {
        e.preventDefault();
        resetView();
      }
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        fitView();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fitView, onClose, resetView, zoomFromCenter]);

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, [zoomAt]);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
  }, [offset.x, offset.y]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset({
      x: drag.offsetX + e.clientX - drag.x,
      y: drag.offsetY + e.clientY - drag.y,
    });
  }, []);

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
        <div className="text-sm text-white/80 truncate">{t('fileViewer.mermaidFullscreen')}</div>
        <div className="flex items-center gap-2">
          <button
            className="md-mermaid-tool-button"
            type="button"
            title={t('fileViewer.zoomOut')}
            onClick={(e) => {
              e.stopPropagation();
              zoomFromCenter(1 / 1.18);
            }}
          >
            -
          </button>
          <span className="md-mermaid-scale">{Math.round(scale * 100)}%</span>
          <button
            className="md-mermaid-tool-button"
            type="button"
            title={t('fileViewer.zoomIn')}
            onClick={(e) => {
              e.stopPropagation();
              zoomFromCenter(1.18);
            }}
          >
            +
          </button>
          <button
            className="md-mermaid-tool-button"
            type="button"
            title={t('fileViewer.mermaidFit')}
            onClick={(e) => {
              e.stopPropagation();
              fitView();
            }}
          >
            Fit
          </button>
          <button
            className="md-mermaid-tool-button"
            type="button"
            title={t('fileViewer.mermaidReset')}
            onClick={(e) => {
              e.stopPropagation();
              resetView();
            }}
          >
            1:1
          </button>
          <button
            className="md-mermaid-tool-button"
            type="button"
            title={t('fileViewer.close')}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            x
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className="md-mermaid-fullscreen-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          ref={canvasRef}
          className="md-mermaid-fullscreen-canvas"
          style={{ transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body,
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const t = useT();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const idRef = useRef(`md-mermaid-${++mermaidIdCounter}`);

  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setError('');
    const renderId = `${idRef.current}-${++mermaidIdCounter}`;
    renderMermaidSvg(renderId, chart)
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="md-mermaid-block md-mermaid-error">
        <div className="md-mermaid-error-title">{t('fileViewer.mermaidRenderFailed')}</div>
        <div className="md-mermaid-error-message">{error}</div>
        <HighlightedCodeBlock code={chart} language="mermaid" />
      </div>
    );
  }

  return (
    <div className="md-mermaid-block">
      <div className="md-mermaid-toolbar">
        <span>Mermaid</span>
        <button
          type="button"
          className="md-mermaid-icon-button"
          title={t('fileViewer.mermaidFullscreen')}
          disabled={!svg}
          onClick={() => setFullscreen(true)}
        >
          ⛶
        </button>
      </div>
      <div className="md-mermaid-stage">
        {svg ? (
          <div className="md-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="md-mermaid-loading">{t('fileViewer.mermaidRendering')}</div>
        )}
      </div>
      {fullscreen && svg && <MermaidFullscreen svg={svg} onClose={() => setFullscreen(false)} />}
    </div>
  );
}

interface MarkdownCodeElementProps {
  className?: string;
  children?: ReactNode;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const codeChild = Children.toArray(children).find((child) =>
    isValidElement<MarkdownCodeElementProps>(child)
  );
  if (!isValidElement<MarkdownCodeElementProps>(codeChild)) {
    return <pre>{children}</pre>;
  }

  const rawCode = nodeText(codeChild.props.children).replace(/\n$/, '');
  const language = /language-([^\s]+)/.exec(codeChild.props.className ?? '')?.[1] ?? 'text';
  if (language.toLowerCase() === 'mermaid') {
    return <MermaidBlock chart={rawCode} />;
  }
  return <HighlightedCodeBlock code={rawCode} language={language} />;
}

export function MarkdownPreview({ content, currentPath, onNavigateLocal, contentRef }: MarkdownPreviewProps) {
  const resolveImgSrc = useCallback((src: string | undefined) => {
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return src;
    const normalized = currentPath.replace(/\\/g, '/');
    const fileDir = normalized.substring(0, normalized.lastIndexOf('/'));
    return convertFileSrc(fileDir + '/' + src);
  }, [currentPath]);

  const handleLinkClick = useCallback((e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const href = e.currentTarget.getAttribute('href');
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      void openExternalUrl(href);
      return;
    }
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* 保留原值 */ }
      const el = contentRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) {
      openUrl(href).catch((err) => console.error('打开链接失败:', err));
      return;
    }
    const target = resolveLocalHref(currentPath, href);
    if (target) onNavigateLocal(target);
  }, [contentRef, currentPath, onNavigateLocal]);

  const markdownComponents = useMemo<Components>(() => ({
    ...headingComponents,
    pre: ({ children }) => <MarkdownPre>{children}</MarkdownPre>,
    code: ({ className, children, ...props }) => (
      <code className={className} {...props}>{children}</code>
    ),
    img: ({ src, alt, ...props }) => (
      <img src={resolveImgSrc(src)} alt={alt ?? ''} {...props} />
    ),
    a: ({ href, children, ...props }) => (
      <a href={href} onClick={handleLinkClick} {...props}>{children}</a>
    ),
  }), [handleLinkClick, resolveImgSrc]);

  return (
    <div className="md-preview p-6 max-w-[860px] mx-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
