import { describe, expect, it } from 'vitest';
import { resolveDocumentLanguage, summarizeDocumentLanguages } from './language';

describe('resolveDocumentLanguage', () => {
  it('detects the planned language families from file extensions', () => {
    expect(resolveDocumentLanguage('D:/code/app/main.cpp')).toMatchObject({ family: 'cpp', languageId: 'cpp', badge: 'C++' });
    expect(resolveDocumentLanguage('D:/code/app/widget.hpp')).toMatchObject({ family: 'cpp', languageId: 'cpp', badge: 'C++' });
    expect(resolveDocumentLanguage('D:/code/app/app.py')).toMatchObject({ family: 'python', languageId: 'python', badge: 'PY' });
    expect(resolveDocumentLanguage('D:/code/app/main.rs')).toMatchObject({ family: 'rust', languageId: 'rust', badge: 'RS' });
    expect(resolveDocumentLanguage('D:/code/app/server.go')).toMatchObject({ family: 'go', languageId: 'go', badge: 'GO' });
    expect(resolveDocumentLanguage('D:/code/app/MainWindow.qml')).toMatchObject({ family: 'qt', languageId: 'qml', badge: 'QT' });
    expect(resolveDocumentLanguage('D:/code/app/theme.qss')).toMatchObject({ family: 'qt', languageId: 'qss', badge: 'QT' });
    expect(resolveDocumentLanguage('D:/code/app/build.ps1')).toMatchObject({ family: 'shell', languageId: 'powershell', badge: 'SH' });
    expect(resolveDocumentLanguage('D:/code/app/config.toml')).toMatchObject({ family: 'data', languageId: 'toml', badge: 'DATA' });
    expect(resolveDocumentLanguage('D:/code/app/README.md')).toMatchObject({ family: 'docs', languageId: 'markdown', badge: 'MD' });
    expect(resolveDocumentLanguage('D:/code/app/flow.mmd')).toMatchObject({ family: 'docs', languageId: 'mermaid', badge: 'MMD' });
    expect(resolveDocumentLanguage('D:/code/app/sequence.mermaid')).toMatchObject({ family: 'docs', languageId: 'mermaid', badge: 'MMD' });
    expect(resolveDocumentLanguage('D:/code/app/diagram.svg')).toMatchObject({ family: 'image', languageId: 'svg', badge: 'SVG' });
    expect(resolveDocumentLanguage('D:/code/app/logo.png')).toMatchObject({ family: 'image', languageId: 'image', badge: 'IMG' });
    expect(resolveDocumentLanguage('D:/code/app/guide.pdf')).toMatchObject({ family: 'document', languageId: 'pdf', badge: 'PDF' });
    expect(resolveDocumentLanguage('D:/code/app/spec.docx')).toMatchObject({ family: 'document', languageId: 'docx', badge: 'DOC' });
    expect(resolveDocumentLanguage('D:/code/app/legacy.doc')).toMatchObject({ family: 'document', languageId: 'doc', badge: 'DOC' });
    expect(resolveDocumentLanguage('D:/code/app/forms/MainWindow.ui')).toMatchObject({ family: 'data', languageId: 'xml', badge: 'DATA' });
    expect(resolveDocumentLanguage('D:/code/app/project.pro')).toMatchObject({ family: 'generic', languageId: 'generic', badge: 'TXT' });
  });
});

describe('summarizeDocumentLanguages', () => {
  it('returns a single family summary when all files share one family', () => {
    expect(
      summarizeDocumentLanguages([
        'src/main.ts',
        'src/components/TabBar.tsx',
      ]),
    ).toEqual({
      family: 'web',
      badge: 'WEB',
      displayName: 'TypeScript',
    });
  });

  it('returns a mixed summary when commit files span multiple families', () => {
    expect(
      summarizeDocumentLanguages([
        'src/main.ts',
        'src-tauri/src/lib.rs',
      ]),
    ).toEqual({
      family: 'mixed',
      badge: 'MIX',
      displayName: 'Mixed Languages',
    });
  });
});
