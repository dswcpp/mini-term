const assert = require('node:assert/strict');

const {
  DEFAULT_TERMINAL_ENCODING,
  TERMINAL_ENCODING_OPTIONS,
  normalizeTerminalEncoding,
} = require('../.tmp-tests/utils/terminalEncoding.js');

assert.equal(DEFAULT_TERMINAL_ENCODING, 'auto');
assert.deepEqual(
  TERMINAL_ENCODING_OPTIONS.map((option) => option.value),
  ['auto', 'utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'],
);
assert.equal(normalizeTerminalEncoding(undefined), 'auto');
assert.equal(normalizeTerminalEncoding('UTF8'), 'utf-8');
assert.equal(normalizeTerminalEncoding('gb2312'), 'gbk');
assert.equal(normalizeTerminalEncoding('cp932'), 'shift_jis');
assert.equal(normalizeTerminalEncoding('cp949'), 'euc-kr');
assert.equal(normalizeTerminalEncoding('unknown'), 'auto');
