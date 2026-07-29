import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { FileContentResult } from '../types';
import { Modal } from './Modal';
import { useT } from '../i18n';
import { MarkdownPreview } from './MarkdownPreview';

interface FileViewerModalProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  projectRoot: string;
  highlightLine?: number;
}

function isMarkdownFile(path: string) {
  return /\.(md|markdown|mkd|mdx)$/i.test(path);
}

function isImageFile(path: string) {
  return /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif|tiff?)$/i.test(path);
}

function isHtmlFile(path: string) {
  return /\.html?$/i.test(path);
}

export function FileViewerModal({ open, onClose, filePath, projectRoot, highlightLine }: FileViewerModalProps) {
  const t = useT();
  const [result, setResult] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(true);
  // 当前正在查看的文件，可随 Markdown 内的本地链接跳转；初始为传入的 filePath
  const [currentPath, setCurrentPath] = useState(filePath);
  const [history, setHistory] = useState<string[]>([]);
  const highlightRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readRequestIdRef = useRef(0);

  const isMd = useMemo(() => isMarkdownFile(currentPath), [currentPath]);
  const isImg = useMemo(() => isImageFile(currentPath), [currentPath]);
  const isHtml = useMemo(() => isHtmlFile(currentPath), [currentPath]);

  const htmlSrcDoc = useMemo(() => {
    if (!isHtml || !result?.content) return '';
    const normalized = currentPath.replace(/\\/g, '/');
    const fileDir = normalized.substring(0, normalized.lastIndexOf('/'));
    return result.content.replace(
      /((?:src|href|poster)\s*=\s*["'])(?!https?:|data:|blob:|mailto:|tel:|#|javascript:)([^"']+)(["'])/gi,
      (_match, prefix, url, suffix) => prefix + convertFileSrc(fileDir + '/' + url) + suffix
    );
  }, [isHtml, result?.content, currentPath]);

  // 跳转到链接目标文件，记录历史以支持返回
  // 用两次独立 setState（而非在 updater 里嵌套 setState），避免 StrictMode 下
  // updater 被二次调用导致 history 重复入栈。
  const navigateTo = useCallback((absPath: string) => {
    if (absPath === currentPath) return;
    setHistory((h) => [...h, currentPath]);
    setCurrentPath(absPath);
  }, [currentPath]);

  const goBack = useCallback(() => {
    if (!history.length) return;
    setCurrentPath(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
  }, [history]);

  // 外部传入的 filePath 变化（或重新打开）时，先使旧请求失效，再重置到该文件。
  // 该 effect 必须位于读取 effect 之前：同一轮提交中重新打开时，新的读取请求
  // 应使用重置后的 request id，而不是被重置逻辑误作废。
  useEffect(() => {
    ++readRequestIdRef.current;
    setCurrentPath(filePath);
    setHistory([]);
    setLoading(false);
    setError('');
    setResult(null);
  }, [filePath, open]);

  // 非图片文件时读取文本内容；请求序号与取消标记共同阻止旧文件结果回写。
  useEffect(() => {
    const requestId = ++readRequestIdRef.current;
    let cancelled = false;

    if (!open || isImg) {
      setLoading(false);
      setError('');
      setResult(null);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError('');
    setResult(null);

    invoke<FileContentResult>('read_file_content', { projectRoot, path: currentPath })
      .then((nextResult) => {
        if (!cancelled && readRequestIdRef.current === requestId) setResult(nextResult);
      })
      .catch((e) => {
        if (!cancelled && readRequestIdRef.current === requestId) setError(String(e));
      })
      .finally(() => {
        if (!cancelled && readRequestIdRef.current === requestId) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, currentPath, projectRoot, isImg]);

  // 跳转后内容区滚回顶部
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [currentPath]);

  // 仅当查看的是原始 filePath 时才高亮跳转行
  useEffect(() => {
    if (currentPath === filePath && result && highlightLine && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [result, highlightLine, currentPath, filePath]);

  if (!open) return null;

  const fileName = currentPath.replace(/\\/g, '/').split('/').pop() ?? currentPath;

  return (
    <Modal open={open} onClose={onClose} align="center" ariaLabel={fileName}
      panelClassName="w-[90vw] h-[80vh] select-text">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {history.length > 0 && (
              <button
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-base leading-none px-1 -ml-1 flex-shrink-0"
                onClick={goBack}
                title={t("fileViewer.back")}
              >
                ←
              </button>
            )}
            <span className="text-base font-medium text-[var(--accent)] flex-shrink-0">{fileName}</span>
            <span className="text-sm text-[var(--text-muted)] truncate">
              {currentPath}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {(isMd || isHtml) && result && !result.isBinary && !result.tooLarge && (
              <div className="flex rounded-[var(--radius-sm)] border border-[var(--border-default)] overflow-hidden text-xs">
                <button
                  className={`px-2.5 py-1 transition-colors ${preview ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                  onClick={() => setPreview(true)}
                >
                  {t("fileViewer.preview")}
                </button>
                <button
                  className={`px-2.5 py-1 transition-colors ${!preview ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                  onClick={() => setPreview(false)}
                >
                  {t("fileViewer.source")}
                </button>
              </div>
            )}
            <button
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div ref={contentRef} className="flex-1 overflow-auto bg-[var(--bg-base)]">
          {loading && (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              {t("fileViewer.loading")}
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-[var(--color-error)]">
              {error}
            </div>
          )}
          {isImg && (
            <div className="flex items-center justify-center h-full p-6">
              <img
                src={convertFileSrc(currentPath)}
                alt={fileName}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            </div>
          )}
          {!isImg && result && result.isBinary && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--text-muted)]">
              <span>{t("fileViewer.binaryNotSupported")}</span>
              <button
                className="px-4 py-1.5 text-sm rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
                onClick={() => invoke('open_path_with_default_app', { path: currentPath })}
              >
                {t("fileViewer.openWithDefaultApp")}
              </button>
            </div>
          )}
          {!isImg && result && result.tooLarge && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--text-muted)]">
              <span>{t("fileViewer.tooLarge")}</span>
              <button
                className="px-4 py-1.5 text-sm rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
                onClick={() => invoke('open_path_with_default_app', { path: currentPath })}
              >
                {t("fileViewer.openWithDefaultApp")}
              </button>
            </div>
          )}
          {!isImg && result && !result.isBinary && !result.tooLarge && isHtml && preview ? (
            <iframe
              srcDoc={htmlSrcDoc}
              title={fileName}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-same-origin"
            />
          ) : !isImg && result && !result.isBinary && !result.tooLarge && isMd && preview ? (
            <MarkdownPreview
              content={result.content}
              currentPath={currentPath}
              onNavigateLocal={navigateTo}
              contentRef={contentRef}
            />
          ) : !isImg && result && !result.isBinary && !result.tooLarge && (
            <div className="font-mono text-sm leading-6">
              {result.content.split('\n').map((line, i) => (
                <div
                  key={i}
                  ref={i + 1 === highlightLine ? highlightRef : undefined}
                  className={`flex hover:bg-[var(--border-subtle)] ${i + 1 === highlightLine ? 'bg-[var(--accent-muted)]' : ''}`}
                >
                  <span className="w-12 text-right pr-3 text-[var(--text-muted)] select-none flex-shrink-0 opacity-40">
                    {i + 1}
                  </span>
                  <span className="flex-1 whitespace-pre px-2 text-[var(--text-primary)]">
                    {line}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
    </Modal>
  );
}
