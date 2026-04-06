import { isValidElement, useMemo } from 'react';
import type { ReactNode } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PreviewRenderContext } from './types';
import { MermaidDiagramBlock } from './MermaidDiagramBlock';
import { resolveLocalPath, isExternalHref } from './path';

function markdownNodeToString(value: ReactNode): string {
  if (Array.isArray(value)) {
    return value.map(markdownNodeToString).join('');
  }

  if (value === null || value === undefined || typeof value === 'boolean') {
    return '';
  }

  return String(value);
}

export default function MarkdownPreviewRenderer({
  active,
  fileName,
  filePath,
  layoutMode,
  result,
}: PreviewRenderContext) {
  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href = '', children, ...props }) => {
      const localPath = resolveLocalPath(filePath, href);
      const external = isExternalHref(href);

      return (
        <a
          {...props}
          href={href}
          className="underline underline-offset-3 hover:text-[var(--text-primary)]"
          style={{
            color: 'var(--viewer-accent)',
            textDecorationColor: 'var(--viewer-accent-muted)',
          }}
          onClick={(event) => {
            if (href.startsWith('#')) {
              return;
            }

            event.preventDefault();

            if (external) {
              void openUrl(href);
              return;
            }

            if (localPath) {
              void openPath(localPath);
            }
          }}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children, ...props }) => (
      <blockquote
        {...props}
        className="my-5 border-l-2 px-4 py-3 text-[var(--text-secondary)]"
        style={{
          borderColor: 'var(--viewer-accent)',
          backgroundColor: 'var(--viewer-panel-elevated)',
        }}
      >
        {children}
      </blockquote>
    ),
    code: ({ className, children, ...props }) => {
      const source = markdownNodeToString(children).replace(/\n$/, '');

      if (className?.includes('language-mermaid')) {
        return (
          <MermaidDiagramBlock
            source={source}
            active={active}
            layoutMode={layoutMode}
            exportFileName={fileName}
          />
        );
      }

      const inline = !className;
      if (inline) {
        return (
          <code
            {...props}
            className="rounded px-1.5 py-0.5 text-[0.92em]"
            style={{
              backgroundColor: 'var(--viewer-panel-elevated)',
              color: 'var(--viewer-accent)',
              fontFamily: 'var(--viewer-code-font)',
            }}
          >
            {source}
          </code>
        );
      }

      return (
        <code
          {...props}
          className={`${className} text-[13px] text-[var(--text-primary)]`}
          style={{ fontFamily: 'var(--viewer-code-font)' }}
        >
          {source}
        </code>
      );
    },
    h1: ({ children, ...props }) => (
      <h1 {...props} className="mt-0 mb-5 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 {...props} className="mt-10 mb-4 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 {...props} className="mt-8 mb-3 text-xl font-semibold text-[var(--text-primary)]">
        {children}
      </h3>
    ),
    hr: (props) => <hr {...props} className="my-8 border-0 border-t border-[var(--border-default)]" />,
    img: ({ alt = '', src = '', ...props }) => {
      const localPath = resolveLocalPath(filePath, src);
      const resolvedSource = localPath ? convertFileSrc(localPath) : src;

      return (
        <img
          {...props}
          alt={alt}
          loading="lazy"
          src={resolvedSource}
          className="my-5 max-h-[420px] max-w-full rounded-xl border object-contain"
          style={{
            borderColor: 'var(--viewer-border)',
            backgroundColor: 'var(--viewer-panel)',
          }}
        />
      );
    },
    li: ({ children, ...props }) => (
      <li {...props} className="marker:text-[var(--accent)]">
        {children}
      </li>
    ),
    ol: ({ children, ...props }) => (
      <ol {...props} className="my-4 list-decimal space-y-2 pl-6 text-[var(--text-primary)]">
        {children}
      </ol>
    ),
    p: ({ children, ...props }) => (
      <p {...props} className="my-4 leading-7 text-[var(--text-primary)]">
        {children}
      </p>
    ),
    pre: ({ children, ...props }) => {
      const child = Array.isArray(children) ? children[0] : children;
      if (isValidElement(child) && child.type === MermaidDiagramBlock) {
        return child;
      }

      return (
        <pre
          {...props}
          className="my-5 overflow-x-auto rounded-xl border px-4 py-3"
          style={{
            borderColor: 'var(--viewer-border)',
            backgroundColor: 'var(--viewer-panel)',
          }}
        >
          {children}
        </pre>
      );
    },
    table: ({ children, ...props }) => (
      <div className="my-5 overflow-x-auto">
        <table {...props} className="min-w-full border-collapse text-left text-sm">
          {children}
        </table>
      </div>
    ),
    td: ({ children, ...props }) => (
      <td {...props} className="border border-[var(--border-default)] px-3 py-2 text-[var(--text-primary)]">
        {children}
      </td>
    ),
    th: ({ children, ...props }) => (
      <th
        {...props}
        className="border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 font-medium text-[var(--text-primary)]"
      >
        {children}
      </th>
    ),
    ul: ({ children, ...props }) => (
      <ul {...props} className="my-4 list-disc space-y-2 pl-6 text-[var(--text-primary)]">
        {children}
      </ul>
    ),
  }), [active, fileName, filePath, layoutMode]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {result.textContent ?? ''}
    </ReactMarkdown>
  );
}
