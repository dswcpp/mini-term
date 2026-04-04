import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const SHIKI_LANGUAGES = {
  bash: () => import('@shikijs/langs/bash'),
  bat: () => import('@shikijs/langs/bat'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  css: () => import('@shikijs/langs/css'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  qml: () => import('@shikijs/langs/qml'),
  rust: () => import('@shikijs/langs/rust'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const;

const SHIKI_THEMES = {
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'github-light': () => import('@shikijs/themes/github-light'),
} as const;

type SupportedShikiLanguage = keyof typeof SHIKI_LANGUAGES;
type SupportedShikiTheme = keyof typeof SHIKI_THEMES;

const shiki = createSingletonShorthands(
  createBundledHighlighter({
    langs: SHIKI_LANGUAGES,
    themes: SHIKI_THEMES,
    engine: () => createJavaScriptRegexEngine(),
  }),
);

export async function highlightCodeToHtml(source: string, language: string, theme: SupportedShikiTheme) {
  return shiki.codeToHtml(source, {
    lang: language as SupportedShikiLanguage,
    theme,
  });
}
