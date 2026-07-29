import type { TerminalEncoding } from '../types';

export const DEFAULT_TERMINAL_ENCODING: TerminalEncoding = 'auto';

export const TERMINAL_ENCODING_OPTIONS: ReadonlyArray<{
  value: TerminalEncoding;
  label: string;
}> = [
  { value: 'auto', label: 'Auto' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'euc-kr', label: 'EUC-KR' },
  { value: 'windows-1252', label: 'Windows-1252' },
];

const TERMINAL_ENCODING_VALUES = new Set<TerminalEncoding>(
  TERMINAL_ENCODING_OPTIONS.map((option) => option.value),
);

export function normalizeTerminalEncoding(value: string | undefined): TerminalEncoding {
  if (!value) return DEFAULT_TERMINAL_ENCODING;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'gb2312') return 'gbk';
  if (normalized === 'shift-jis' || normalized === 'sjis' || normalized === 'cp932') return 'shift_jis';
  if (normalized === 'euckr' || normalized === 'cp949') return 'euc-kr';
  if (normalized === 'cp1252') return 'windows-1252';
  return TERMINAL_ENCODING_VALUES.has(normalized as TerminalEncoding)
    ? (normalized as TerminalEncoding)
    : DEFAULT_TERMINAL_ENCODING;
}
