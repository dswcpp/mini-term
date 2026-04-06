export type DocumentLanguageFamily =
  | 'cpp'
  | 'python'
  | 'rust'
  | 'go'
  | 'qt'
  | 'shell'
  | 'web'
  | 'data'
  | 'docs'
  | 'image'
  | 'document'
  | 'generic';

export type DocumentLanguageId =
  | 'c'
  | 'cpp'
  | 'python'
  | 'rust'
  | 'go'
  | 'qml'
  | 'qss'
  | 'powershell'
  | 'batch'
  | 'shell'
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'css'
  | 'html'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'markdown'
  | 'mermaid'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'generic';

export type ViewerVariant =
  | 'structured'
  | 'paper'
  | 'oxide'
  | 'clean'
  | 'desktop'
  | 'terminal'
  | 'grid'
  | 'docs'
  | 'media'
  | 'neutral';

export interface DocumentLanguageInfo {
  languageId: DocumentLanguageId;
  family: DocumentLanguageFamily;
  displayName: string;
  badge: string;
  highlighterKey: string;
  viewerVariant: ViewerVariant;
}

const GENERIC_LANGUAGE: DocumentLanguageInfo = {
  languageId: 'generic',
  family: 'generic',
  displayName: 'Plain Text',
  badge: 'TXT',
  highlighterKey: 'text',
  viewerVariant: 'neutral',
};

const LANGUAGE_BY_EXTENSION: Record<string, DocumentLanguageInfo> = {
  '.c': {
    languageId: 'c',
    family: 'cpp',
    displayName: 'C',
    badge: 'C',
    highlighterKey: 'c',
    viewerVariant: 'structured',
  },
  '.cc': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.cpp': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.cxx': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.h': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C/C++ Header',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.hh': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++ Header',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.hpp': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++ Header',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.hxx': {
    languageId: 'cpp',
    family: 'cpp',
    displayName: 'C++ Header',
    badge: 'C++',
    highlighterKey: 'cpp',
    viewerVariant: 'structured',
  },
  '.py': {
    languageId: 'python',
    family: 'python',
    displayName: 'Python',
    badge: 'PY',
    highlighterKey: 'python',
    viewerVariant: 'paper',
  },
  '.rs': {
    languageId: 'rust',
    family: 'rust',
    displayName: 'Rust',
    badge: 'RS',
    highlighterKey: 'rust',
    viewerVariant: 'oxide',
  },
  '.go': {
    languageId: 'go',
    family: 'go',
    displayName: 'Go',
    badge: 'GO',
    highlighterKey: 'go',
    viewerVariant: 'clean',
  },
  '.qml': {
    languageId: 'qml',
    family: 'qt',
    displayName: 'Qt QML',
    badge: 'QT',
    highlighterKey: 'qml',
    viewerVariant: 'desktop',
  },
  '.qss': {
    languageId: 'qss',
    family: 'qt',
    displayName: 'Qt Style Sheet',
    badge: 'QT',
    highlighterKey: 'css',
    viewerVariant: 'desktop',
  },
  '.ps1': {
    languageId: 'powershell',
    family: 'shell',
    displayName: 'PowerShell',
    badge: 'SH',
    highlighterKey: 'powershell',
    viewerVariant: 'terminal',
  },
  '.bat': {
    languageId: 'batch',
    family: 'shell',
    displayName: 'Batch',
    badge: 'SH',
    highlighterKey: 'bat',
    viewerVariant: 'terminal',
  },
  '.cmd': {
    languageId: 'batch',
    family: 'shell',
    displayName: 'Batch',
    badge: 'SH',
    highlighterKey: 'bat',
    viewerVariant: 'terminal',
  },
  '.sh': {
    languageId: 'shell',
    family: 'shell',
    displayName: 'Shell',
    badge: 'SH',
    highlighterKey: 'bash',
    viewerVariant: 'terminal',
  },
  '.bash': {
    languageId: 'shell',
    family: 'shell',
    displayName: 'Shell',
    badge: 'SH',
    highlighterKey: 'bash',
    viewerVariant: 'terminal',
  },
  '.zsh': {
    languageId: 'shell',
    family: 'shell',
    displayName: 'Shell',
    badge: 'SH',
    highlighterKey: 'bash',
    viewerVariant: 'terminal',
  },
  '.js': {
    languageId: 'javascript',
    family: 'web',
    displayName: 'JavaScript',
    badge: 'WEB',
    highlighterKey: 'javascript',
    viewerVariant: 'grid',
  },
  '.jsx': {
    languageId: 'jsx',
    family: 'web',
    displayName: 'JSX',
    badge: 'WEB',
    highlighterKey: 'jsx',
    viewerVariant: 'grid',
  },
  '.ts': {
    languageId: 'typescript',
    family: 'web',
    displayName: 'TypeScript',
    badge: 'WEB',
    highlighterKey: 'typescript',
    viewerVariant: 'grid',
  },
  '.tsx': {
    languageId: 'tsx',
    family: 'web',
    displayName: 'TSX',
    badge: 'WEB',
    highlighterKey: 'tsx',
    viewerVariant: 'grid',
  },
  '.css': {
    languageId: 'css',
    family: 'web',
    displayName: 'CSS',
    badge: 'WEB',
    highlighterKey: 'css',
    viewerVariant: 'grid',
  },
  '.html': {
    languageId: 'html',
    family: 'web',
    displayName: 'HTML',
    badge: 'WEB',
    highlighterKey: 'html',
    viewerVariant: 'grid',
  },
  '.htm': {
    languageId: 'html',
    family: 'web',
    displayName: 'HTML',
    badge: 'WEB',
    highlighterKey: 'html',
    viewerVariant: 'grid',
  },
  '.json': {
    languageId: 'json',
    family: 'data',
    displayName: 'JSON',
    badge: 'DATA',
    highlighterKey: 'json',
    viewerVariant: 'grid',
  },
  '.yaml': {
    languageId: 'yaml',
    family: 'data',
    displayName: 'YAML',
    badge: 'DATA',
    highlighterKey: 'yaml',
    viewerVariant: 'grid',
  },
  '.yml': {
    languageId: 'yaml',
    family: 'data',
    displayName: 'YAML',
    badge: 'DATA',
    highlighterKey: 'yaml',
    viewerVariant: 'grid',
  },
  '.toml': {
    languageId: 'toml',
    family: 'data',
    displayName: 'TOML',
    badge: 'DATA',
    highlighterKey: 'toml',
    viewerVariant: 'grid',
  },
  '.xml': {
    languageId: 'xml',
    family: 'data',
    displayName: 'XML',
    badge: 'DATA',
    highlighterKey: 'xml',
    viewerVariant: 'grid',
  },
  '.ui': {
    languageId: 'xml',
    family: 'data',
    displayName: 'Qt UI XML',
    badge: 'DATA',
    highlighterKey: 'xml',
    viewerVariant: 'grid',
  },
  '.md': {
    languageId: 'markdown',
    family: 'docs',
    displayName: 'Markdown',
    badge: 'MD',
    highlighterKey: 'markdown',
    viewerVariant: 'docs',
  },
  '.markdown': {
    languageId: 'markdown',
    family: 'docs',
    displayName: 'Markdown',
    badge: 'MD',
    highlighterKey: 'markdown',
    viewerVariant: 'docs',
  },
  '.mdown': {
    languageId: 'markdown',
    family: 'docs',
    displayName: 'Markdown',
    badge: 'MD',
    highlighterKey: 'markdown',
    viewerVariant: 'docs',
  },
  '.mkd': {
    languageId: 'markdown',
    family: 'docs',
    displayName: 'Markdown',
    badge: 'MD',
    highlighterKey: 'markdown',
    viewerVariant: 'docs',
  },
  '.mmd': {
    languageId: 'mermaid',
    family: 'docs',
    displayName: 'Mermaid',
    badge: 'MMD',
    highlighterKey: 'text',
    viewerVariant: 'docs',
  },
  '.mermaid': {
    languageId: 'mermaid',
    family: 'docs',
    displayName: 'Mermaid',
    badge: 'MMD',
    highlighterKey: 'text',
    viewerVariant: 'docs',
  },
  '.svg': {
    languageId: 'svg',
    family: 'image',
    displayName: 'SVG',
    badge: 'SVG',
    highlighterKey: 'xml',
    viewerVariant: 'media',
  },
  '.png': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.jpg': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.jpeg': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.gif': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.webp': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.bmp': {
    languageId: 'image',
    family: 'image',
    displayName: 'Image',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.ico': {
    languageId: 'image',
    family: 'image',
    displayName: 'Icon',
    badge: 'IMG',
    highlighterKey: 'text',
    viewerVariant: 'media',
  },
  '.pdf': {
    languageId: 'pdf',
    family: 'document',
    displayName: 'PDF',
    badge: 'PDF',
    highlighterKey: 'text',
    viewerVariant: 'docs',
  },
  '.docx': {
    languageId: 'docx',
    family: 'document',
    displayName: 'DOCX',
    badge: 'DOC',
    highlighterKey: 'text',
    viewerVariant: 'docs',
  },
  '.doc': {
    languageId: 'doc',
    family: 'document',
    displayName: 'DOC',
    badge: 'DOC',
    highlighterKey: 'text',
    viewerVariant: 'docs',
  },
};

export interface DocumentLanguageSummary {
  family: DocumentLanguageFamily | 'mixed';
  badge: string;
  displayName: string;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').trim().toLowerCase();
}

export function resolveDocumentLanguage(filePath: string): DocumentLanguageInfo {
  const normalized = normalizePath(filePath);
  const extensionMatch = /\.[^.\\/]+$/.exec(normalized);
  const extension = extensionMatch?.[0];

  if (extension && LANGUAGE_BY_EXTENSION[extension]) {
    return LANGUAGE_BY_EXTENSION[extension];
  }

  return GENERIC_LANGUAGE;
}

export function summarizeDocumentLanguages(filePaths: string[]): DocumentLanguageSummary {
  if (filePaths.length === 0) {
    return {
      family: 'generic',
      badge: GENERIC_LANGUAGE.badge,
      displayName: GENERIC_LANGUAGE.displayName,
    };
  }

  const languages = filePaths.map(resolveDocumentLanguage);
  const families = Array.from(new Set(languages.map((item) => item.family)));

  if (families.length === 1) {
    return {
      family: families[0],
      badge: languages[0].badge,
      displayName: languages[0].displayName,
    };
  }

  return {
    family: 'mixed',
    badge: 'MIX',
    displayName: 'Mixed Languages',
  };
}
