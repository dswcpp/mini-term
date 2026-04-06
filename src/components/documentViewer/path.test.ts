import { describe, expect, it } from 'vitest';
import { normalizePathSeparators, resolveLocalPath } from './path';

describe('document viewer path helpers', () => {
  it('normalizes Windows drive-letter paths for asset loading', () => {
    expect(normalizePathSeparators('D:\\\\code\\\\JavaScript\\\\mini-term\\\\docs\\\\preview.png')).toBe(
      'D:/code/JavaScript/mini-term/docs/preview.png',
    );
  });

  it('preserves UNC prefixes while collapsing duplicate separators', () => {
    expect(normalizePathSeparators('\\\\\\\\server\\\\share\\\\\\icons\\\\mini-term.ico')).toBe(
      '//server/share/icons/mini-term.ico',
    );
  });

  it('resolves local markdown asset links to normalized absolute paths', () => {
    expect(resolveLocalPath('D:\\\\code\\\\JavaScript\\\\mini-term\\\\README.md', '.\\\\assets\\\\mini-term.png')).toBe(
      'D:/code/JavaScript/mini-term/assets/mini-term.png',
    );
  });
});
